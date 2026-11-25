/**
 * DuckDbQueryExecutor - DuckDB-backed implementation of Triplex's QueryExecutor SPI.
 *
 * Compiles Datalog queries with `DuckDbDialect` and runs them against a
 * `@duckdb/node-api` `DuckDBConnection` (or any custom `SqlStatementRunner`).
 */

import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import { Effect, Layer, type Scope } from "effect";
import {
  DuckDbDialect,
  QueryExecutor,
  ReadError,
  type QueryExecutorService,
} from "@triplex-internal/core/internal";
import {
  makeSqlQueryExecutor,
  makeSqlQueryExecutorLayer,
  type SqlStatementRunner,
} from "@triplex-build/triplex-sql";

/**
 * Statement runner backed by a DuckDB connection.
 *
 * Extends `SqlStatementRunner` with `execute` for DDL/DML statements
 * (`ATTACH`, `CREATE VIEW`, `COPY ... TO ...`). Concurrent calls on the
 * same runner are serialized so a single `DuckDBConnection` never overlaps
 * in-flight statements across Effect fibers.
 */
export interface DuckDbStatementRunner extends SqlStatementRunner {
  readonly execute: (sql: string, params?: readonly unknown[]) => Effect.Effect<void, unknown>;
}

export interface DuckDbHandle {
  readonly instance: DuckDBInstance;
  readonly connection: DuckDBConnection;
  readonly runner: DuckDbStatementRunner;
}

const toDuckDbValues = (params: readonly unknown[] | undefined): DuckDBValue[] | undefined => {
  if (!params || params.length === 0) return undefined;
  return params.map((value) => (value === undefined ? null : (value as DuckDBValue)));
};

const isStatementRunner = (
  value: DuckDBConnection | SqlStatementRunner,
): value is SqlStatementRunner =>
  typeof (value as SqlStatementRunner).run === "function" &&
  typeof (value as DuckDBConnection).runAndReadAll !== "function";

/**
 * Open a scoped DuckDB instance and connection (in-memory when `path` is omitted).
 * Both the connection and instance are closed automatically when the scope ends.
 */
export const openDuckDbConnection = (
  path?: string,
  options?: Record<string, string>,
): Effect.Effect<DuckDbHandle, ReadError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const instance = await DuckDBInstance.create(path, options);
        try {
          const connection = await instance.connect();
          return {
            instance,
            connection,
            runner: makeDuckDbStatementRunner(connection),
          };
        } catch (error) {
          instance.closeSync();
          throw error;
        }
      },
      catch: (cause) =>
        new ReadError({
          message: `Failed to open DuckDB connection: ${String(cause)}`,
          cause,
        }),
    }),
    ({ instance, connection }) =>
      Effect.sync(() => {
        try {
          connection.closeSync();
        } finally {
          instance.closeSync();
        }
      }),
  );

/**
 * Wrap a `DuckDBConnection` as a fiber-safe `DuckDbStatementRunner`.
 */
export const makeDuckDbStatementRunner = (connection: DuckDBConnection): DuckDbStatementRunner => {
  // Serialize operations on a single DuckDBConnection across concurrent fibers.
  let queue: Promise<void> = Promise.resolve();

  const serialized = <A>(task: () => Promise<A>): Effect.Effect<A, unknown> =>
    Effect.tryPromise({
      try: () => {
        const next = queue.then(task, task);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
      catch: (error) => error,
    });

  return {
    run: <Row extends Record<string, unknown>>(sql: string, params: readonly unknown[]) =>
      serialized(async () => {
        const values = toDuckDbValues(params);
        const reader =
          values === undefined
            ? await connection.runAndReadAll(sql)
            : await connection.runAndReadAll(sql, values);
        try {
          return reader.getRowObjectsJS() as unknown as readonly Row[];
        } finally {
          reader.closeSync();
        }
      }),

    execute: (sql: string, params?: readonly unknown[]) =>
      serialized(async () => {
        const values = toDuckDbValues(params);
        const result =
          values === undefined ? await connection.run(sql) : await connection.run(sql, values);
        result.closeSync();
      }),
  };
};

/**
 * Construct a DuckDB-backed `QueryExecutorService` from a `DuckDBConnection`
 * or `SqlStatementRunner`.
 */
export const makeDuckDbQueryExecutor = (
  connectionOrRunner: DuckDBConnection | SqlStatementRunner,
): QueryExecutorService => {
  const runner = isStatementRunner(connectionOrRunner)
    ? connectionOrRunner
    : makeDuckDbStatementRunner(connectionOrRunner);
  return makeSqlQueryExecutor(runner, DuckDbDialect);
};

/**
 * Construct a `Layer<QueryExecutor>` backed by DuckDB.
 */
export const makeDuckDbQueryExecutorLayer = (
  connectionOrRunner: DuckDBConnection | SqlStatementRunner,
): Layer.Layer<QueryExecutor> => {
  const runner = isStatementRunner(connectionOrRunner)
    ? connectionOrRunner
    : makeDuckDbStatementRunner(connectionOrRunner);
  return makeSqlQueryExecutorLayer(runner, DuckDbDialect);
};
