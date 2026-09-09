import { Effect } from "effect";
import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import { TRIPLES_TABLE_DDL, type SqlStatementRunner } from "@bjacobso/triplex-sql";
import { federationFailure, type FactRow } from "./types.js";

/** A private native table for one coordinator query, released with its Effect scope. */
export const makeTable = (threads: number) =>
  Effect.gen(function* () {
    const instance = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => DuckDBInstance.create(":memory:", { threads: String(threads) }),
        catch: federationFailure,
      }),
      (db) => Effect.sync(() => db.closeSync()),
    );
    const connection = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => instance.connect(), catch: federationFailure }),
      (db) => Effect.sync(() => db.closeSync()),
    );
    const runner: SqlStatementRunner = {
      run: <Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[]) =>
        Effect.tryPromise({
          try: async () =>
            (
              await connection.runAndReadAll(sql, parameters as DuckDBValue[])
            ).getRowObjects() as Row[],
          catch: federationFailure,
        }).pipe(Effect.uninterruptible),
    };
    yield* runner.run(TRIPLES_TABLE_DDL, []);
    const columns = yield* runner.run<{ column_name: string; column_type: string }>(
      "DESCRIBE triples",
      [],
    );
    const append = (rows: readonly FactRow[]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const appender = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () => connection.createAppender("triples"),
              catch: federationFailure,
            }),
            (handle) => Effect.sync(() => handle.closeSync()),
          );
          yield* Effect.try({
            try: () => {
              for (const row of rows) {
                for (const column of columns) {
                  const value = row[column.column_name];
                  if (value === null || value === undefined) appender.appendNull();
                  else if (column.column_type === "BIGINT")
                    appender.appendBigInt(BigInt(value as bigint));
                  else if (column.column_type === "INTEGER") appender.appendInteger(Number(value));
                  else if (column.column_type === "DOUBLE") appender.appendDouble(Number(value));
                  else appender.appendVarchar(String(value));
                }
                appender.endRow();
              }
              appender.flushSync();
            },
            catch: federationFailure,
          });
        }),
      ).pipe(Effect.mapError(federationFailure));
    return { runner, append };
  }).pipe(Effect.mapError(federationFailure));
