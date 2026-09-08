/**
 * CloudflareAdapter - Cloudflare Durable Object implementation of StorageAdapter
 *
 * Uses Cloudflare's native storage.transactionSync() for atomic transactions
 * and storage.sql for raw SQL execution.
 *
 * This adapter provides optimal performance on Cloudflare by:
 * - Using native DO transactions (not SQL BEGIN/COMMIT)
 * - Using storage.sql.exec() for raw SQL operations
 * - Batching inserts within transactions for atomicity
 */

import { Cause, Effect, Exit, Layer } from "effect";
import {
  StorageAdapter,
  type StorageAdapterService,
  packValue,
  WriteError,
  ReadError,
  MigrationError,
  TRIPLES_TABLE_DDL,
  MIGRATIONS_TABLE_DDL,
  INDEX_DDLS,
  migrations,
} from "../adapter-support.js";
import type { TripleRow } from "@bjacobso/triplex/internal";

// =============================================================================
// Durable Object Types
// =============================================================================

// Cloudflare DO SQLite value types
export type SqlStorageValue = string | number | ArrayBuffer | null;

// Cloudflare DO SQLite returns a cursor from exec
export interface SqlStorageCursor<T> extends Iterable<T> {
  toArray(): T[];
  one(): T;
  raw<R extends SqlStorageValue[]>(): IterableIterator<R>;
  columnNames: string[];
  rowsRead: number;
  rowsWritten: number;
}

export interface SqlStorage {
  exec<T = Record<string, SqlStorageValue>>(
    query: string,
    ...params: SqlStorageValue[]
  ): SqlStorageCursor<T>;
}

class TransactionRollback extends Error {
  constructor(readonly effectCause: Cause.Cause<unknown>) {
    super("Triplex transaction effect failed");
  }
}

/**
 * Interface for Durable Object state with storage and SQL access.
 * This matches the relevant parts of DurableObjectState from cloudflare:workers.
 */
export interface DOState {
  readonly storage: {
    readonly sql: SqlStorage;
    transactionSync<T>(closure: () => T): T;
  };
}

// =============================================================================
// Cloudflare Adapter Factory
// =============================================================================

/**
 * Create a CloudflareAdapter service from a Durable Object state.
 *
 * This factory function creates a StorageAdapterService that uses Cloudflare's
 * native DO APIs for optimal performance.
 *
 * @param ctx - The DurableObjectState from the DO's constructor
 * @returns StorageAdapterService implementation
 */
export function makeCloudflareAdapter(ctx: DOState): StorageAdapterService {
  const sqlStorage = ctx.storage.sql;

  // Helper to convert cursor to array
  const cursorToArray = <T>(cursor: SqlStorageCursor<T>): T[] => {
    const results: T[] = [];
    for (const row of cursor) {
      results.push(row);
    }
    return results;
  };

  // =========================================================================
  // Transaction Support
  // =========================================================================

  /**
   * Execute operations within a transaction.
   *
   * IMPORTANT: Uses Cloudflare's native transactionSync which requires
   * synchronous execution. The effect parameter MUST be synchronous -
   * any async operations (network calls, timers) will cause failures.
   *
   * This is safe for DO SQLite operations which are all synchronous.
   *
   * @param effect - The effect to execute within the transaction. MUST be synchronous.
   */
  const withTransaction = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | WriteError> =>
    Effect.suspend<A, E | WriteError, never>(() => {
      try {
        const value = ctx.storage.transactionSync(() => {
          const exit = Effect.runSyncExit(effect);
          if (Exit.isFailure(exit)) throw new TransactionRollback(exit.cause);
          return exit.value;
        });
        return Effect.succeed(value);
      } catch (error) {
        if (error instanceof TransactionRollback) {
          return Effect.failCause(error.effectCause as Cause.Cause<E>);
        }
        return Effect.fail(
          new WriteError({
            message: `Transaction failed: ${String(error)}`,
            cause: error,
          }),
        );
      }
    });

  const nextCommitPosition: StorageAdapterService["nextCommitPosition"] = () =>
    Effect.try({
      try: () => {
        const rows = sqlStorage
          .exec<{ readonly position: number }>(
            `INSERT INTO triplex_commit_position (singleton, position)
             VALUES (1, 1)
             ON CONFLICT(singleton) DO UPDATE SET position = position + 1
             RETURNING position`,
          )
          .toArray();
        return Number(rows[0]!.position);
      },
      catch: (error) =>
        new WriteError({
          message: `Failed to allocate commit position: ${String(error)}`,
          cause: error,
        }),
    });

  const currentCommitPosition: StorageAdapterService["currentCommitPosition"] = () =>
    Effect.try({
      try: () =>
        Number(
          sqlStorage
            .exec<{ readonly position: number }>(
              "SELECT position FROM triplex_commit_position WHERE singleton = 1",
            )
            .toArray()[0]?.position ?? 0,
        ),
      catch: (error) =>
        new ReadError({
          message: `Failed to read commit position: ${String(error)}`,
          cause: error,
        }),
    });

  const dependencyState: StorageAdapterService["dependencyState"] = (attributes, basis) => {
    const unique = [...new Set(attributes)];
    if (unique.length === 0) return Effect.succeed({ sourcePosition: 0 });
    return Effect.try({
      try: () => {
        const placeholders = unique.map(() => "?").join(", ");
        const sourceParams: SqlStorageValue[] = [];
        const sourceExpression =
          basis.recordedPosition !== undefined
            ? (sourceParams.push(basis.recordedPosition, basis.recordedPosition),
              "CASE WHEN recorded_position > ? THEN 0 WHEN retracted_position IS NOT NULL AND retracted_position <= ? THEN retracted_position ELSE recorded_position END")
            : basis.recordedAt !== undefined
              ? (sourceParams.push(basis.recordedAt, basis.recordedAt),
                "CASE WHEN recorded_at > ? THEN 0 WHEN retracted_at IS NOT NULL AND retracted_at <= ? THEN retracted_position ELSE recorded_position END")
              : "CASE WHEN retracted_position IS NOT NULL THEN retracted_position ELSE recorded_position END";
        sourceParams.push(...unique);
        const source = sqlStorage
          .exec<{ readonly source_position: number | null }>(
            `SELECT MAX(${sourceExpression}) AS source_position
             FROM triples WHERE attribute IN (${placeholders})`,
            ...sourceParams,
          )
          .one();

        const boundaryParams: SqlStorageValue[] = [basis.validAt, basis.validAt, ...unique];
        const recordedVisibility =
          basis.recordedPosition !== undefined
            ? (boundaryParams.push(basis.recordedPosition, basis.recordedPosition),
              "recorded_position <= ? AND (retracted_position IS NULL OR retracted_position > ?)")
            : basis.recordedAt !== undefined
              ? (boundaryParams.push(basis.recordedAt, basis.recordedAt),
                "recorded_at <= ? AND (retracted_at IS NULL OR retracted_at > ?)")
              : "retracted_at IS NULL";
        const boundary = sqlStorage
          .exec<{ readonly next_temporal_boundary: number | null }>(
            `SELECT MIN(CASE
               WHEN valid_from > ? THEN valid_from
               WHEN valid_to > ? THEN valid_to
             END) AS next_temporal_boundary
             FROM triples
             WHERE attribute IN (${placeholders}) AND ${recordedVisibility}`,
            ...boundaryParams,
          )
          .one();
        return {
          sourcePosition: Number(source?.source_position ?? 0),
          ...(boundary?.next_temporal_boundary === null ||
          boundary?.next_temporal_boundary === undefined
            ? {}
            : { nextTemporalBoundary: Number(boundary.next_temporal_boundary) }),
        };
      },
      catch: (error) =>
        new ReadError({
          message: `Failed to read dependency state: ${String(error)}`,
          cause: error,
        }),
    });
  };

  const claimCommand: StorageAdapterService["claimCommand"] = (
    commandId,
    transactionId,
    timestamp,
  ) =>
    Effect.try({
      try: () => {
        const inserted = sqlStorage
          .exec<{ readonly transaction_id: string }>(
            `INSERT INTO triplex_command_receipts (command_id, transaction_id, recorded_at)
             VALUES (?, ?, ?)
             ON CONFLICT(command_id) DO NOTHING
             RETURNING transaction_id`,
            commandId,
            transactionId,
            timestamp,
          )
          .toArray();
        if (inserted.length > 0) return null;

        const existing = sqlStorage
          .exec<{ readonly transaction_id: string }>(
            "SELECT transaction_id FROM triplex_command_receipts WHERE command_id = ?",
            commandId,
          )
          .toArray()[0];
        if (existing === undefined) {
          throw new Error(`Command receipt ${commandId} has no original transaction`);
        }
        return existing.transaction_id;
      },
      catch: (error) =>
        new WriteError({
          message: `Failed to claim command ${commandId}: ${String(error)}`,
          cause: error,
        }),
    });

  // =========================================================================
  // Write Operations
  // =========================================================================

  const insert: StorageAdapterService["insert"] = (input, txId, timestamp, id, position) =>
    Effect.try({
      try: () => {
        const packed = packValue(input.value);

        sqlStorage.exec(
          `INSERT INTO triples (
            id, entity_id, attribute, value_type,
            value_string, value_number, value_boolean, value_datetime, value_json,
            recorded_at, recorded_position, valid_from, valid_to,
            created_by, entity_type, schema_version, tx_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          retract_tx_id: null,
          entity_type: input.entityType ?? null,
          schema_version: 1,
          tx_id: txId,
        } as TripleRow;
      },
      catch: (error) =>
        new WriteError({
          message: `Failed to insert triple: ${String(error)}`,
          cause: error,
        }),
    });

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

    return Effect.try({
      try: () => {
        const results: TripleRow[] = [];

        for (let index = 0; index < inputs.length; index++) {
          const input = inputs[index]!;
          const id = ids[index]!;
          const packed = packValue(input.value);

          sqlStorage.exec(
            `INSERT INTO triples (
                id, entity_id, attribute, value_type,
                value_string, value_number, value_boolean, value_datetime, value_json,
                recorded_at, recorded_position, valid_from, valid_to,
                created_by, entity_type, schema_version, tx_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            1,
            txId,
          );

          results.push({
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
            retract_tx_id: null,
            entity_type: input.entityType ?? null,
            schema_version: 1,
            tx_id: txId,
          } as TripleRow);
        }

        return results;
      },
      catch: (error) =>
        new WriteError({
          message: `Batch insert failed: ${String(error)}`,
          cause: error,
        }),
    });
  };

  const retract: StorageAdapterService["retract"] = (id, timestamp, txId, position) =>
    Effect.try({
      try: () => {
        const cursor = sqlStorage.exec(
          `UPDATE triples SET retracted_at = ?, retracted_position = ?, retract_tx_id = ? WHERE id = ? AND retracted_at IS NULL`,
          timestamp,
          position,
          txId,
          id,
        );
        return cursor.rowsWritten > 0;
      },
      catch: (error) =>
        new WriteError({
          message: `Failed to retract triple: ${String(error)}`,
          cause: error,
        }),
    });

  // =========================================================================
  // Read Operations
  // =========================================================================

  const getById: StorageAdapterService["getById"] = (id) =>
    Effect.try({
      try: () => {
        const cursor = sqlStorage.exec<TripleRow>(
          `SELECT * FROM triples WHERE id = ? AND retracted_at IS NULL`,
          id,
        );
        const rows = cursorToArray(cursor);
        return rows.length > 0 ? rows[0]! : null;
      },
      catch: (error) =>
        new ReadError({
          message: `Failed to get triple: ${String(error)}`,
          cause: error,
        }),
    });

  const getByEntity: StorageAdapterService["getByEntity"] = (entityId, basis) =>
    query({ entityId }, basis);

  const getByEntities: StorageAdapterService["getByEntities"] = (entityIds, basis) => {
    if (entityIds.length === 0) return Effect.succeed(new Map());
    const unique = [...new Set(entityIds)];
    return Effect.forEach(unique, (entityId) => query({ entityId }, basis)).pipe(
      Effect.map(
        (groups) =>
          new Map(unique.map((entityId, index) => [entityId, groups[index] ?? []] as const)),
      ),
    );
  };

  const query: StorageAdapterService["query"] = (pattern, basis) =>
    Effect.try({
      try: () => {
        // Build dynamic query based on pattern
        const conditions: string[] = [];
        const params: SqlStorageValue[] = [];

        if (basis?.recordedPosition !== undefined) {
          if (basis.recordedAt === undefined) {
            conditions.push(
              "recorded_position <= ?",
              "(retracted_position IS NULL OR retracted_position > ?)",
            );
            params.push(basis.recordedPosition, basis.recordedPosition);
          } else {
            conditions.push(
              "recorded_position <= ?",
              "recorded_at <= ?",
              "(retracted_position IS NULL OR retracted_position > ? OR retracted_at > ?)",
            );
            params.push(
              basis.recordedPosition,
              basis.recordedAt,
              basis.recordedPosition,
              basis.recordedAt,
            );
          }
        } else if (basis?.recordedAt === undefined) {
          conditions.push("retracted_at IS NULL");
        } else {
          conditions.push("recorded_at <= ?", "(retracted_at IS NULL OR retracted_at > ?)");
          params.push(basis.recordedAt, basis.recordedAt);
        }
        if (basis !== undefined) {
          conditions.push("valid_from <= ?", "(valid_to IS NULL OR valid_to > ?)");
          params.push(basis.validAt, basis.validAt);
        }

        if (typeof pattern.entityId === "string") {
          conditions.push(`entity_id = ?`);
          params.push(pattern.entityId);
        }

        if (typeof pattern.attribute === "string") {
          conditions.push(`attribute = ?`);
          params.push(pattern.attribute);
        }

        if (pattern.entityType) {
          conditions.push(`entity_type = ?`);
          params.push(pattern.entityType);
        }

        if (pattern.value && "type" in pattern.value) {
          const packed = packValue(pattern.value);
          conditions.push(`value_type = ?`);
          params.push(packed.value_type);

          switch (packed.value_type) {
            case "string":
            case "ref":
              conditions.push(`value_string = ?`);
              params.push(packed.value_string);
              break;
            case "number":
              conditions.push(`value_number = ?`);
              params.push(packed.value_number);
              break;
            case "boolean":
              conditions.push(`value_boolean = ?`);
              params.push(packed.value_boolean);
              break;
            case "datetime":
              conditions.push(`value_datetime = ?`);
              params.push(packed.value_datetime);
              break;
          }
        }

        const whereClause = conditions.join(" AND ");
        const cursor = sqlStorage.exec<TripleRow>(
          `SELECT * FROM triples WHERE ${whereClause}`,
          ...params,
        );
        return cursorToArray(cursor);
      },
      catch: (error) =>
        new ReadError({
          message: `Failed to query triples: ${String(error)}`,
          cause: error,
        }),
    });

  const history: StorageAdapterService["history"] = (entityId) =>
    Effect.try({
      try: () => {
        const cursor = sqlStorage.exec<TripleRow>(
          `SELECT * FROM triples WHERE entity_id = ? ORDER BY recorded_at ASC`,
          entityId,
        );
        return cursorToArray(cursor);
      },
      catch: (error) =>
        new ReadError({
          message: `Failed to get history: ${String(error)}`,
          cause: error,
        }),
    });

  const rawQuery = <T extends object>(sqlString: string, params: readonly unknown[]) =>
    Effect.try({
      try: () => {
        const cursor = sqlStorage.exec<T>(sqlString, ...(params as SqlStorageValue[]));
        return cursorToArray(cursor);
      },
      catch: (error) =>
        new ReadError({
          message: `Raw query failed: ${String(error)}`,
          cause: error,
        }),
    });

  // =========================================================================
  // Lifecycle
  // =========================================================================

  const initialize: StorageAdapterService["initialize"] = () =>
    Effect.try({
      try: () =>
        ctx.storage.transactionSync(() => {
          // Ensure base tables exist using the local Cloudflare database schema support
          sqlStorage.exec(TRIPLES_TABLE_DDL);
          sqlStorage.exec(MIGRATIONS_TABLE_DDL);

          // Run versioned migrations (same migration list as Node.js)
          const applied = new Set<number>();
          const rows = sqlStorage
            .exec<{ version: number }>(
              "SELECT version FROM triplex_schema_migrations ORDER BY version",
            )
            .toArray();
          for (const row of rows) {
            applied.add(row.version);
          }

          for (const migration of migrations) {
            if (applied.has(migration.version)) continue;
            for (const statement of migration.up) {
              sqlStorage.exec(statement);
            }
            sqlStorage.exec(
              "INSERT INTO triplex_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
              migration.version,
              migration.name,
              Date.now(),
            );
          }

          // Create indexes using the local Cloudflare database schema support
          for (const indexDef of INDEX_DDLS) {
            sqlStorage.exec(indexDef);
          }
        }),
      catch: (error) =>
        new MigrationError({
          version: 0,
          name: "cloudflare_init",
          message: `Failed to initialize storage: ${String(error)}`,
          cause: error,
        }),
    });

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
  };
}

// =============================================================================
// Layer Factory
// =============================================================================

/**
 * Create a StorageAdapter Layer from a Durable Object state.
 *
 * Usage in a Durable Object:
 * ```typescript
 * const adapterLayer = makeCloudflareAdapterLayer(ctx);
 * const triplesLayer = TriplesLive.pipe(Layer.provide(adapterLayer));
 * ```
 */
export const makeCloudflareAdapterLayer = (ctx: DOState) =>
  Layer.succeed(StorageAdapter, makeCloudflareAdapter(ctx));
