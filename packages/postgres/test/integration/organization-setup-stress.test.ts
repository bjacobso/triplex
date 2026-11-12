/**
 * Stress test for concurrent organization setup on PostgreSQL.
 *
 * Each organization gets its own schema, reached through two pools (adapter and
 * query) whose connections bind `search_path` at startup. A connection that
 * opened before another pool committed the schema could resolve unqualified
 * names without it, so a migration tried to create
 * `pg_catalog.triplex_schema_migrations` and failed. In the server log of a
 * failure, the failing connection opened 36 ms before the other pool committed
 * the schema. PostgreSQL 17 marks a recomputed search path valid after an
 * invalidation that arrived during the computation, so a stale path can stick.
 *
 * The race shows up about once in several thousand creations, too rarely to
 * reproduce on demand. The first test instead checks the ordering that
 * prevents it: while schema creation is blocked, no schema-bound connection is
 * open. Before the fix, the pool's three minimum connections were.
 *
 * The second test repeats concurrent organization creation in rounds and
 * checks that closing the database manager releases every organization's
 * pools. Before the fix they leaked (192 connections after the default run).
 * Raise `PG_SETUP_STRESS_ROUNDS` and `PG_SETUP_STRESS_ORGS` to search harder,
 * for example under CPU load. Keep `orgs * 2 pools * pool.max` below the
 * server's `max_connections`.
 */

import { describe, expect, it } from "vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { DatabaseId, DatabaseManager } from "@triplex-internal/core";
import {
  DatabaseRegistry,
  IdGeneratorLive,
  RuntimeClockLive,
  TripleStoreRuntimeLayer,
} from "@triplex-internal/core/internal";
import {
  DatabaseManagerLive,
  DatabaseRegistryLive,
  StorageBackend,
} from "@triplex-build/triplex-sql";
import { databaseToSchema, makePostgresqlBackend } from "@triplex-build/triplex-postgres";
import {
  checkDockerAvailable,
  PgConnectionInfo,
  PgContainerLayer,
} from "../fixtures/PgTestLayer.js";

const DOCKER_AVAILABLE = checkDockerAvailable();
const ROUNDS = Number(process.env["PG_SETUP_STRESS_ROUNDS"] ?? 6);
const ORGS = Number(process.env["PG_SETUP_STRESS_ORGS"] ?? 8);

const backendFor = (url: string) => {
  const parsed = new URL(url);
  return makePostgresqlBackend({
    host: parsed.hostname,
    port: Number(parsed.port),
    database: parsed.pathname.slice(1),
    username: decodeURIComponent(parsed.username),
    password: Redacted.make(decodeURIComponent(parsed.password)),
    pool: { min: 2, max: 4 },
  });
};

const openConnections = (url: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ count: number }>`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
    `;
    return rows[0]!.count;
  }).pipe(
    Effect.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })),
    Effect.scoped,
  );

describe("PostgreSQL organization setup", () => {
  it.skipIf(!DOCKER_AVAILABLE)(
    "opens no schema-bound connection until the schema exists",
    { timeout: 60_000 },
    async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { url } = yield* PgConnectionInfo;
          const parsed = new URL(url);
          const backend = makePostgresqlBackend({
            host: parsed.hostname,
            port: Number(parsed.port),
            database: parsed.pathname.slice(1),
            username: decodeURIComponent(parsed.username),
            password: Redacted.make(decodeURIComponent(parsed.password)),
            pool: { min: 3, max: 4 },
          });
          const database = DatabaseId.make("org-setup-order");
          const schema = databaseToSchema(database);
          const client = (max: number) =>
            PgClient.layer({ url: Redacted.make(url), maxConnections: max });

          yield* Effect.gen(function* () {
            const storage = yield* StorageBackend;
            yield* storage.deleteDatabaseStorage(database);
          }).pipe(Effect.provide(backend));

          // Hold the schema's creation lock so setup stops at schema creation.
          const holding = yield* Deferred.make<number>();
          const release = yield* Deferred.make<void>();
          const holder = yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${schema}, 0))`;
                const [row] = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
                yield* Deferred.succeed(holding, row!.pid);
                yield* Deferred.await(release);
              }),
            );
          }).pipe(Effect.provide(client(1)), Effect.scoped, Effect.forkChild);
          const holderPid = yield* Deferred.await(holding);

          const setup = yield* Effect.gen(function* () {
            const storage = yield* StorageBackend;
            yield* Layer.build(storage.createDatabaseClient(database));
          }).pipe(Effect.provide(backend), Effect.scoped, Effect.forkChild);

          const observe = Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            // Wait until setup is blocked on the lock.
            for (let attempt = 0; ; attempt++) {
              const [waiting] = yield* sql<{ count: number }>`
                SELECT count(*)::int AS count FROM pg_locks
                WHERE locktype = 'advisory' AND NOT granted
              `;
              if (waiting!.count > 0) break;
              if (attempt > 200) return yield* Effect.die("setup never waited for the lock");
              yield* Effect.sleep("25 millis");
            }
            // Give a pool that opens eagerly time to connect.
            yield* Effect.sleep("500 millis");
            const [others] = yield* sql<{ count: number }>`
              SELECT count(*)::int AS count FROM pg_stat_activity
              WHERE datname = current_database()
                AND backend_type = 'client backend'
                AND pid NOT IN (pg_backend_pid(), ${holderPid})
            `;
            return others!.count;
          }).pipe(Effect.provide(client(1)), Effect.scoped);

          // Only the unbound connection creating the schema may be open.
          expect(yield* observe).toBe(1);

          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(holder);
          yield* Fiber.join(setup);
        }).pipe(Effect.provide(PgContainerLayer)),
      );
    },
  );

  it.skipIf(!DOCKER_AVAILABLE)(
    "creates many organizations at once and releases their pools",
    { timeout: 60_000 + ROUNDS * ORGS * 1_000 },
    async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { url } = yield* PgConnectionInfo;
          const backend = backendFor(url);
          const baseline = yield* openConnections(url);
          const failures: Array<string> = [];

          for (let round = 0; round < ROUNDS; round++) {
            yield* Effect.gen(function* () {
              const storage = yield* StorageBackend;
              yield* storage.deleteAllStorage();
            }).pipe(Effect.provide(backend));

            const registry = DatabaseRegistryLive.pipe(
              Layer.provide(backend),
              Layer.provide(RuntimeClockLive),
            );
            const manager = DatabaseManagerLive.pipe(
              Layer.provide(backend),
              Layer.provide(registry),
              Layer.provide(TripleStoreRuntimeLayer),
              Layer.provide(IdGeneratorLive),
            );
            const names = Array.from({ length: ORGS }, (_, i) => `org-stress-${i}`);
            const exit = yield* Effect.gen(function* () {
              const databases = yield* DatabaseManager;
              yield* DatabaseRegistry;
              yield* Effect.all(
                names.map((name) => databases.create(name)),
                { concurrency: "unbounded" },
              );
              const stores = yield* Effect.all(
                names.map((name) => databases.getTriples(name)),
                { concurrency: "unbounded" },
              );
              yield* Effect.all(
                stores.map((store) => store.match({})),
                { concurrency: "unbounded" },
              );
            }).pipe(Effect.provide(Layer.merge(manager, registry)), Effect.exit);
            if (Exit.isFailure(exit)) failures.push(`round ${round}: ${String(exit.cause)}`);
          }

          expect(failures).toEqual([]);
          // Every round's organization pools were closed with its manager.
          // Backends exit shortly after their clients disconnect, so allow a moment.
          let open = yield* openConnections(url);
          for (let attempt = 0; attempt < 50 && open > baseline; attempt++) {
            yield* Effect.sleep("100 millis");
            open = yield* openConnections(url);
          }
          expect(open).toBeLessThanOrEqual(baseline);
        }).pipe(Effect.provide(PgContainerLayer)),
      );
    },
  );
});
