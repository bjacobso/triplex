/**
 * PostgresqlAdapter - PostgreSQL implementation of StorageAdapter
 *
 * Uses @effect/sql SqlClient for database operations with PostgreSQL-specific
 * parameter placeholders.
 */

import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  StorageAdapter,
  type StorageAdapterService,
  type TripleRow,
  CommandAlreadyCommittedError,
  TransactionConflictError,
  ConstraintViolationError,
  WriteError,
  ReadError,
  MigrationError,
  createParamCollector,
  isPatternVariable,
} from "@bjacobso/triplex/internal";
import { packValue, runMigrations } from "@bjacobso/triplex-sql";
import { PostgresqlDialect } from "./dialect.js";

/**
 * Create a PostgreSQL StorageAdapter layer.
 *
 * @returns A Layer that provides StorageAdapter, requiring SqlClient.SqlClient
 */
export interface PostgresqlAdapterConfig {
  /** Run Triplex DDL from `initialize()`. Disable when the host owns migrations. */
  readonly autoMigrate?: boolean;
}

export const makePostgresqlAdapter = (config: PostgresqlAdapterConfig = {}) =>
  Layer.effect(
    StorageAdapter,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { autoMigrate = true } = config;

      // Helper to provide SqlClient to inner effects
      const provide = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        Effect.provideService(effect, SqlClient.SqlClient, sql);

      // =========================================================================
      // Transaction Support
      // =========================================================================

      const withTransaction: StorageAdapterService["withTransaction"] = (effect) =>
        sql.withTransaction(effect).pipe(
          Effect.mapError((error) =>
            error instanceof WriteError ||
            error instanceof TransactionConflictError ||
            error instanceof CommandAlreadyCommittedError ||
            error instanceof ConstraintViolationError
              ? error
              : new WriteError({
                  message: `Transaction failed: ${String(error)}`,
                  cause: error,
                }),
          ),
        );

      const nextCommitPosition: StorageAdapterService["nextCommitPosition"] = () =>
        provide(
          sql<{ readonly position: number | string }>`
            INSERT INTO triplex_commit_position (singleton, position)
            VALUES (1, 1)
            ON CONFLICT(singleton) DO UPDATE
              SET position = triplex_commit_position.position + 1
            RETURNING position
          `.pipe(
            Effect.map((rows) => Number(rows[0]!.position)),
            Effect.mapError(
              (error) =>
                new WriteError({
                  message: `Failed to allocate commit position: ${String(error)}`,
                  cause: error,
                }),
            ),
          ),
        );

      const currentCommitPosition: StorageAdapterService["currentCommitPosition"] = () =>
        provide(
          sql<{ readonly position: number | string }>`
            SELECT position FROM triplex_commit_position WHERE singleton = 1
          `.pipe(
            Effect.map((rows) => Number(rows[0]?.position ?? 0)),
            Effect.mapError(
              (error) =>
                new ReadError({
                  message: `Failed to read commit position: ${String(error)}`,
                  cause: error,
                }),
            ),
          ),
        );

      const dependencyState: StorageAdapterService["dependencyState"] = (attributes, basis) => {
        const unique = [...new Set(attributes)];
        if (unique.length === 0) return Effect.succeed({ sourcePosition: 0 });

        const source = createParamCollector(PostgresqlDialect);
        const sourceExpression =
          basis.recordedPosition !== undefined
            ? `CASE WHEN recorded_position > ${source.add(basis.recordedPosition)} THEN 0 WHEN retracted_position IS NOT NULL AND retracted_position <= ${source.add(basis.recordedPosition)} THEN retracted_position ELSE recorded_position END`
            : basis.recordedAt !== undefined
              ? `CASE WHEN recorded_at > ${source.add(basis.recordedAt)} THEN 0 WHEN retracted_at IS NOT NULL AND retracted_at <= ${source.add(basis.recordedAt)} THEN retracted_position ELSE recorded_position END`
              : "CASE WHEN retracted_position IS NOT NULL THEN retracted_position ELSE recorded_position END";
        const sourceAttributes = unique.map((attribute) => source.add(attribute)).join(", ");

        const boundary = createParamCollector(PostgresqlDialect);
        const validFrom = boundary.add(basis.validAt);
        const validTo = boundary.add(basis.validAt);
        const boundaryAttributes = unique.map((attribute) => boundary.add(attribute)).join(", ");
        const recordedVisibility =
          basis.recordedPosition !== undefined
            ? `recorded_position <= ${boundary.add(basis.recordedPosition)} AND (retracted_position IS NULL OR retracted_position > ${boundary.add(basis.recordedPosition)})`
            : basis.recordedAt !== undefined
              ? `recorded_at <= ${boundary.add(basis.recordedAt)} AND (retracted_at IS NULL OR retracted_at > ${boundary.add(basis.recordedAt)})`
              : "retracted_at IS NULL";

        return provide(
          Effect.all([
            sql.unsafe<{ readonly source_position: number | string | null }>(
              `SELECT MAX(${sourceExpression}) AS source_position
               FROM triples WHERE attribute IN (${sourceAttributes})`,
              [...source.params],
            ),
            sql.unsafe<{ readonly next_temporal_boundary: number | string | null }>(
              `SELECT MIN(CASE
                 WHEN valid_from > ${validFrom} THEN valid_from
                 WHEN valid_to > ${validTo} THEN valid_to
               END) AS next_temporal_boundary
               FROM triples
               WHERE attribute IN (${boundaryAttributes}) AND ${recordedVisibility}`,
              [...boundary.params],
            ),
          ]).pipe(
            Effect.map(([sourceRows, boundaryRows]) => {
              const sourcePosition = Number(sourceRows[0]?.source_position ?? 0);
              const next = boundaryRows[0]?.next_temporal_boundary;
              return {
                sourcePosition,
                ...(next === null || next === undefined
                  ? {}
                  : { nextTemporalBoundary: Number(next) }),
              };
            }),
            Effect.mapError(
              (error) =>
                new ReadError({
                  message: `Failed to read dependency state: ${String(error)}`,
                  cause: error,
                }),
            ),
          ),
        );
      };

      const claimCommand: StorageAdapterService["claimCommand"] = (
        commandId,
        transactionId,
        timestamp,
      ) =>
        provide(
          Effect.gen(function* () {
            const inserted = yield* sql<{ readonly transaction_id: string }>`
              INSERT INTO triplex_command_receipts (command_id, transaction_id, recorded_at)
              VALUES (${commandId}, ${transactionId}, ${timestamp})
              ON CONFLICT(command_id) DO NOTHING
              RETURNING transaction_id
            `;
            if (inserted.length > 0) return null;

            const existing = yield* sql<{ readonly transaction_id: string }>`
              SELECT transaction_id
              FROM triplex_command_receipts
              WHERE command_id = ${commandId}
            `;
            const original = existing[0]?.transaction_id;
            if (original === undefined) {
              return yield* Effect.fail(
                new WriteError({
                  message: `Command receipt ${commandId} conflicted without an original transaction`,
                }),
              );
            }
            return original;
          }).pipe(
            Effect.mapError((error) =>
              error instanceof WriteError
                ? error
                : new WriteError({
                    message: `Failed to claim command ${commandId}: ${String(error)}`,
                    cause: error,
                  }),
            ),
          ),
        );

      // =========================================================================
      // Write Operations
      // =========================================================================

      const insert: StorageAdapterService["insert"] = (input, txId, timestamp, id, position) =>
        provide(
          Effect.gen(function* () {
            const packed = packValue(input.value);

            yield* sql`
              INSERT INTO triples (
                id, entity_id, attribute, value_type,
                value_string, value_number, value_boolean, value_datetime, value_json,
                recorded_at, recorded_position, valid_from, valid_to,
                created_by, entity_type, schema_version, tx_id
              ) VALUES (
                ${id}, ${input.entityId}, ${input.attribute}, ${packed.value_type},
                ${packed.value_string}, ${packed.value_number}, ${packed.value_boolean},
                ${packed.value_datetime}, ${packed.value_json},
                ${timestamp}, ${position}, ${input.validFrom ?? timestamp}, ${input.validTo ?? null},
                ${input.createdBy ?? null}, ${input.entityType ?? null}, ${1}, ${txId}
              )
            `.pipe(
              Effect.mapError(
                (error) =>
                  new WriteError({
                    message: `Failed to insert triple: ${String(error)}`,
                    cause: error,
                  }),
              ),
            );

            return {
              id,
              entity_id: input.entityId,
              attribute: input.attribute,
              value_type: packed.value_type,
              value_string: packed.value_string,
              value_number: packed.value_number,
              value_boolean: packed.value_boolean,
              value_datetime: packed.value_datetime,
              value_json: packed.value_json,
              recorded_at: timestamp,
              recorded_position: position,
              valid_from: input.validFrom ?? timestamp,
              valid_to: input.validTo ?? null,
              created_by: input.createdBy ?? null,
              retracted_at: null,
              retracted_position: null,
              entity_type: input.entityType ?? null,
              schema_version: 1,
              tx_id: txId,
              retract_tx_id: null,
            } as TripleRow;
          }),
        );

      const batchInsert: StorageAdapterService["batchInsert"] = (
        inputs,
        txId,
        timestamp,
        ids,
        position,
      ) => {
        if (inputs.length === 0) return Effect.succeed([]);
        if (ids.length !== inputs.length) {
          return Effect.fail(
            new WriteError({
              message: `Expected ${inputs.length} triple IDs for batch insert, got ${ids.length}`,
            }),
          );
        }

        const BATCH_SIZE = 500;

        // Pre-generate IDs and pack values upfront
        const prepared = inputs.map((input, index) => {
          const id = ids[index]!;
          const packed = packValue(input.value);
          return { id, input, packed };
        });

        return provide(
          sql.withTransaction(
            Effect.gen(function* () {
              for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
                const chunk = prepared.slice(i, i + BATCH_SIZE);
                const collector = createParamCollector(PostgresqlDialect);

                const valuesSql = chunk
                  .map(({ id, input, packed }) => {
                    const rowValues = [
                      id,
                      input.entityId,
                      input.attribute,
                      packed.value_type,
                      packed.value_string,
                      packed.value_number,
                      packed.value_boolean,
                      packed.value_datetime,
                      packed.value_json,
                      timestamp,
                      position,
                      input.validFrom ?? timestamp,
                      input.validTo ?? null,
                      input.createdBy ?? null,
                      input.entityType ?? null,
                      1, // schema_version
                      txId,
                    ];
                    return `(${rowValues.map((value) => collector.add(value)).join(", ")})`;
                  })
                  .join(", ");

                const insertSql = `
                  INSERT INTO triples (
                    id, entity_id, attribute, value_type,
                    value_string, value_number, value_boolean, value_datetime, value_json,
                    recorded_at, recorded_position, valid_from, valid_to,
                    created_by, entity_type, schema_version, tx_id
                  ) VALUES ${valuesSql}
                `;

                yield* sql.unsafe(insertSql, [...collector.params]).pipe(
                  Effect.mapError(
                    (error: unknown) =>
                      new WriteError({
                        message: `Bulk insert failed at offset ${i}: ${String(error)}`,
                        cause: error,
                      }),
                  ),
                );
              }

              return prepared.map(({ id, input, packed }) => ({
                id,
                entity_id: input.entityId,
                attribute: input.attribute,
                value_type: packed.value_type,
                value_string: packed.value_string,
                value_number: packed.value_number,
                value_boolean: packed.value_boolean,
                value_datetime: packed.value_datetime,
                value_json: packed.value_json,
                recorded_at: timestamp,
                recorded_position: position,
                valid_from: input.validFrom ?? timestamp,
                valid_to: input.validTo ?? null,
                created_by: input.createdBy ?? null,
                retracted_at: null,
                retracted_position: null,
                entity_type: input.entityType ?? null,
                schema_version: 1,
                tx_id: txId,
                retract_tx_id: null,
              })) as readonly TripleRow[];
            }),
          ),
        ).pipe(
          Effect.mapError((error) =>
            error instanceof WriteError
              ? error
              : new WriteError({
                  message: `Bulk insert failed: ${String(error)}`,
                  cause: error,
                }),
          ),
        );
      };

      const retract: StorageAdapterService["retract"] = (id, timestamp, txId, position) =>
        provide(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly id: string }>`
              UPDATE triples
              SET retracted_at = ${timestamp}, retracted_position = ${position}, retract_tx_id = ${txId}
              WHERE id = ${id} AND retracted_at IS NULL
              RETURNING id
            `.pipe(
              Effect.mapError(
                (error) =>
                  new WriteError({
                    message: `Failed to retract triple: ${String(error)}`,
                    cause: error,
                  }),
              ),
            );
            return rows.length > 0;
          }),
        );

      // =========================================================================
      // Read Operations
      // =========================================================================

      const getById: StorageAdapterService["getById"] = (id) =>
        provide(
          Effect.gen(function* () {
            const rows = yield* sql<TripleRow>`
              SELECT * FROM triples
              WHERE id = ${id} AND retracted_at IS NULL
            `.pipe(
              Effect.mapError(
                (error) =>
                  new ReadError({
                    message: `Failed to get triple: ${String(error)}`,
                    cause: error,
                  }),
              ),
            );

            return rows.length > 0 ? rows[0]! : null;
          }),
        );

      const temporalConditions = (
        basis:
          | {
              readonly recordedAt?: number;
              readonly recordedPosition?: number;
              readonly validAt: number;
            }
          | undefined,
        collector: ReturnType<typeof createParamCollector>,
      ): string[] => {
        const conditions =
          basis?.recordedPosition !== undefined
            ? basis.recordedAt === undefined
              ? [
                  `recorded_position <= ${collector.add(basis.recordedPosition)}`,
                  `(retracted_position IS NULL OR retracted_position > ${collector.add(basis.recordedPosition)})`,
                ]
              : [
                  `recorded_position <= ${collector.add(basis.recordedPosition)}`,
                  `recorded_at <= ${collector.add(basis.recordedAt)}`,
                  `(retracted_position IS NULL OR retracted_position > ${collector.add(basis.recordedPosition)} OR retracted_at > ${collector.add(basis.recordedAt)})`,
                ]
            : basis?.recordedAt === undefined
              ? ["retracted_at IS NULL"]
              : [
                  `recorded_at <= ${collector.add(basis.recordedAt)}`,
                  `(retracted_at IS NULL OR retracted_at > ${collector.add(basis.recordedAt)})`,
                ];
        if (basis !== undefined) {
          conditions.push(
            `valid_from <= ${collector.add(basis.validAt)}`,
            `(valid_to IS NULL OR valid_to > ${collector.add(basis.validAt)})`,
          );
        }
        return conditions;
      };

      const getByEntity: StorageAdapterService["getByEntity"] = (entityId, basis) =>
        query({ entityId }, basis);

      const getByEntities: StorageAdapterService["getByEntities"] = (entityIds, basis) => {
        if (entityIds.length === 0) return Effect.succeed(new Map());
        const unique = [...new Set(entityIds)];
        const collector = createParamCollector(PostgresqlDialect);
        const conditions = [
          `entity_id IN (${unique.map((id) => collector.add(id)).join(", ")})`,
          ...temporalConditions(basis, collector),
        ];
        return provide(
          sql
            .unsafe<TripleRow>(`SELECT * FROM triples WHERE ${conditions.join(" AND ")}`, [
              ...collector.params,
            ])
            .pipe(
              Effect.map((rows) => {
                const grouped = new Map<string, TripleRow[]>();
                for (const id of unique) grouped.set(id, []);
                for (const row of rows) grouped.get(row.entity_id)?.push(row);
                return grouped as ReadonlyMap<string, readonly TripleRow[]>;
              }),
              Effect.mapError(
                (error) =>
                  new ReadError({
                    message: `Failed to batch-load entities: ${String(error)}`,
                    cause: error,
                  }),
              ),
            ),
        );
      };

      const query: StorageAdapterService["query"] = (pattern, basis) =>
        provide(
          Effect.gen(function* () {
            const collector = createParamCollector(PostgresqlDialect);
            const conditions = temporalConditions(basis, collector);

            if (pattern.entityId && !isPatternVariable(pattern.entityId)) {
              conditions.push(`entity_id = ${collector.add(pattern.entityId)}`);
            }

            if (pattern.attribute && !isPatternVariable(pattern.attribute)) {
              conditions.push(`attribute = ${collector.add(pattern.attribute)}`);
            }

            if (pattern.entityType) {
              conditions.push(`entity_type = ${collector.add(pattern.entityType)}`);
            }

            if (pattern.value && !isPatternVariable(pattern.value)) {
              const packed = packValue(pattern.value);
              conditions.push(`value_type = ${collector.add(packed.value_type)}`);

              switch (packed.value_type) {
                case "string":
                case "ref":
                case "blob":
                  conditions.push(`value_string = ${collector.add(packed.value_string)}`);
                  break;
                case "number":
                  conditions.push(`value_number = ${collector.add(packed.value_number)}`);
                  break;
                case "boolean":
                  conditions.push(`value_boolean = ${collector.add(packed.value_boolean)}`);
                  break;
                case "datetime":
                  conditions.push(`value_datetime = ${collector.add(packed.value_datetime)}`);
                  break;
                case "json":
                  break;
              }
            }

            const whereClause = conditions.join(" AND ");

            const rows = yield* sql
              .unsafe<TripleRow>(`SELECT * FROM triples WHERE ${whereClause}`, [
                ...collector.params,
              ])
              .pipe(
                Effect.mapError(
                  (error) =>
                    new ReadError({
                      message: `Failed to query triples: ${String(error)}`,
                      cause: error,
                    }),
                ),
              );

            return rows;
          }),
        );

      const history: StorageAdapterService["history"] = (entityId) =>
        provide(
          Effect.gen(function* () {
            const rows = yield* sql<TripleRow>`
              SELECT * FROM triples
              WHERE entity_id = ${entityId}
              ORDER BY recorded_at ASC
            `.pipe(
              Effect.mapError(
                (error) =>
                  new ReadError({
                    message: `Failed to get history: ${String(error)}`,
                    cause: error,
                  }),
              ),
            );

            return rows;
          }),
        );

      const rawQuery = <T extends object>(sqlString: string, params: readonly unknown[]) =>
        provide(
          Effect.gen(function* () {
            // StorageAdapter raw SQL uses the portable `?` placeholder form.
            // PostgreSQL's protocol expects numbered parameters instead.
            let parameter = 0;
            const postgresqlSql = sqlString.replaceAll("?", () => `$${++parameter}`);
            const rows = yield* sql.unsafe<T>(postgresqlSql, [...params]).pipe(
              Effect.mapError(
                (error) =>
                  new ReadError({
                    message: `Raw query failed: ${String(error)}`,
                    cause: error,
                  }),
              ),
            );

            return rows as readonly T[];
          }),
        );

      // =========================================================================
      // Lifecycle
      // =========================================================================

      const initialize: StorageAdapterService["initialize"] = () =>
        autoMigrate
          ? provide(
              runMigrations.pipe(
                Effect.mapError((error) =>
                  error instanceof MigrationError
                    ? error
                    : new MigrationError({
                        version: 0,
                        name: "unknown",
                        message: `Migration failed: ${String(error)}`,
                        cause: error,
                      }),
                ),
              ),
            )
          : Effect.void;

      const close: StorageAdapterService["close"] = () => Effect.void;

      return {
        withTransaction,
        nextCommitPosition,
        currentCommitPosition,
        dependencyState,
        claimCommand,
        insert,
        batchInsert,
        retract,
        getById,
        getByEntity,
        getByEntities,
        query,
        history,
        rawQuery,
        initialize,
        close,
      } satisfies StorageAdapterService;
    }),
  );

/**
 * Default PostgreSQL adapter.
 */
export const PostgresqlAdapterLive = makePostgresqlAdapter();

/** Adapter for production hosts that execute exported migrations themselves. */
export const PostgresqlAdapterUnmigrated = makePostgresqlAdapter({ autoMigrate: false });
