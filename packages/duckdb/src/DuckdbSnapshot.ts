import { Clock, Context, Effect, Layer, type Scope } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import {
  ReadError,
  resolveTemporalBasis,
  type DatalogQuery,
  type ResolvedTemporalBasis,
  type TemporalBasis,
  type WrappedQuery,
} from "@bjacobso/triplex";
import {
  makeSqlQueryExecutor,
  TRIPLES_TABLE_DDL,
  type SqlStatementRunner,
} from "@bjacobso/triplex-sql";
import { DuckdbDialect } from "./dialect.js";
import type { QueryExecutorService } from "@bjacobso/triplex/internal";

export interface DuckdbSnapshotOptions {
  /** Identifies the source database in snapshot metadata. */
  readonly scope: string;
  readonly basis?: TemporalBasis;
  /** Bounds the rows transferred through JavaScript per batch. Default: 2048. */
  readonly batchSize?: number;
  /** Native execution threads. Default: 4. */
  readonly threads?: number;
}

export interface DuckdbSnapshotService {
  readonly metadata: {
    readonly scope: string;
    readonly basis: ResolvedTemporalBasis;
    readonly factCount: number;
    readonly threads: number;
    readonly importTimeMs: number;
    readonly duckdbVersion: string;
  };
  readonly queryAll: (
    query: DatalogQuery,
    debug?: boolean,
  ) => ReturnType<QueryExecutorService["execute"]>;
  readonly queryWindow: (
    query: WrappedQuery,
    debug?: boolean,
  ) => ReturnType<QueryExecutorService["executePage"]>;
}

const readFailure = (cause: unknown) =>
  new ReadError({ message: `DuckDB snapshot: ${String(cause)}`, cause });

const scalar = (value: unknown): DuckDBValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  )
    return value;
  throw new Error(`Unsupported SQL parameter: ${typeof value}`);
};

/**
 * Copy a migrated Triplex SQLite source using one SQL transaction, including
 * assertion/retraction history. The returned query service cannot mutate it.
 * Keep it inside the acquiring Effect scope so native handles remain alive.
 */
export const makeDuckdbSnapshot = (
  options: DuckdbSnapshotOptions,
): Effect.Effect<DuckdbSnapshotService, ReadError, SqlClient.SqlClient | Scope.Scope> =>
  Effect.gen(function* () {
    const source = yield* SqlClient.SqlClient;
    const batchSize = options.batchSize ?? 2048;
    const threads = options.threads ?? 4;
    if (
      !source.onDialectOrElse({ sqlite: () => true, orElse: () => false }) ||
      options.scope.trim() === "" ||
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 65_536 ||
      !Number.isSafeInteger(threads) ||
      threads < 1 ||
      threads > 64
    )
      return yield* Effect.fail(
        readFailure("Expected SQLite, a nonempty scope, batchSize 1..65536 and threads 1..64"),
      );

    const now = yield* Clock.currentTimeMillis;
    const temporal = yield* Effect.try({
      try: () => resolveTemporalBasis(options.basis, now),
      catch: readFailure,
    });
    const started = performance.now();
    const instance = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => DuckDBInstance.create(":memory:", { threads: String(threads) }),
        catch: readFailure,
      }),
      (db) => Effect.sync(() => db.closeSync()),
    );
    const connection = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => instance.connect(), catch: readFailure }),
      (conn) => Effect.sync(() => conn.closeSync()),
    );
    // Wait for native operations before scope finalizers close the connection.
    const runner: SqlStatementRunner = {
      run: <Row extends Record<string, unknown>>(sql: string, params: readonly unknown[]) =>
        Effect.tryPromise({
          try: async () => {
            const result = await connection.runAndReadAll(sql, params.map(scalar));
            return result.getRowObjects() as Row[];
          },
          catch: readFailure,
        }).pipe(Effect.uninterruptible),
    };
    yield* runner.run(TRIPLES_TABLE_DDL, []);
    const columns = yield* runner.run<{ column_name: string; column_type: string }>(
      "DESCRIBE triples",
      [],
    );
    const columnList = columns.map((column) => `"${column.column_name}"`).join(",");
    let factCount = 0;
    const recordedPosition = yield* source
      .withTransaction(
        Effect.gen(function* () {
          // This first read establishes the same SQLite snapshot for the counter
          // and every subsequent keyset batch, even if another writer commits.
          const positions = yield* source.unsafe<{ position: number }>(
            "SELECT position FROM triplex_commit_position WHERE singleton = 1",
          );
          const position = positions[0]?.position ?? 0;
          if (!Number.isSafeInteger(position) || position < 0)
            return yield* Effect.fail(readFailure("Invalid source commit position"));

          yield* Effect.scoped(
            Effect.gen(function* () {
              const appender = yield* Effect.acquireRelease(
                Effect.tryPromise({
                  try: () => connection.createAppender("triples"),
                  catch: readFailure,
                }),
                (handle) => Effect.sync(() => handle.closeSync()),
              );
              let lastId: string | undefined;
              while (true) {
                const rows = yield* source.unsafe<Record<string, unknown>>(
                  `SELECT ${columnList} FROM triples ${lastId === undefined ? "" : "WHERE id > ?1"} ORDER BY id LIMIT ${batchSize}`,
                  lastId === undefined ? [] : [lastId],
                );
                if (rows.length === 0) break;
                yield* Effect.try({
                  try: () => {
                    for (const row of rows) {
                      for (const column of columns) {
                        const value = row[column.column_name];
                        if (value === null) appender.appendNull();
                        else if (column.column_type === "BIGINT")
                          appender.appendBigInt(BigInt(value as number));
                        else if (column.column_type === "INTEGER")
                          appender.appendInteger(value as number);
                        else if (column.column_type === "DOUBLE")
                          appender.appendDouble(value as number);
                        else appender.appendVarchar(value as string);
                      }
                      appender.endRow();
                    }
                    appender.flushSync();
                  },
                  catch: readFailure,
                });
                factCount += rows.length;
                lastId = rows[rows.length - 1]!["id"] as string;
              }
            }),
          );
          return position;
        }),
      )
      .pipe(Effect.mapError(readFailure));

    yield* runner.run("ANALYZE triples", []);
    const versions = yield* runner.run<{ version: string }>("SELECT version() AS version", []);
    const basis: ResolvedTemporalBasis = Object.freeze({ ...temporal, recordedPosition });
    const executor = makeSqlQueryExecutor(runner, DuckdbDialect);
    const metadata = Object.freeze({
      scope: options.scope,
      basis,
      factCount,
      threads,
      importTimeMs: performance.now() - started,
      duckdbVersion: versions[0]!.version,
    });
    return {
      metadata,
      /** Complete materialization for trusted analytical workloads. */
      queryAll: (query: DatalogQuery, debug = false) => executor.execute(query, debug, basis),
      /** SQL result window; this POC does not issue Triples opaque cursors. */
      queryWindow: (query: WrappedQuery, debug = false) =>
        executor.executePage(query, debug, basis),
    };
  }).pipe(Effect.mapError(readFailure));

export class DuckdbSnapshot extends Context.Service<DuckdbSnapshot, DuckdbSnapshotService>()(
  "triplex/DuckdbSnapshot",
) {
  static layer(options: DuckdbSnapshotOptions) {
    return Layer.effect(DuckdbSnapshot, makeDuckdbSnapshot(options));
  }
}
