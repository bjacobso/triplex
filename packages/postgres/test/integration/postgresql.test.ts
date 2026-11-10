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

import { numericIndexPlan } from "../../../../test/fixtures/numeric-index.js";
import { positionIndexPlan } from "../../../../test/fixtures/position-index.js";
import { describe, it, expect } from "vitest";
import { Context, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
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
  migrations,
} from "@triplex-build/triplex-sql";
import {
  databaseToSchema,
  makePostgresqlBackend,
  makePostgresqlLayerUnmigratedFromUrl,
  PgTriples,
  PostgresqlDialect,
  type PostgresqlConfig,
} from "@triplex-build/triplex-postgres";
import {
  findPlaintext,
  makeSealedStorageSuite,
  makeSensitiveConformanceSuite,
  makeTriplesConformanceSuite,
  sensitiveConformanceLayer,
} from "@triplex-build/triplex-testkit";
import { postgresSchemaLayer } from "@triplex-build/triplex-testkit/postgres";
import {
  PgConnectionInfo,
  PgContainerLayer,
  PgTestLayer,
  checkDockerAvailable,
} from "../fixtures/PgTestLayer.js";

// Skip all container-based tests if Docker is not available
const DOCKER_AVAILABLE = checkDockerAvailable();
const EXPECTED_SCHEMA_VERSION = Math.max(...migrations.map(({ version }) => version));

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
          return yield* effect.pipe(Effect.provide(triplex));
        }).pipe(Effect.provide(hostSql));
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
  it.skipIf(!DOCKER_AVAILABLE)(
    "types outer-commit conflicts after the nested Triplex call returns",
    { timeout: 120_000 },
    async () => {
      await runWithHostSql(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const triples = yield* Triples;
          yield* prepareHostTables;
          yield* sql.unsafe(`CREATE FUNCTION reject_outer_commit() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'planted commit conflict' USING ERRCODE = '40001'; END;
        $$ LANGUAGE plpgsql`);
          yield* sql.unsafe(`CREATE CONSTRAINT TRIGGER reject_outer_commit AFTER INSERT ON host_records
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_outer_commit()`);
          let nestedReturned = false;
          const error = yield* PgTriples.withTransaction(
            Effect.gen(function* () {
              yield* triples.transact(
                [
                  {
                    op: "assert",
                    entityId: EntityId.make("conflict:outer"),
                    attribute: ":name",
                    value: string("rolled back"),
                  },
                ],
                { commandId: "conflict:outer" },
              );
              nestedReturned = true;
              yield* sql`INSERT INTO host_records VALUES ('outer', 'rolled back')`;
            }),
          ).pipe(Effect.flip);
          expect(nestedReturned).toBe(true);
          expect(error).toMatchObject({
            _tag: "TransactionConflictError",
            reason: "serialization",
            isRetryable: true,
          });
          expect(yield* triples.entity(EntityId.make("conflict:outer"))).toEqual([]);
          expect(yield* triples.currentPosition()).toBe(0);
          expect(yield* triples.transactionByCommand("conflict:outer")).toBeNull();
          expect(yield* sql`SELECT * FROM host_records`).toEqual([]);
          yield* sql`DROP TRIGGER reject_outer_commit ON host_records`;
          yield* sql`DROP FUNCTION reject_outer_commit()`;

          const syntax = yield* PgTriples.withTransaction(sql.unsafe("SELECT FROM")).pipe(
            Effect.flip,
          );
          expect(syntax).toMatchObject({ _tag: "SqlError", reason: { _tag: "SqlSyntaxError" } });
          const domain = new Error("host domain failure");
          expect(yield* PgTriples.withTransaction(Effect.fail(domain)).pipe(Effect.flip)).toBe(
            domain,
          );
        }),
      );
    },
  );
  it.skipIf(!DOCKER_AVAILABLE)(
    "surfaces SQL transaction conflicts without partial writes",
    { timeout: 120_000 },
    async () => {
      await runWithHostSql(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const triples = yield* Triples;
          for (const [code, reason] of [
            ["40001", "serialization"],
            ["40P01", "deadlock"],
          ] as const) {
            // Exercise the driver's real structured SQL error, not a mocked SqlClient.
            yield* sql.unsafe(`CREATE OR REPLACE FUNCTION reject_position() RETURNS trigger AS $$
          BEGIN RAISE EXCEPTION 'planted transaction conflict' USING ERRCODE = '${code}'; END;
          $$ LANGUAGE plpgsql`);
            yield* sql`CREATE TRIGGER reject_position BEFORE INSERT OR UPDATE ON triplex_commit_position FOR EACH ROW EXECUTE FUNCTION reject_position()`;
            const error = yield* triples
              .transact(
                [
                  {
                    op: "assert",
                    entityId: EntityId.make("conflict:failed"),
                    attribute: ":name",
                    value: string("must roll back"),
                  },
                ],
                { commandId: `conflict:${code}` },
              )
              .pipe(Effect.flip);
            expect(error).toMatchObject({
              _tag: "TransactionConflictError",
              reason,
              isRetryable: true,
            });
            expect(yield* triples.entity(EntityId.make("conflict:failed"))).toEqual([]);
            expect(yield* triples.transactionByCommand(`conflict:${code}`)).toBeNull();
            expect(yield* triples.currentPosition()).toBe(0);
            const input = {
              entityId: EntityId.make("conflict:convenience"),
              attribute: ":name",
              value: string("rolled back"),
            };
            for (const write of [
              triples.assert(input),
              triples.assertBatch([input]),
              triples.retract(unsafe.tripleId("00000000000000000000000000")),
              triples.retractByPattern({ entityId: input.entityId }),
            ]) {
              const failure = yield* write.pipe(Effect.flip);
              expect(failure).toMatchObject({
                _tag: "TransactionConflictError",
                reason,
                isRetryable: true,
              });
            }
            yield* Effect.gen(function* () {
              const decorated = yield* Triples;
              const failure = yield* decorated.assert(input).pipe(Effect.flip);
              expect(failure).toMatchObject({
                _tag: "TransactionConflictError",
                reason,
                isRetryable: true,
              });
            }).pipe(Effect.provide(sensitiveConformanceLayer(Layer.succeed(Triples, triples))));
            yield* sql`DROP TRIGGER reject_position ON triplex_commit_position`;
          }
          yield* sql`DROP FUNCTION reject_position()`;
        }),
      );
    },
  );
  it.skipIf(!DOCKER_AVAILABLE)(
    "uses an entity-position index for a selective historical cut",
    { timeout: 120_000 },
    async () => {
      await runWithHostSql(positionIndexPlan("postgres"));
    },
  );
  it.skipIf(!DOCKER_AVAILABLE)(
    "rejects absent and newer migration histories and preserves unrelated SQL errors",
    { timeout: 120_000 },
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { url } = yield* PgConnectionInfo;
            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* runMigrations;
              for (const mode of ["missing", "newer", "malformed"] as const) {
                // A malformed-history SQL failure aborts its transaction, so capture
                // the failure outside the transaction rather than trying to continue it.
                const result = yield* sql
                  .withTransaction(
                    Effect.gen(function* () {
                      const schema = `schema_guard_${mode}`;
                      yield* sql.unsafe(`CREATE SCHEMA ${schema}`);
                      yield* sql.unsafe(`SET LOCAL search_path TO ${schema}, public, pg_catalog`);
                      if (mode === "newer") {
                        yield* sql`CREATE TABLE triplex_schema_migrations (version INTEGER)`;
                        yield* sql`INSERT INTO triplex_schema_migrations VALUES (${EXPECTED_SCHEMA_VERSION + 1})`;
                      } else if (mode === "malformed") {
                        yield* sql`CREATE TABLE triplex_schema_migrations (wrong_column INTEGER)`;
                      }
                      const error = yield* Layer.build(
                        PgTriples.layerFromSqlClient({ scope: `guard:${mode}` }),
                      ).pipe(
                        Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }),
                      );
                      if (mode === "malformed") {
                        expect(error).toMatchObject({ _tag: "SqlError" });
                        // Deliberately roll back: the failed SELECT aborted the transaction.
                        return yield* Effect.fail("expected SQL failure");
                      }
                      expect(error).toMatchObject({
                        _tag: "SchemaVersionError",
                        expectedVersion: EXPECTED_SCHEMA_VERSION,
                        actualVersion: mode === "missing" ? 0 : EXPECTED_SCHEMA_VERSION + 1,
                      });
                      yield* sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
                    }),
                  )
                  .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }));
                expect(result).toBe(mode === "malformed" ? "expected SQL failure" : undefined);
              }
            }).pipe(Effect.provide(makePostgresqlLayerUnmigratedFromUrl(url)));
          }).pipe(Effect.provide(PgContainerLayer)),
        ),
      );
    },
  );
  it.skipIf(!DOCKER_AVAILABLE)(
    "isolates migrated test schemas across pooled connections and cleans up on failure",
    { timeout: 120_000 },
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { url } = yield* PgConnectionInfo;
            const schemas: string[] = [];
            const useFixture = (fail: boolean) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const context = yield* Layer.build(
                    postgresSchemaLayer({
                      url,
                      triples: PgTriples.layerFromSqlClient,
                    }),
                  );
                  const sql = Context.get(context, SqlClient.SqlClient);
                  const triples = Context.get(context, Triples);
                  const [row] = yield* sql<{ schema: string }>`SELECT current_schema() AS schema`;
                  schemas.push(row!.schema);
                  expect(
                    yield* sql`SELECT version FROM triplex_schema_migrations ORDER BY version`,
                  ).toEqual(migrations.map(({ version }) => ({ version })));
                  // Hold several connections concurrently so a one-off SET cannot pass.
                  const connections = yield* Effect.all(
                    Array.from({ length: 4 }, () =>
                      sql.withTransaction(
                        sql<{ schema: string }>`SELECT current_schema() AS schema, pg_sleep(0.02)`,
                      ),
                    ),
                    { concurrency: "unbounded" },
                  );
                  expect(connections.flat().every((r) => r.schema === row!.schema)).toBe(true);
                  expect(yield* triples.entity(EntityId.make("shared:fixture"))).toEqual([]);
                  yield* triples.assert({
                    entityId: "shared:fixture",
                    attribute: ":name",
                    value: string(row!.schema),
                  });
                  if (fail) return yield* Effect.fail("expected fixture failure");
                }),
              );
            const results = yield* Effect.all(
              [
                useFixture(false),
                useFixture(true).pipe(
                  Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }),
                ),
              ],
              { concurrency: "unbounded" },
            );
            expect(results[1]).toBe("expected fixture failure");
            expect(new Set(schemas).size).toBe(2);
            const failedLayer = postgresSchemaLayer({
              url,
              triples: () =>
                Layer.effect(
                  Triples,
                  Effect.gen(function* () {
                    const sql = yield* SqlClient.SqlClient;
                    const [row] = yield* sql<{ schema: string }>`SELECT current_schema() AS schema`;
                    schemas.push(row!.schema);
                    return yield* Effect.fail("expected layer failure");
                  }),
                ),
            });
            const constructionError = yield* Effect.scoped(Layer.build(failedLayer)).pipe(
              Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }),
            );
            expect(constructionError).toBe("expected layer failure");
            expect(new Set(schemas).size).toBe(3);
            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              for (const schema of schemas) {
                expect(
                  yield* sql`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`,
                ).toEqual([]);
              }
            }).pipe(Effect.provide(makePostgresqlLayerUnmigratedFromUrl(url)));
          }).pipe(Effect.provide(PgContainerLayer)),
        ),
      );
    },
  );
  it.skipIf(!DOCKER_AVAILABLE)(
    "rejects a v2 schema during layer acquisition before any application effect",
    { timeout: 120_000 },
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { url } = yield* PgConnectionInfo;
            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql`CREATE SCHEMA schema_guard_v2`;
                  yield* sql`SET LOCAL search_path TO schema_guard_v2, pg_catalog`;
                  yield* sql`CREATE TABLE triplex_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)`;
                  for (const migration of migrations.filter((m) => m.version <= 2)) {
                    for (const statement of migration.up) yield* sql.unsafe(statement);
                    yield* sql`INSERT INTO triplex_schema_migrations VALUES (${migration.version}, ${migration.name}, 0)`;
                  }
                  let applicationRan = false;
                  const error = yield* Effect.sync(() => {
                    applicationRan = true;
                  }).pipe(
                    Effect.provide(PgTriples.layerFromSqlClient({ scope: "guard:v2" })),
                    Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }),
                  );
                  expect(applicationRan).toBe(false);
                  expect(error).toMatchObject({
                    _tag: "SchemaVersionError",
                    expectedVersion: EXPECTED_SCHEMA_VERSION,
                    actualVersion: 2,
                  });
                  expect(String(error)).toContain("runMigrations");
                  yield* sql`DROP SCHEMA schema_guard_v2 CASCADE`;
                }),
              );
            }).pipe(Effect.provide(makePostgresqlLayerUnmigratedFromUrl(url)));
          }).pipe(Effect.provide(PgContainerLayer)),
        ),
      );
    },
  );
  it.skipIf(!DOCKER_AVAILABLE)(
    "uses an expression range index for live and snapshot actor due-work",
    { timeout: 120_000 },
    async () => {
      await runWithHostSql(numericIndexPlan("postgres"));
    },
  );
  it.skipIf(!DOCKER_AVAILABLE)(
    "upgrades an existing v1 schema once without losing data",
    { timeout: 120_000 },
    async () => {
      await runWithHostSql(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`CREATE SCHEMA numeric_index_upgrade`;
              yield* sql`SET LOCAL search_path TO numeric_index_upgrade`;
              for (const statement of migrations[0]!.up) yield* sql.unsafe(statement);
              yield* sql`CREATE TABLE triplex_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)`;
              yield* sql`INSERT INTO triplex_schema_migrations VALUES (1, 'triplex_baseline', 0)`;
              yield* sql`INSERT INTO triples (id, entity_id, attribute, value_type, value_number, recorded_at, recorded_position, valid_from) VALUES ('old', 'old', ':due', 'number', 42, 1, 1, 1)`;
              expect(
                yield* sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'numeric_index_upgrade' AND indexname = 'idx_attr_numeric'`,
              ).toHaveLength(0);
              yield* runMigrations;
              yield* runMigrations;
              expect(
                yield* sql`SELECT version FROM triplex_schema_migrations ORDER BY version`,
              ).toEqual(migrations.map(({ version }) => ({ version })));
              expect(yield* sql`SELECT value_number FROM triples`).toEqual([{ value_number: 42 }]);
              // v3 admits sealed values with an envelope and a blind-index token.
              yield* sql`INSERT INTO triples (id, entity_id, attribute, value_type, value_sealed, value_blind, recorded_at, recorded_position, valid_from) VALUES ('sealed', 'old', ':secret', 'sealed', '{}', 'token', 2, 2, 2)`;
              expect(
                yield* sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'numeric_index_upgrade' AND indexname = 'idx_attr_blind'`,
              ).toHaveLength(1);
              expect(
                yield* sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'numeric_index_upgrade' AND indexname = 'idx_attr_numeric'`,
              ).toHaveLength(1);
              yield* sql`DROP SCHEMA numeric_index_upgrade CASCADE`;
            }),
          );
        }),
      );
    },
  );

  describe("sensitive values", () => {
    const withFreshDatabase = <A, E>(
      use: (context: {
        readonly triples: Layer.Layer<Triples>;
        readonly sql: SqlClient.SqlClient;
      }) => Effect.Effect<A, E>,
    ) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { url } = yield* PgConnectionInfo;
          const context = yield* Layer.build(
            postgresSchemaLayer({ url, triples: PgTriples.layerFromSqlClient }),
          );
          const sql = Context.get(context, SqlClient.SqlClient);
          const triples = Layer.succeed(Triples, Context.get(context, Triples));
          return yield* use({ triples, sql });
        }).pipe(Effect.scoped, Effect.provide(PgContainerLayer)),
      );

    it.skipIf(!DOCKER_AVAILABLE)(
      "passes the sealed-storage engine contract",
      { timeout: 120_000 },
      async () => {
        await withFreshDatabase(({ triples }) =>
          makeSealedStorageSuite().pipe(Effect.provide(triples)),
        );
      },
    );

    it.skipIf(!DOCKER_AVAILABLE)(
      "passes the decorator contract and keeps the full Triples contract through it",
      { timeout: 120_000 },
      async () => {
        await withFreshDatabase(({ triples }) =>
          makeSensitiveConformanceSuite().pipe(
            Effect.andThen(makeTriplesConformanceSuite()),
            Effect.provide(sensitiveConformanceLayer(triples)),
          ),
        );
      },
    );

    it.skipIf(!DOCKER_AVAILABLE)(
      "never persists planted plaintext in any table, index or journal",
      { timeout: 120_000 },
      async () => {
        const dump = await withFreshDatabase(({ triples, sql }) =>
          Effect.gen(function* () {
            yield* makeSensitiveConformanceSuite().pipe(
              Effect.provide(sensitiveConformanceLayer(triples)),
            );
            const tables = yield* sql<{ table_name: string }>`
              SELECT table_name FROM information_schema.tables
              WHERE table_schema = current_schema() ORDER BY table_name
            `;
            const indexes = yield* sql`
              SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()
            `;
            const serialize = (value: unknown) =>
              JSON.stringify(value, (_key, field: unknown) =>
                typeof field === "bigint" ? field.toString() : field,
              );
            const parts = [serialize(indexes)];
            for (const { table_name } of tables) {
              const rows = yield* sql.unsafe(`SELECT * FROM "${table_name.replaceAll('"', '""')}"`);
              parts.push(table_name, serialize(rows));
            }
            return {
              text: parts.join("\n"),
              tables: tables.map(({ table_name }) => table_name),
            };
          }),
        );
        expect(dump.tables).toEqual(
          expect.arrayContaining(["triples", "triplex_command_receipts"]),
        );
        expect(dump.text).toContain("idx_attr_blind");
        expect(findPlaintext(dump.text, "Grace")).not.toEqual([]);
        expect(findPlaintext(dump.text)).toEqual([]);
      },
    );
  });

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
