/** Isolated mechanism tests, not a production invariant registry or scope API. */
import { Context, Deferred, Effect, Fiber, Layer, Redacted, Result } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { makePostgresqlLayerUnmigrated } from "@triplex-build/triplex-postgres";
import {
  PgConnectionInfo,
  PgContainerLayer,
  checkDockerAvailable,
} from "../fixtures/PgTestLayer.js";

const experiment = <A, E>(run: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* PgConnectionInfo;
        const parsed = new URL(url);
        const sql = Context.get(
          yield* Layer.build(
            makePostgresqlLayerUnmigrated({
              host: parsed.hostname,
              port: Number(parsed.port),
              database: parsed.pathname.slice(1),
              username: decodeURIComponent(parsed.username),
              password: Redacted.make(decodeURIComponent(parsed.password)),
              pool: { min: 2, max: 32 },
            }),
          ),
          SqlClient.SqlClient,
        );
        yield* sql`CREATE TABLE scope_policy(singleton INTEGER PRIMARY KEY, epoch INTEGER NOT NULL)`;
        yield* sql`INSERT INTO scope_policy VALUES(1,1)`;
        yield* sql`CREATE TABLE scope_home(version INTEGER NOT NULL)`;
        yield* sql`INSERT INTO scope_home VALUES(0)`;
        yield* sql`CREATE TABLE scope_heads(scope TEXT PRIMARY KEY, version INTEGER NOT NULL)`;
        return yield* run(sql);
      }).pipe(Effect.provide(PgContainerLayer)),
    ),
  );

// A plain snapshot read failed the stale-authority test first. A shared row
// lock makes activation exclude active writers and rejects stale native snapshots.
const policy = (sql: SqlClient.SqlClient) =>
  sql<{ epoch: number }>`SELECT epoch FROM scope_policy WHERE singleton = 1 FOR SHARE`;

const claim = (sql: SqlClient.SqlClient, scope: string, expected: number) =>
  Effect.gen(function* () {
    const rows =
      expected === 0
        ? yield* sql`INSERT INTO scope_heads(scope, version) VALUES(${scope}, 1)
        ON CONFLICT(scope) DO NOTHING RETURNING version`
        : yield* sql`UPDATE scope_heads SET version = version + 1
        WHERE scope = ${scope} AND version = ${expected} RETURNING version`;
    if (rows.length !== 1) return yield* Effect.fail("scope predecessor mismatch" as const);
  });

describe.skipIf(!checkDockerAvailable())("database-owned invariant scope investigation", () => {
  it(
    "claims successors without forks and rolls back partial multi-scope success",
    { timeout: 120000 },
    async () => {
      await experiment((sql) =>
        Effect.gen(function* () {
          yield* sql.withTransaction(claim(sql, "first", 0));
          yield* sql.withTransaction(claim(sql, "first", 1));
          expect(yield* sql`SELECT version FROM scope_heads WHERE scope = 'first'`).toEqual([
            { version: 2 },
          ]);
          const missing = yield* sql.withTransaction(claim(sql, "missing", 7)).pipe(Effect.result);
          expect(Result.isFailure(missing)).toBe(true);
          expect(yield* sql`SELECT version FROM scope_heads WHERE scope = 'missing'`).toEqual([]);
          const partial = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE scope_home SET version = 1`;
                // Sorted acquisition succeeds once, then encounters a stale predecessor.
                yield* claim(sql, "first", 2);
                yield* claim(sql, "second", 9);
              }),
            )
            .pipe(Effect.result);
          expect(Result.isFailure(partial)).toBe(true);
          expect(yield* sql`SELECT version FROM scope_heads WHERE scope = 'first'`).toEqual([
            { version: 2 },
          ]);
          expect(yield* sql`SELECT version FROM scope_home`).toEqual([{ version: 0 }]);
        }),
      );
    },
  );

  it(
    "allows 16 shared policy readers while excluding policy activation",
    { timeout: 120000 },
    async () => {
      await experiment((sql) =>
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let count = 0;
          const all = yield* Effect.forEach(
            Array.from({ length: 16 }, (_, i) => i),
            (i) =>
              sql
                .withTransaction(
                  Effect.gen(function* () {
                    yield* sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`;
                    expect(yield* policy(sql)).toEqual([{ epoch: 1 }]);
                    yield* claim(sql, `entity:${i}`, 0);
                    count++;
                    if (count === 16) yield* Deferred.succeed(ready, undefined);
                    yield* Deferred.await(release);
                  }),
                )
                .pipe(Effect.result),
            { concurrency: 16 },
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(ready);
          const activation = yield* sql
            .withTransaction(
              sql`SELECT epoch FROM scope_policy WHERE singleton = 1 FOR UPDATE NOWAIT`,
            )
            .pipe(Effect.result);
          expect(Result.isFailure(activation)).toBe(true);
          if (Result.isFailure(activation))
            expect(activation.failure).toMatchObject({ reason: { cause: { code: "55P03" } } });
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(all)).every(Result.isSuccess)).toBe(true);
          yield* sql.withTransaction(sql`UPDATE scope_policy SET epoch = 2`);
          expect(yield* sql`SELECT epoch FROM scope_policy`).toEqual([{ epoch: 2 }]);
          expect((yield* sql`SELECT scope FROM scope_heads`).length).toBe(16);
        }).pipe(Effect.timeout("20 seconds")),
      );
    },
  );

  for (const isolation of ["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"]) {
    it(
      `does not fork a previously absent mandatory scope at ${isolation}`,
      { timeout: 120000 },
      async () => {
        await experiment((sql) =>
          Effect.gen(function* () {
            const ready = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const second = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql.unsafe(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
                  yield* policy(sql);
                  yield* sql`UPDATE scope_home SET version = 1`;
                  yield* Deferred.succeed(ready, undefined);
                  yield* Deferred.await(release);
                  // Mandatory identity would be derived by the registered policy, not
                  // accepted from an optional caller list. This prototype pins one key.
                  yield* claim(sql, "registered-unique:value", 0);
                }),
              )
              .pipe(Effect.result, Effect.forkScoped);
            yield* Deferred.await(ready);
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* policy(sql);
                yield* claim(sql, "registered-unique:value", 0);
              }),
            );
            yield* Deferred.succeed(release, undefined);
            const result = yield* Fiber.join(second);
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              if (isolation === "READ COMMITTED")
                expect(result.failure).toBe("scope predecessor mismatch");
              else expect(result.failure).toMatchObject({ reason: { _tag: "SerializationError" } });
            }
            expect(yield* sql`SELECT version FROM scope_home`).toEqual([{ version: 0 }]);
            expect(yield* sql`SELECT version FROM scope_heads`).toEqual([{ version: 1 }]);
          }).pipe(Effect.timeout("15 seconds")),
        );
      },
    );
  }
  for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"]) {
    it(`rejects a stale policy authority at ${isolation}`, { timeout: 120000 }, async () => {
      await experiment((sql) =>
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const older = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql.unsafe(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
                yield* sql`SELECT version FROM scope_home`;
                yield* sql`UPDATE scope_home SET version = 1`;
                yield* Deferred.succeed(ready, undefined);
                yield* Deferred.await(release);
                return yield* policy(sql);
              }),
            )
            .pipe(Effect.result, Effect.forkScoped);
          yield* Deferred.await(ready);
          yield* sql.withTransaction(sql`UPDATE scope_policy SET epoch = 2`);
          yield* Deferred.succeed(release, undefined);
          const outcome = yield* Fiber.join(older);
          expect(Result.isFailure(outcome)).toBe(true);
          if (Result.isFailure(outcome))
            expect(outcome.failure).toMatchObject({ reason: { _tag: "SerializationError" } });
          expect(yield* sql`SELECT version FROM scope_home`).toEqual([{ version: 0 }]);
        }).pipe(Effect.timeout("15 seconds")),
      );
    });
  }
});
