/** Synthetic protocol investigation only; never changes Triplex's allocator. */
import { Context, Deferred, Effect, Fiber, Layer, Redacted, Result } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { makePostgresqlLayerUnmigrated } from "@triplex-build/triplex-postgres";
import {
  PgConnectionInfo,
  PgContainerLayer,
  checkDockerAvailable,
} from "../fixtures/PgTestLayer.js";

const experiment = <A, E>(
  run: (writer: SqlClient.SqlClient, fresh: SqlClient.SqlClient) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* PgConnectionInfo;
        // Distinct clients have distinct fiber-local transaction services. The second
        // pool reads committed publication state, not the writer's older snapshot.
        const parsed = new URL(url);
        const config = {
          host: parsed.hostname,
          port: Number(parsed.port),
          database: parsed.pathname.slice(1),
          username: decodeURIComponent(parsed.username),
          password: Redacted.make(decodeURIComponent(parsed.password)),
          pool: { min: 2, max: 32 },
        };
        const writer = Context.get(
          yield* Layer.build(makePostgresqlLayerUnmigrated(config)),
          SqlClient.SqlClient,
        );
        const fresh = Context.get(
          yield* Layer.build(makePostgresqlLayerUnmigrated(config)),
          SqlClient.SqlClient,
        );
        yield* writer`CREATE TABLE publication_probe (position BIGINT PRIMARY KEY, owner TEXT NOT NULL,
          writer_xid xid8 NOT NULL DEFAULT pg_current_xact_id())`;
        yield* writer`CREATE VIEW publication_visible AS SELECT position, owner FROM publication_probe
          WHERE pg_current_xact_id_if_assigned() IS NULL OR writer_xid <> pg_current_xact_id_if_assigned()`;
        yield* writer`CREATE TABLE publication_home_a (version INTEGER NOT NULL)`;
        yield* writer`CREATE TABLE publication_home_b (version INTEGER NOT NULL)`;
        yield* writer`INSERT INTO publication_home_a VALUES (0)`;
        yield* writer`INSERT INTO publication_home_b VALUES (0)`;
        return yield* run(writer, fresh);
      }).pipe(Effect.provide(PgContainerLayer)),
    ),
  );

const positions = (sql: SqlClient.SqlClient) =>
  sql<{ position: string }>`SELECT position FROM publication_probe ORDER BY position`.pipe(
    Effect.map((rows) => rows.map((row) => Number(row.position))),
  );
const publish = (writer: SqlClient.SqlClient, fresh: SqlClient.SqlClient, owner: string) =>
  Effect.gen(function* () {
    // Transaction-owned lock survives finalization until native COMMIT/ROLLBACK.
    yield* writer`SELECT pg_advisory_xact_lock(728183, 1)`;
    const rows = yield* fresh<{
      head: string;
    }>`SELECT COALESCE(MAX(position), 0) AS head FROM publication_probe`;
    const next = Number(rows[0]!.head) + 1;
    yield* writer`INSERT INTO publication_probe(position, owner) VALUES (${next}, ${owner})`;
    return next;
  });

describe.skipIf(!checkDockerAvailable())("staged publication investigation", () => {
  it(
    "keeps external snapshot cuts ordered and reuses aborted publication positions",
    { timeout: 120000 },
    async () => {
      await experiment((writer, fresh) =>
        Effect.gen(function* () {
          const pinned = yield* Deferred.make<void>();
          const committed = yield* Deferred.make<void>();
          const reader = yield* fresh
            .withTransaction(
              Effect.gen(function* () {
                yield* fresh`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
                expect(yield* positions(fresh)).toEqual([]);
                yield* Deferred.succeed(pinned, undefined);
                yield* Deferred.await(committed);
                expect(yield* positions(fresh)).toEqual([]);
              }),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(pinned);
          const aborted = yield* writer
            .withTransaction(
              Effect.gen(function* () {
                expect(yield* publish(writer, fresh, "abort")).toBe(1);
                expect(yield* positions(fresh)).toEqual([]);
                const lock = yield* fresh.withTransaction(
                  fresh<{ held: boolean }>`SELECT pg_try_advisory_xact_lock(728183, 1) AS held`,
                );
                expect(lock[0]!.held).toBe(false);
                return yield* Effect.fail("deliberate rollback" as const);
              }),
            )
            .pipe(Effect.result);
          expect(Result.isFailure(aborted)).toBe(true);
          expect(yield* positions(fresh)).toEqual([]);
          expect(yield* writer.withTransaction(publish(writer, fresh, "committed-first"))).toBe(1);
          expect(yield* writer.withTransaction(publish(writer, fresh, "committed-second"))).toBe(2);
          expect(yield* positions(fresh)).toEqual([1, 2]);
          yield* Deferred.succeed(committed, undefined);
          yield* Fiber.join(reader);
        }).pipe(Effect.timeout("20 seconds")),
      );
    },
  );

  it(
    "admits disjoint synthetic writers without updating a shared MVCC row",
    { timeout: 120000 },
    async () => {
      await experiment((writer, fresh) =>
        Effect.gen(function* () {
          for (let i = 0; i < 16; i++) {
            yield* writer.unsafe(`CREATE TABLE publication_writer_${i} (version INTEGER NOT NULL)`);
            yield* writer.unsafe(`INSERT INTO publication_writer_${i} VALUES (0)`);
          }
          for (const isolation of ["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"]) {
            for (const concurrency of [1, 4, 16]) {
              yield* writer`TRUNCATE publication_probe`;
              const ready = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              let active = 0;
              const writers = yield* Effect.forEach(
                Array.from({ length: concurrency }, (_, i) => i),
                (i) =>
                  writer
                    .withTransaction(
                      Effect.gen(function* () {
                        yield* writer.unsafe(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
                        yield* writer.unsafe(`SELECT version FROM publication_writer_${i}`);
                        yield* writer.unsafe(
                          `UPDATE publication_writer_${i} SET version = version + 1`,
                        );
                        active++;
                        if (active === concurrency) yield* Deferred.succeed(ready, undefined);
                        yield* Deferred.await(release);
                        // No native queries/host callbacks after this finalizer. This is a
                        // restricted synthetic experiment, not ambient Triples composition.
                        return yield* publish(writer, fresh, String(i));
                      }),
                    )
                    .pipe(Effect.result),
                { concurrency },
              ).pipe(Effect.forkScoped);
              yield* Deferred.await(ready);
              expect(active).toBe(concurrency);
              yield* Deferred.succeed(release, undefined);
              const results = yield* Fiber.join(writers);
              expect(results.every(Result.isSuccess)).toBe(true);
              expect(yield* positions(fresh)).toEqual(
                Array.from({ length: concurrency }, (_, i) => i + 1),
              );
            }
          }
        }).pipe(Effect.timeout("30 seconds")),
      );
    },
  );
  for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"] as const) {
    it(
      `exposes the older writer's incomplete own cut at ${isolation}`,
      { timeout: 120000 },
      async () => {
        await experiment((writer, fresh) =>
          Effect.gen(function* () {
            const ready = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            let ownCut: readonly number[] = [];
            let committedOnlyCut: readonly number[] = [];
            const older = yield* writer
              .withTransaction(
                Effect.gen(function* () {
                  yield* writer.unsafe(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
                  // Establish a native snapshot without reading the publication relation.
                  yield* writer`SELECT version FROM publication_home_b`;
                  yield* writer`UPDATE publication_home_b SET version = 1`;
                  yield* Deferred.succeed(ready, undefined);
                  yield* Deferred.await(release);
                  expect(yield* publish(writer, fresh, "older")).toBe(2);
                  ownCut = yield* positions(writer);
                  committedOnlyCut = (yield* writer<{
                    position: string;
                  }>`SELECT position FROM publication_visible ORDER BY position`).map((row) =>
                    Number(row.position),
                  );
                }),
              )
              .pipe(Effect.result, Effect.forkScoped);
            yield* Deferred.await(ready);
            yield* writer.withTransaction(
              Effect.gen(function* () {
                yield* writer`UPDATE publication_home_a SET version = 1`;
                expect(yield* publish(writer, fresh, "first")).toBe(1);
                expect(yield* positions(fresh)).toEqual([]);
              }),
            );
            expect(yield* positions(fresh)).toEqual([1]);
            yield* Deferred.succeed(release, undefined);
            const result = yield* Fiber.join(older);
            expect(Result.isSuccess(result)).toBe(true);
            // The complete-cut assertion failed first. This is a counterexample,
            // not a safe production allocator: the writer sees 2 without 1.
            expect(ownCut).toEqual([2]);
            // A committed-only read surface can suppress this transaction's final
            // positions. Every fact/journal/read path would need an equivalent
            // rule, with private-table permissions; this view alone is no runtime.
            expect(committedOnlyCut).toEqual([]);
            expect(yield* positions(fresh)).toEqual([1, 2]);
            expect(
              (yield* fresh<{
                position: string;
              }>`SELECT position FROM publication_visible ORDER BY position`).map((row) =>
                Number(row.position),
              ),
            ).toEqual([1, 2]);
          }).pipe(Effect.timeout("20 seconds")),
        );
      },
    );
  }
});
