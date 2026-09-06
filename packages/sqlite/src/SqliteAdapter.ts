/**
 * SqliteAdapter - SQLite implementation of StorageAdapter
 *
 * Uses @effect/sql SqlClient for database operations.
 * Supports transactions via sql.withTransaction(), bulk inserts via
 * multi-row INSERT, and PRAGMA optimizations.
 */

import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  StorageAdapter,
  type StorageAdapterService,
  type TripleRow,
  CommandAlreadyCommittedError,
  ConstraintViolationError,
  TransactionConflictError,
  WriteError,
  ReadError,
  MigrationError,
  isPatternVariable,
} from "@bjacobso/triplex/internal";
import { packValue, runMigrations, INDEX_DDLS, INDEX_NAMES } from "@bjacobso/triplex-sql";

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configuration for SQLite adapter optimizations.
 * All thresholds are optional - undefined means "never apply this optimization".
 */
export interface SqliteAdapterConfig {
  /** Run Triplex DDL from `initialize()`. Disable when the host owns migrations. */
  readonly autoMigrate?: boolean;
  /**
   * Drop indexes for batches >= this size for faster inserts.
   * Indexes will be recreated after the batch completes.
   * Default: undefined (never drop indexes)
   */
  readonly dropIndexesThreshold?: number;

  /**
   * Enable unsafe mode (disable fsync) for batches >= this size.
   * WARNING: Data may be lost on crash. Only use for imports where
   * data can be re-imported if lost.
   * Default: undefined (never use unsafe mode)
   */
  readonly unsafeModeThreshold?: number;
}

// =============================================================================
// SQLite Adapter Factory
// =============================================================================

/**
 * Create a SQLite StorageAdapter layer with optional optimization configuration.
 *
 * @param config - Optional configuration for batch insert optimizations
 * @returns A Layer that provides StorageAdapter, requiring SqlClient.SqlClient
 *
 * @example
 * // Safe default - no optimizations
 * const adapter = makeSqliteAdapter();
 *
 * // Drop indexes for large batches (>= 100 items)
 * const adapter = makeSqliteAdapter({ dropIndexesThreshold: 100 });
 *
 * // Full performance mode (explicit opt-in to danger)
 * const adapter = makeSqliteAdapter({
 *   dropIndexesThreshold: 100,
 *   unsafeModeThreshold: 1000  // Only for very large imports
 * });
 */
export const makeSqliteAdapter = (config: SqliteAdapterConfig = {}) =>
  Layer.effect(
    StorageAdapter,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { autoMigrate = true, dropIndexesThreshold, unsafeModeThreshold } = config;

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
          sql<{ readonly position: number }>`
            INSERT INTO triplex_commit_position (singleton, position)
            VALUES (1, 1)
            ON CONFLICT(singleton) DO UPDATE SET position = position + 1
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
          sql<{ readonly position: number }>`
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
        const placeholders = unique.map(() => "?").join(", ");
        const sourceParams: unknown[] = [];
        const sourceExpression =
          basis.recordedPosition !== undefined
            ? (sourceParams.push(basis.recordedPosition, basis.recordedPosition),
              "CASE WHEN recorded_position > ? THEN 0 WHEN retracted_position IS NOT NULL AND retracted_position <= ? THEN retracted_position ELSE recorded_position END")
            : basis.recordedAt !== undefined
              ? (sourceParams.push(basis.recordedAt, basis.recordedAt),
                "CASE WHEN recorded_at > ? THEN 0 WHEN retracted_at IS NOT NULL AND retracted_at <= ? THEN retracted_position ELSE recorded_position END")
              : "CASE WHEN retracted_position IS NOT NULL THEN retracted_position ELSE recorded_position END";
        sourceParams.push(...unique);

        const boundaryParams: unknown[] = [...unique];
        const recordedVisibility =
          basis.recordedPosition !== undefined
            ? (boundaryParams.push(basis.recordedPosition, basis.recordedPosition),
              "recorded_position <= ? AND (retracted_position IS NULL OR retracted_position > ?)")
            : basis.recordedAt !== undefined
              ? (boundaryParams.push(basis.recordedAt, basis.recordedAt),
                "recorded_at <= ? AND (retracted_at IS NULL OR retracted_at > ?)")
              : "retracted_at IS NULL";
        return provide(
          Effect.all([
            sql.unsafe<{ readonly source_position: number | null }>(
              `SELECT MAX(${sourceExpression}) AS source_position
               FROM triples WHERE attribute IN (${placeholders})`,
              sourceParams,
            ),
            sql.unsafe<{ readonly next_temporal_boundary: number | null }>(
              `SELECT MIN(CASE
                 WHEN valid_from > ? THEN valid_from
                 WHEN valid_to > ? THEN valid_to
               END) AS next_temporal_boundary
               FROM triples
               WHERE attribute IN (${placeholders}) AND ${recordedVisibility}`,
              [basis.validAt, basis.validAt, ...boundaryParams],
            ),
          ]).pipe(
            Effect.map(([sourceRows, boundaryRows]) => {
              const sourcePosition = Number(sourceRows[0]?.source_position ?? 0);
              const boundary = boundaryRows[0]?.next_temporal_boundary;
              return {
                sourcePosition,
                ...(boundary === null || boundary === undefined
                  ? {}
                  : { nextTemporalBoundary: Number(boundary) }),
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

        const BATCH_SIZE = 500; // 17 columns * 500 = 8500 params (SQLite 3.32+ supports 32766)

        // Determine if optimizations should be applied based on thresholds
        const shouldDropIndexes =
          dropIndexesThreshold !== undefined && inputs.length >= dropIndexesThreshold;
        const shouldUseUnsafeMode =
          unsafeModeThreshold !== undefined && inputs.length >= unsafeModeThreshold;

        // Pre-generate IDs and pack values upfront
        const prepared = inputs.map((input, index) => {
          const id = ids[index]!;
          const packed = packValue(input.value);
          return { id, input, packed };
        });

        // Helper to create cleanup effect
        const cleanup = Effect.gen(function* () {
          // Recreate indexes if they were dropped
          if (shouldDropIndexes) {
            for (const indexDef of INDEX_DDLS) {
              yield* sql.unsafe(indexDef).pipe(Effect.ignore);
            }
          }

          // Restore safe PRAGMA settings if they were changed
          if (shouldUseUnsafeMode) {
            yield* sql.unsafe("PRAGMA synchronous = NORMAL").pipe(Effect.ignore);
            yield* sql.unsafe("PRAGMA journal_mode = WAL").pipe(Effect.ignore);
            yield* sql.unsafe("PRAGMA cache_size = -64000").pipe(Effect.ignore); // 64MB cache
          }
        });

        return provide(
          Effect.gen(function* () {
            // Apply unsafe PRAGMA settings if configured and threshold met
            if (shouldUseUnsafeMode) {
              yield* sql.unsafe("PRAGMA synchronous = OFF").pipe(Effect.ignore);
              yield* sql.unsafe("PRAGMA journal_mode = MEMORY").pipe(Effect.ignore);
              yield* sql.unsafe("PRAGMA cache_size = -128000").pipe(Effect.ignore); // 128MB cache
            }

            // Drop indexes if configured and threshold met
            if (shouldDropIndexes) {
              for (const indexName of INDEX_NAMES) {
                yield* sql.unsafe(`DROP INDEX IF EXISTS ${indexName}`).pipe(Effect.ignore);
              }
            }

            // Perform the bulk insert within a transaction
            yield* sql.withTransaction(
              Effect.gen(function* () {
                // Process in chunks to stay under parameter limit
                for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
                  const chunk = prepared.slice(i, i + BATCH_SIZE);

                  // Build VALUES clause with placeholders
                  const placeholders: string[] = [];
                  const params: unknown[] = [];

                  for (const { id, input, packed } of chunk) {
                    placeholders.push("(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
                    params.push(
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
                    );
                  }

                  const insertSql = `
                  INSERT INTO triples (
                    id, entity_id, attribute, value_type,
                    value_string, value_number, value_boolean, value_datetime, value_json,
                    recorded_at, recorded_position, valid_from, valid_to,
                    created_by, entity_type, schema_version, tx_id
                  ) VALUES ${placeholders.join(", ")}
                `;

                  yield* sql.unsafe(insertSql, params).pipe(
                    Effect.mapError(
                      (error: unknown) =>
                        new WriteError({
                          message: `Bulk insert failed at offset ${i}: ${String(error)}`,
                          cause: error,
                        }),
                    ),
                  );
                }
              }),
            );

            // Build TripleRow objects with pre-generated IDs
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
          }).pipe(Effect.ensuring(provide(cleanup))),
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
        params: unknown[],
      ): string[] => {
        if (basis === undefined) return ["retracted_at IS NULL"];
        const conditions =
          basis.recordedPosition !== undefined
            ? basis.recordedAt === undefined
              ? ["recorded_position <= ?", "(retracted_position IS NULL OR retracted_position > ?)"]
              : [
                  "recorded_position <= ?",
                  "recorded_at <= ?",
                  "(retracted_position IS NULL OR retracted_position > ? OR retracted_at > ?)",
                ]
            : basis.recordedAt === undefined
              ? ["retracted_at IS NULL"]
              : ["recorded_at <= ?", "(retracted_at IS NULL OR retracted_at > ?)"];
        if (basis.recordedPosition !== undefined) {
          if (basis.recordedAt === undefined) {
            params.push(basis.recordedPosition, basis.recordedPosition);
          } else {
            params.push(
              basis.recordedPosition,
              basis.recordedAt,
              basis.recordedPosition,
              basis.recordedAt,
            );
          }
        } else if (basis.recordedAt !== undefined) {
          params.push(basis.recordedAt, basis.recordedAt);
        }
        conditions.push("valid_from <= ?", "(valid_to IS NULL OR valid_to > ?)");
        params.push(basis.validAt, basis.validAt);
        return conditions;
      };

      const getByEntity: StorageAdapterService["getByEntity"] = (entityId, basis) =>
        query({ entityId }, basis);

      const getByEntities: StorageAdapterService["getByEntities"] = (entityIds, basis) => {
        if (entityIds.length === 0) return Effect.succeed(new Map());
        const unique = [...new Set(entityIds)];
        const params: unknown[] = [...unique];
        const conditions = [
          `entity_id IN (${unique.map(() => "?").join(", ")})`,
          ...temporalConditions(basis, params),
        ];
        return provide(
          sql
            .unsafe<TripleRow>(`SELECT * FROM triples WHERE ${conditions.join(" AND ")}`, params)
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
            // Build dynamic query based on pattern using parameterized queries
            const params: unknown[] = [];
            const conditions = temporalConditions(basis, params);

            if (pattern.entityId && !isPatternVariable(pattern.entityId)) {
              conditions.push("entity_id = ?");
              params.push(pattern.entityId);
            }

            if (pattern.attribute && !isPatternVariable(pattern.attribute)) {
              conditions.push("attribute = ?");
              params.push(pattern.attribute);
            }

            if (pattern.entityType) {
              conditions.push("entity_type = ?");
              params.push(pattern.entityType);
            }

            if (pattern.value && !isPatternVariable(pattern.value)) {
              const packed = packValue(pattern.value);
              conditions.push("value_type = ?");
              params.push(packed.value_type);

              switch (packed.value_type) {
                case "string":
                case "ref":
                  conditions.push("value_string = ?");
                  params.push(packed.value_string);
                  break;
                case "number":
                  conditions.push("value_number = ?");
                  params.push(packed.value_number);
                  break;
                case "boolean":
                  conditions.push("value_boolean = ?");
                  params.push(packed.value_boolean);
                  break;
                case "datetime":
                  conditions.push("value_datetime = ?");
                  params.push(packed.value_datetime);
                  break;
              }
            }

            const whereClause = conditions.join(" AND ");

            const rows = yield* sql
              .unsafe<TripleRow>(`SELECT * FROM triples WHERE ${whereClause}`, params)
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
            const rows = yield* sql.unsafe<T>(sqlString, [...params]).pipe(
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

      // =========================================================================
      // Return Service
      // =========================================================================

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
 * Default SQLite adapter with no optimizations enabled.
 * For bulk loading optimizations, use makeSqliteAdapter() with a config.
 */
export const SqliteAdapterLive = makeSqliteAdapter();

/** Adapter for production hosts that execute exported migrations themselves. */
export const SqliteAdapterUnmigrated = makeSqliteAdapter({ autoMigrate: false });
