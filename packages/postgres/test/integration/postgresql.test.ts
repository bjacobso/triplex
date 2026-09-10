/**
 * PostgreSQL Integration Tests
 *
 * These tests verify that the triple store and Datalog queries work correctly
 * with PostgreSQL, including proper dialect handling.
 *
 * Uses testcontainers to automatically spin up a PostgreSQL container.
 * Tests are skipped if Docker is not available.
 *
 * Run with:
 *   pnpm test --filter @triplex-build/triplex-postgres -- test/integration/postgresql.test.ts
 */

import { describe, it, expect } from "vitest";
import { Context, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  DatabaseId,
  DatabaseManager,
  EntityId,
  Triples,
  unsafe,
  string,
  number,
  ref,
} from "@triplex-build/triplex";
import { compile } from "@triplex-build/triplex/datalog";
import { ConfigNode, ConfigStore, GraphConstraint } from "@triplex-build/triplex/config";
import {
  DatabaseRegistry,
  IdGeneratorLive,
  RuntimeClockLive,
  TripleStoreRuntimeLayer,
} from "@triplex-build/triplex/internal";
import {
  DatabaseManagerLive,
  DatabaseRegistryLive,
  runMigrations,
} from "@triplex-build/triplex-sql";
import {
  databaseToSchema,
  makePostgresqlBackend,
  makePostgresqlLayerUnmigratedFromUrl,
  PgTriples,
  PostgresqlDialect,
  type PostgresqlConfig,
} from "@triplex-build/triplex-postgres";
import { makeTriplesConformanceSuite } from "@triplex-build/triplex-testkit";
import {
  PgConnectionInfo,
  PgContainerLayer,
  PgTestLayer,
  checkDockerAvailable,
} from "../fixtures/PgTestLayer.js";

// Skip all container-based tests if Docker is not available
const DOCKER_AVAILABLE = checkDockerAvailable();

const configFromUrl = (url: string): PostgresqlConfig => {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port),
    database: parsed.pathname.slice(1),
    username: decodeURIComponent(parsed.username),
    password: Redacted.make(decodeURIComponent(parsed.password)),
    pool: { min: 2, max: 4 },
  };
};

const runWithHostSql = <A, E>(effect: Effect.Effect<A, E, Triples | SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* PgConnectionInfo;
        const hostSql = makePostgresqlLayerUnmigratedFromUrl(url);
        const triplex = PgTriples.layerFromSqlClient({ scope: "host:public" }).pipe(
          Layer.provideMerge(hostSql),
        );
        return yield* Effect.gen(function* () {
          // Production hosts run this from deployment tooling; the runtime
          // layer below deliberately performs no DDL.
          yield* runMigrations;
          return yield* effect;
        }).pipe(Effect.provide(triplex));
      }).pipe(Effect.provide(PgContainerLayer)),
    ),
  );

const prepareHostTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS host_records (id TEXT PRIMARY KEY, body TEXT NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS host_outbox (id TEXT PRIMARY KEY, body TEXT NOT NULL)`;
  yield* sql`TRUNCATE host_records, host_outbox`;
});

describe("PostgreSQL Integration", () => {
  // Helper to run effects with PostgreSQL via testcontainers
  const runWithPostgres = <A, E>(effect: Effect.Effect<A, E, Triples>) =>
    Effect.runPromise(Effect.provide(effect, PgTestLayer));

  it.skipIf(!DOCKER_AVAILABLE)(
    "matches the shared temporal and query contract",
    { timeout: 120_000 },
    async () => {
      await runWithPostgres(makeTriplesConformanceSuite());
    },
  );

  describe("host-owned SqlClient composition", () => {
    it.skipIf(!DOCKER_AVAILABLE)(
      "commits host rows, Triplex facts, journal, and outbox together",
      { timeout: 120_000 },
      async () => {
        const result = await runWithHostSql(
          Effect.gen(function* () {
            yield* prepareHostTables;
            const sql = yield* SqlClient.SqlClient;
            const triples = yield* Triples;
            const entityId = EntityId.make("host:atomic:success");
            const committed = yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO host_records (id, body) VALUES ('success', 'host')`;
                const transaction = yield* triples.transact(
                  [
                    {
                      op: "assert",
                      entityId,
                      entityType: "HostRecord",
                      attribute: ":host/state",
                      value: string("committed"),
                    },
                  ],
                  { actor: "host:test", commandId: "host:atomic:success" },
                );
                yield* sql`INSERT INTO host_outbox (id, body) VALUES ('success', 'deliver')`;
                return transaction;
              }),
            );
            return {
              committed,
              host: yield* sql<{ count: number }>`SELECT COUNT(*)::int AS count FROM host_records`,
              outbox: yield* sql<{ count: number }>`SELECT COUNT(*)::int AS count FROM host_outbox`,
              facts: yield* triples.entity(entityId),
              journal: yield* triples.transaction(committed.txId),
            };
          }),
        );
        expect(result.host[0]?.count).toBe(1);
        expect(result.outbox[0]?.count).toBe(1);
        expect(result.facts).toHaveLength(1);
        expect(result.journal?.commandId).toBe("host:atomic:success");
      },
    );

    it.skipIf(!DOCKER_AVAILABLE)(
      "rolls back Triplex facts, journal, command claim, and position after a host failure",
      { timeout: 120_000 },
      async () => {
        const result = await runWithHostSql(
          Effect.gen(function* () {
            yield* prepareHostTables;
            const sql = yield* SqlClient.SqlClient;
            const triples = yield* Triples;
            const entityId = EntityId.make("host:atomic:host-failure");
            const before = yield* triples.currentPosition();
            yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql`INSERT INTO host_records (id, body) VALUES ('host-failure', 'host')`;
                  yield* triples.transact(
                    [
                      {
                        op: "assert",
                        entityId,
                        attribute: ":host/state",
                        value: string("must-roll-back"),
                      },
                    ],
                    { commandId: "host:atomic:host-failure" },
                  );
                  return yield* Effect.fail(new Error("host outbox failed"));
                }),
              )
              .pipe(Effect.flip);
            return {
              host: yield* sql<{ count: number }>`SELECT COUNT(*)::int AS count FROM host_records`,
              facts: yield* triples.entity(entityId),
              receipt: yield* triples.transactionByCommand("host:atomic:host-failure"),
              before,
              after: yield* triples.currentPosition(),
            };
          }),
        );
        expect(result.host[0]?.count).toBe(0);
        expect(result.facts).toHaveLength(0);
        expect(result.receipt).toBeNull();
        expect(result.after).toBe(result.before);
      },
    );

    it.skipIf(!DOCKER_AVAILABLE)(
      "rolls back a host write when Triplex rejects a graph constraint",
      { timeout: 120_000 },
      async () => {
        const result = await runWithHostSql(
          Effect.gen(function* () {
            yield* prepareHostTables;
            const sql = yield* SqlClient.SqlClient;
            const triples = yield* Triples;
            const entityId = EntityId.make("host:atomic:constraint-failure");
            const constraint = GraphConstraint.required("HostRecord", ":host/name");
            const failure = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql`INSERT INTO host_records (id, body) VALUES ('constraint', 'host')`;
                  yield* triples.transact(
                    [
                      {
                        op: "assert",
                        entityId,
                        entityType: "HostRecord",
                        attribute: ":host/state",
                        value: string("invalid"),
                      },
                    ],
                    { enforce: GraphConstraint.enforcement([constraint]) },
                  );
                }),
              )
              .pipe(Effect.flip);
            return {
              failure,
              host: yield* sql<{ count: number }>`SELECT COUNT(*)::int AS count FROM host_records`,
              facts: yield* triples.entity(entityId),
            };
          }),
        );
        expect(result.failure).toMatchObject({ _tag: "ConstraintViolationError" });
        expect(result.host[0]?.count).toBe(0);
        expect(result.facts).toHaveLength(0);
      },
    );

    it.skipIf(!DOCKER_AVAILABLE)(
      "keeps duplicate commands idempotent inside a host transaction",
      { timeout: 120_000 },
      async () => {
        const result = await runWithHostSql(
          Effect.gen(function* () {
            yield* prepareHostTables;
            const sql = yield* SqlClient.SqlClient;
            const triples = yield* Triples;
            const original = yield* triples.transact(
              [
                {
                  op: "assert",
                  entityId: EntityId.make("host:duplicate:original"),
                  attribute: ":host/state",
                  value: string("original"),
                },
              ],
              { commandId: "host:duplicate" },
            );
            const duplicate = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql`INSERT INTO host_records (id, body) VALUES ('duplicate', 'host')`;
                  yield* triples.transact(
                    [
                      {
                        op: "assert",
                        entityId: EntityId.make("host:duplicate:retry"),
                        attribute: ":host/state",
                        value: string("retry"),
                      },
                    ],
                    { commandId: "host:duplicate" },
                  );
                }),
              )
              .pipe(Effect.flip);
            return {
              original,
              duplicate,
              host: yield* sql<{ count: number }>`SELECT COUNT(*)::int AS count FROM host_records`,
              retry: yield* triples.entity(EntityId.make("host:duplicate:retry")),
              receipt: yield* triples.transactionByCommand("host:duplicate"),
            };
          }),
        );
        expect(result.duplicate).toMatchObject({
          _tag: "CommandAlreadyCommittedError",
          transactionId: result.original.txId,
        });
        expect(result.host[0]?.count).toBe(0);
        expect(result.retry).toHaveLength(0);
        expect(result.receipt?.txId).toBe(result.original.txId);
      },
    );

    it.skipIf(!DOCKER_AVAILABLE)(
      "uses savepoints for nested host and Triplex transactions",
      { timeout: 120_000 },
      async () => {
        const result = await runWithHostSql(
          Effect.gen(function* () {
            yield* prepareHostTables;
            const sql = yield* SqlClient.SqlClient;
            const triples = yield* Triples;
            const entityId = EntityId.make("host:nested:fact");
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO host_records (id, body) VALUES ('outer', 'kept')`;
                yield* sql
                  .withTransaction(
                    Effect.gen(function* () {
                      yield* sql`INSERT INTO host_records (id, body) VALUES ('inner', 'rolled-back')`;
                      return yield* Effect.fail(new Error("rollback inner savepoint"));
                    }),
                  )
                  .pipe(Effect.catch(() => Effect.void));
                yield* triples.transact([
                  {
                    op: "assert",
                    entityId,
                    attribute: ":host/state",
                    value: string("kept"),
                  },
                ]);
                yield* sql`INSERT INTO host_outbox (id, body) VALUES ('outer', 'kept')`;
              }),
            );
            return {
              rows: yield* sql<{ id: string }>`SELECT id FROM host_records ORDER BY id`,
              outbox: yield* sql<{ count: number }>`SELECT COUNT(*)::int AS count FROM host_outbox`,
              facts: yield* triples.entity(entityId),
            };
          }),
        );
        expect(result.rows).toEqual([{ id: "outer" }]);
        expect(result.outbox[0]?.count).toBe(1);
        expect(result.facts).toHaveLength(1);
      },
    );
  });

  it.skipIf(!DOCKER_AVAILABLE)(
    "composes isolated database-scoped SqlClient and Triples pools",
    { timeout: 120_000 },
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { url } = yield* PgConnectionInfo;
            const config = configFromUrl(url);
            const acmeId = DatabaseId.make("host-acme");
            const globexId = DatabaseId.make("host-globex");
            const [acmeContext, globexContext] = yield* Effect.all(
              [
                Layer.build(PgTriples.layerForDatabaseMigrated(config, acmeId)),
                Layer.build(PgTriples.layerForDatabaseMigrated(config, globexId)),
              ],
              { concurrency: "unbounded" },
            );
            const acmeSql = Context.get(acmeContext, SqlClient.SqlClient);
            const globexSql = Context.get(globexContext, SqlClient.SqlClient);
            const acme = Context.get(acmeContext, Triples);
            const globex = Context.get(globexContext, Triples);
            yield* Effect.all(
              [
                acmeSql`CREATE TABLE host_records (id TEXT PRIMARY KEY)`,
                globexSql`CREATE TABLE host_records (id TEXT PRIMARY KEY)`,
              ],
              { concurrency: "unbounded" },
            );
            yield* Effect.all(
              Array.from({ length: 8 }, (_, index) => {
                const side = index % 2 === 0 ? "acme" : "globex";
                const sql = side === "acme" ? acmeSql : globexSql;
                const triples = side === "acme" ? acme : globex;
                return sql.withTransaction(
                  Effect.gen(function* () {
                    yield* sql`INSERT INTO host_records (id) VALUES (${`${side}:${index}`})`;
                    yield* triples.transact([
                      {
                        op: "assert",
                        entityId: EntityId.make(`shared:entity:${index}`),
                        attribute: ":host/database",
                        value: string(side),
                      },
                    ]);
                  }),
                );
              }),
              { concurrency: "unbounded" },
            );
            const query = {
              find: ["?entity", "?database"],
              where: [["?entity", ":host/database", "?database"]],
            } as const;
            const [acmeResult, globexResult, acmeSchema, globexSchema] = yield* Effect.all([
              acme.query(query),
              globex.query(query),
              acmeSql<{ current_schema: string }>`SELECT current_schema()`,
              globexSql<{ current_schema: string }>`SELECT current_schema()`,
            ]);
            expect(acmeResult.results).toHaveLength(4);
            expect(acmeResult.results.every((row) => row["?database"] === "acme")).toBe(true);
            expect(globexResult.results).toHaveLength(4);
            expect(globexResult.results.every((row) => row["?database"] === "globex")).toBe(true);
            expect(acmeSchema[0]?.current_schema).toBe(databaseToSchema(acmeId));
            expect(globexSchema[0]?.current_schema).toBe(databaseToSchema(globexId));

            const pageRequest = {
              inner: query,
              orderBy: [{ variable: "?entity", direction: "asc" }],
              limit: 1,
            } as const;
            const acmePage = yield* acme.queryPage(pageRequest);
            const crossScope = yield* globex
              .queryPage({ ...pageRequest, cursor: acmePage.nextCursor })
              .pipe(Effect.flip);
            expect(crossScope).toMatchObject({
              _tag: "PaginationCursorError",
              reason: "scope_mismatch",
            });
            expect(
              (yield* globex.transactionsForEntity(EntityId.make("shared:entity:0"))).transactions,
            ).toHaveLength(0);
          }).pipe(Effect.provide(PgContainerLayer)),
        ),
      );
    },
  );

  it.skipIf(!DOCKER_AVAILABLE)(
    "isolates concurrent organization databases across pooled connections",
    { timeout: 120_000 },
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
            pool: { min: 2, max: 4 },
          });
          const registry = DatabaseRegistryLive.pipe(
            Layer.provide(backend),
            Layer.provide(RuntimeClockLive),
          );
          const managerLayer = DatabaseManagerLive.pipe(
            Layer.provide(backend),
            Layer.provide(registry),
            Layer.provide(TripleStoreRuntimeLayer),
            Layer.provide(IdGeneratorLive),
          );
          const applicationLayer = Layer.merge(managerLayer, registry);

          yield* Effect.gen(function* () {
            const manager = yield* DatabaseManager;
            const access = yield* DatabaseRegistry;
            yield* Effect.all([manager.create("org-acme"), manager.create("org-globex")], {
              concurrency: "unbounded",
            });

            expect(yield* access.hasAccess("stranger", "org-acme")).toBe(false);
            yield* access.grantAccess("acme-operator", "org-acme", "member");
            expect(yield* access.hasAccess("acme-operator", "org-acme")).toBe(true);
            expect(yield* access.hasAccess("acme-operator", "org-globex")).toBe(false);

            const [acme, globex] = yield* Effect.all([
              manager.getTriples("org-acme"),
              manager.getTriples("org-globex"),
            ]);
            const [acmeWrite, globexWrite] = yield* Effect.all(
              [
                acme.transact(
                  [
                    {
                      op: "assert" as const,
                      entityId: "shared:worker",
                      entityType: "Worker",
                      attribute: ":worker/name",
                      value: string("Acme worker"),
                    },
                  ],
                  { commandId: "acme-command", configSnapshot: "acme-config" },
                ),
                globex.transact(
                  [
                    {
                      op: "assert" as const,
                      entityId: "shared:worker",
                      entityType: "Worker",
                      attribute: ":worker/name",
                      value: string("Globex worker"),
                    },
                  ],
                  { commandId: "globex-command", configSnapshot: "globex-config" },
                ),
              ],
              { concurrency: "unbounded" },
            );

            const query = {
              find: ["?name"],
              where: [["?worker", ":worker/name", "?name"]],
            } as const;
            const [acmeQuery, globexQuery, acmeFeed, globexFeed] = yield* Effect.all(
              [acme.query(query), globex.query(query), acme.transactions(), globex.transactions()],
              { concurrency: "unbounded" },
            );

            expect(acmeQuery.results).toEqual([{ "?name": "Acme worker" }]);
            expect(globexQuery.results).toEqual([{ "?name": "Globex worker" }]);
            expect(acmeFeed.transactions.some((tx) => tx.commandId === "globex-command")).toBe(
              false,
            );
            expect(globexFeed.transactions.some((tx) => tx.commandId === "acme-command")).toBe(
              false,
            );

            yield* Effect.all([
              acme.assert({
                entityId: "acme:worker:second",
                entityType: "Worker",
                attribute: ":worker/name",
                value: string("Zed at Acme"),
              }),
              globex.assert({
                entityId: "globex:worker:second",
                entityType: "Worker",
                attribute: ":worker/name",
                value: string("Zed at Globex"),
              }),
            ]);
            const pageRequest = {
              inner: {
                find: ["?worker", "?name"],
                where: [["?worker", ":worker/name", "?name"]],
              },
              orderBy: [{ variable: "?name" as const, direction: "asc" as const }],
              limit: 1,
            } as const;
            const acmePage = yield* acme.queryPage(pageRequest);
            expect(acmePage.nextCursor).toBeDefined();
            const crossScope = yield* globex
              .queryPage({ ...pageRequest, cursor: acmePage.nextCursor })
              .pipe(Effect.flip);
            expect(crossScope).toMatchObject({
              _tag: "PaginationCursorError",
              reason: "scope_mismatch",
            });

            const commitConfig = (triples: typeof acme, label: string) =>
              Effect.gen(function* () {
                const node = yield* ConfigNode.make({
                  kind: "policy",
                  key: "worker-access",
                  attrs: { label },
                });
                return yield* Effect.gen(function* () {
                  const config = yield* ConfigStore.ConfigStore;
                  return yield* config.commit({ label, objects: [node], ref: "live" });
                }).pipe(
                  Effect.provide(
                    ConfigStore.layer.pipe(Layer.provide(Layer.succeed(Triples, triples))),
                  ),
                );
              });
            const [acmeConfig, globexConfig] = yield* Effect.all(
              [commitConfig(acme, "Acme live"), commitConfig(globex, "Globex live")],
              { concurrency: "unbounded" },
            );
            expect(acmeConfig.snapshot.rootCid).not.toBe(globexConfig.snapshot.rootCid);

            const acmeForeignRef = yield* acme.match({
              entityId: ConfigStore.entityId.ref("live"),
              value: ref(ConfigStore.entityId.snapshot(globexConfig.snapshot.id)),
            });
            expect(acmeForeignRef).toHaveLength(0);

            const [acmeSnapshots, globexSnapshots] = yield* Effect.all([
              manager.getSnapshotService("org-acme"),
              manager.getSnapshotService("org-globex"),
            ]);
            const [acmeSnapshot, globexSnapshot] = yield* Effect.all([
              acmeSnapshots!.at("shared:worker", acmeWrite.txId),
              globexSnapshots!.at("shared:worker", globexWrite.txId),
            ]);
            expect(acmeSnapshot?.attributes[":worker/name"]).toEqual({
              type: "string",
              value: "Acme worker",
            });
            expect(globexSnapshot?.attributes[":worker/name"]).toEqual({
              type: "string",
              value: "Globex worker",
            });

            yield* Effect.all([manager.delete("org-acme"), manager.delete("org-globex")]);
          }).pipe(Effect.provide(applicationLayer));
        }).pipe(Effect.provide(PgContainerLayer)),
      );
    },
  );

  it("rejects crafted database identifiers", () => {
    expect(() => unsafe.databaseId("public")).not.toThrow();
    expect(() => unsafe.databaseId("public;drop-schema-public")).toThrow();
    expect(() => unsafe.databaseId("triplex_system")).toThrow();
    expect(() => unsafe.databaseId("../other")).toThrow();
  });

  describe("basic operations (requires Docker)", () => {
    it.skipIf(!DOCKER_AVAILABLE)(
      "should create and retrieve a triple",
      { timeout: 60_000 },
      async () => {
        const result = await runWithPostgres(
          Effect.gen(function* () {
            const store = yield* Triples;

            const triple = yield* store.assert({
              entityId: "pg-test-1",
              attribute: ":name",
              value: string("PostgreSQL Test"),
              entityType: "test",
            });

            const retrieved = yield* store.get(triple.id);
            yield* store.retract(triple.id);

            return { triple, retrieved };
          }),
        );

        expect(result.triple.entityId).toBe("pg-test-1");
        expect(result.retrieved?.entityId).toBe("pg-test-1");
      },
    );

    it.skipIf(!DOCKER_AVAILABLE)("should query triples", { timeout: 60_000 }, async () => {
      const result = await runWithPostgres(
        Effect.gen(function* () {
          const store = yield* Triples;

          const t1 = yield* store.assert({
            entityId: "pg-query-1",
            attribute: ":name",
            value: string("Alice"),
            entityType: "person",
          });
          const t2 = yield* store.assert({
            entityId: "pg-query-1",
            attribute: ":age",
            value: number(30),
          });
          const t3 = yield* store.assert({
            entityId: "pg-query-2",
            attribute: ":name",
            value: string("Bob"),
            entityType: "person",
          });

          const entity = yield* store.entity("pg-query-1" as any);

          yield* store.retract(t1.id);
          yield* store.retract(t2.id);
          yield* store.retract(t3.id);

          return { entity };
        }),
      );

      expect(result.entity.length).toBe(2);
    });
  });

  describe("Datalog queries (requires Docker)", () => {
    it.skipIf(!DOCKER_AVAILABLE)(
      "should execute a Datalog query with PostgreSQL dialect",
      { timeout: 60_000 },
      async () => {
        const result = await runWithPostgres(
          Effect.gen(function* () {
            const store = yield* Triples;
            const datalog = yield* Triples;

            const triples = yield* Effect.all([
              store.assert({
                entityId: "pg-dl-1",
                attribute: ":person/name",
                value: string("Alice"),
              }),
              store.assert({ entityId: "pg-dl-1", attribute: ":person/age", value: number(30) }),
              store.assert({
                entityId: "pg-dl-2",
                attribute: ":person/name",
                value: string("Bob"),
              }),
              store.assert({ entityId: "pg-dl-2", attribute: ":person/age", value: number(25) }),
            ]);

            const queryResult = yield* datalog.query({
              find: ["?name", "?age"],
              where: [
                ["?person", ":person/name", "?name"],
                ["?person", ":person/age", "?age"],
              ],
            });

            yield* Effect.all(triples.map((t) => store.retract(t.id)));
            return queryResult;
          }),
        );

        expect(result.results.length).toBe(2);
        const names = result.results.map((r: Record<string, unknown>) => r["?name"]);
        expect(names).toContain("Alice");
        expect(names).toContain("Bob");
      },
    );

    it.skipIf(!DOCKER_AVAILABLE)(
      "should execute a Datalog query with predicate filter",
      { timeout: 60_000 },
      async () => {
        const result = await runWithPostgres(
          Effect.gen(function* () {
            const store = yield* Triples;
            const datalog = yield* Triples;

            const triples = yield* Effect.all([
              store.assert({
                entityId: "pg-pred-1",
                attribute: ":employee/name",
                value: string("Senior"),
              }),
              store.assert({
                entityId: "pg-pred-1",
                attribute: ":employee/age",
                value: number(45),
              }),
              store.assert({
                entityId: "pg-pred-2",
                attribute: ":employee/name",
                value: string("Junior"),
              }),
              store.assert({
                entityId: "pg-pred-2",
                attribute: ":employee/age",
                value: number(22),
              }),
            ]);

            const queryResult = yield* datalog.query({
              find: ["?name"],
              where: [
                ["?e", ":employee/name", "?name"],
                ["?e", ":employee/age", "?age"],
                [">=", "?age", 30],
              ],
            });

            yield* Effect.all(triples.map((t) => store.retract(t.id)));
            return queryResult;
          }),
        );

        expect(result.results.length).toBe(1);
        expect((result.results[0] as Record<string, unknown>)["?name"]).toBe("Senior");
      },
    );

    it.skipIf(!DOCKER_AVAILABLE)(
      "should execute explain and report postgresql backend",
      { timeout: 60_000 },
      async () => {
        const result = await runWithPostgres(
          Effect.gen(function* () {
            const datalog = yield* Triples;

            const explained = yield* datalog.explain({
              find: ["?name"],
              where: [["?p", ":name", "?name"]],
            });

            return explained;
          }),
        );

        expect(result.queryPlan.backend).toBe("postgresql");
      },
    );

    it.skipIf(!DOCKER_AVAILABLE)(
      "should execute a join query across entities",
      { timeout: 60_000 },
      async () => {
        const result = await runWithPostgres(
          Effect.gen(function* () {
            const store = yield* Triples;
            const datalog = yield* Triples;

            const triples = yield* Effect.all([
              store.assert({
                entityId: "pg-dept-1",
                attribute: ":department/name",
                value: string("Engineering"),
              }),
              store.assert({
                entityId: "pg-emp-1",
                attribute: ":employee/name",
                value: string("Alice"),
              }),
              store.assert({
                entityId: "pg-emp-1",
                attribute: ":employee/department",
                value: ref("pg-dept-1"),
              }),
            ]);

            const queryResult = yield* datalog.query({
              find: ["?empName", "?deptName"],
              where: [
                ["?emp", ":employee/name", "?empName"],
                ["?emp", ":employee/department", "?dept"],
                ["?dept", ":department/name", "?deptName"],
              ],
            });

            yield* Effect.all(triples.map((t) => store.retract(t.id)));
            return queryResult;
          }),
        );

        expect(result.results.length).toBe(1);
        expect((result.results[0] as Record<string, unknown>)["?empName"]).toBe("Alice");
        expect((result.results[0] as Record<string, unknown>)["?deptName"]).toBe("Engineering");
      },
    );
  });

  describe("dialect-specific SQL", () => {
    it("should generate PostgreSQL-compatible LIMIT/OFFSET", () => {
      const query = {
        find: ["?name"],
        where: [["?person", ":name", "?name"]],
        offset: 10,
      } as const;

      const { sql } = compile(query, PostgresqlDialect);

      expect(sql).not.toContain("LIMIT -1");
      expect(sql).toContain("OFFSET 10");
    });

    it("should generate SQLite-compatible LIMIT/OFFSET by default", () => {
      const query = {
        find: ["?name"],
        where: [["?person", ":name", "?name"]],
        offset: 10,
      } as const;

      const { sql } = compile(query);

      expect(sql).toContain("LIMIT -1");
      expect(sql).toContain("OFFSET 10");
    });

    it("should use $1, $2 parameters for PostgreSQL", () => {
      const query = {
        find: ["?name"],
        where: [
          ["?person", ":person/name", "?name"],
          ["?person", ":person/age", 30],
        ],
      } as const;

      const { sql } = compile(query, PostgresqlDialect);

      expect(sql).toMatch(/\$\d+/);
      expect(sql).not.toMatch(/\?(?!\w)/);
    });
  });
});
