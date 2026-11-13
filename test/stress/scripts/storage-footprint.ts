/**
 * Storage footprint per asserted triple on SQLite and PostgreSQL.
 *
 * Commits FOOTPRINT_TRANSACTIONS transactions (default 1000), each asserting one
 * entity with FOOTPRINT_ATTRIBUTES string attributes (default 8) of
 * FOOTPRINT_VALUE_BYTES characters (default 32), with an actor and a command ID,
 * like a typical host write. Then it reports, per asserted triple:
 *
 * - the `triples` table, split into the facts themselves, the journal's
 *   `:_tx/change` copies and the other journal metadata (position, instant,
 *   actor, command, changed entity), in proportion to their row payloads;
 * - every index on `triples`;
 * - the other tables;
 * - a plain `(entity, attribute, value)` table holding the same values, as a
 *   baseline.
 *
 * SQLite sizes come from `dbstat` (pages actually used, after a WAL
 * checkpoint). PostgreSQL sizes come from `pg_relation_size` on a fresh
 * container (PG_BENCH_URL to use your own server). Run:
 *
 *   pnpm --filter triplex-stress footprint
 *   FOOTPRINT_BACKENDS=sqlite pnpm --filter triplex-stress footprint
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Context, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { DatabaseId, EntityId, Triples } from "@triplex-build/triplex";
import {
  PgTriples,
  databaseToSchema,
  type PostgresqlConfig,
} from "@triplex-build/triplex/postgres";
import { SqliteTriples } from "@triplex-build/triplex/sqlite";
import { GenericContainer, Wait } from "testcontainers";

const TRANSACTIONS = Number(process.env["FOOTPRINT_TRANSACTIONS"] ?? 1000);
const ATTRIBUTES = Number(process.env["FOOTPRINT_ATTRIBUTES"] ?? 8);
const VALUE_BYTES = Number(process.env["FOOTPRINT_VALUE_BYTES"] ?? 32);
const BACKENDS = (process.env["FOOTPRINT_BACKENDS"] ?? "sqlite,postgresql").split(",");
const ASSERTED = TRANSACTIONS * ATTRIBUTES;

const value = () => randomBytes(VALUE_BYTES).toString("hex").slice(0, VALUE_BYTES);

/** The workload, also returned as rows for the plain baseline table. */
const rows = Array.from({ length: TRANSACTIONS }, (_, tx) =>
  Array.from({ length: ATTRIBUTES }, (_, a) => ({
    entity: `item:${tx}`,
    attribute: `:item/field-${a}`,
    value: value(),
  })),
);

const write = Effect.gen(function* () {
  const triples = yield* Triples;
  for (const [index, facts] of rows.entries()) {
    yield* triples.transact(
      facts.map((fact) => ({
        op: "assert" as const,
        entityId: EntityId.make(fact.entity),
        attribute: fact.attribute,
        value: { type: "string" as const, value: fact.value },
        entityType: "Item",
      })),
      { actor: "footprint", commandId: `footprint-${index}` },
    );
  }
});

interface Report {
  readonly backend: string;
  readonly relations: ReadonlyArray<{
    readonly name: string;
    readonly kind: string;
    readonly bytes: number;
  }>;
  /** Payload share of the `triples` table by row category. */
  readonly split: ReadonlyArray<{
    readonly category: string;
    readonly rows: number;
    readonly payload: number;
  }>;
  readonly plain: number;
}

const CATEGORY = `
  CASE
    WHEN entity_type = '_Transaction' AND attribute = ':_tx/change' THEN 'journal change copies'
    WHEN entity_type = '_Transaction' THEN 'journal metadata'
    ELSE 'facts'
  END`;

const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KiB`;
const per = (bytes: number) => `${(bytes / ASSERTED).toFixed(0)}`;

const print = (report: Report) => {
  const table = report.relations.find((r) => r.name === "triples")!.bytes;
  const payload = report.split.reduce((sum, row) => sum + row.payload, 0);
  const indexes = report.relations.filter((r) => r.kind === "index");
  const others = report.relations.filter((r) => r.kind === "table" && r.name !== "triples");
  const total = report.relations.reduce((sum, r) => sum + r.bytes, 0);
  const lines = [
    `### ${report.backend}`,
    "",
    `${TRANSACTIONS} transactions × ${ATTRIBUTES} string attributes of ${VALUE_BYTES} characters = ${ASSERTED} asserted triples.`,
    "",
    "| Part | Size | Bytes per asserted triple |",
    "| --- | ---: | ---: |",
    ...report.split.map((row) => {
      const bytes = (table * row.payload) / payload;
      return `| \`triples\`: ${row.category} (${row.rows} rows) | ${kb(bytes)} | ${per(bytes)} |`;
    }),
    ...indexes
      .sort((a, b) => b.bytes - a.bytes)
      .map((r) => `| index \`${r.name}\` | ${kb(r.bytes)} | ${per(r.bytes)} |`),
    ...others.map((r) => `| table \`${r.name}\` | ${kb(r.bytes)} | ${per(r.bytes)} |`),
    `| **Total** | **${kb(total)}** | **${per(total)}** |`,
    `| Baseline: plain table with a primary key, same values | ${kb(report.plain)} | ${per(report.plain)} |`,
    "",
  ];
  console.log(lines.join("\n"));
};

const sqlite = Effect.gen(function* () {
  const directory = mkdtempSync(join(tmpdir(), "triplex-footprint-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  );
  const context = yield* Layer.build(
    SqliteTriples.layerWithSqlClient({ filename: join(directory, "footprint.db") }),
  );
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* write.pipe(Effect.provideService(Triples, Context.get(context, Triples)));
  yield* sql`CREATE TABLE plain (entity TEXT NOT NULL, attribute TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (entity, attribute))`;
  for (const facts of rows) {
    for (const fact of facts) {
      yield* sql`INSERT INTO plain VALUES (${fact.entity}, ${fact.attribute}, ${fact.value})`;
    }
  }
  yield* sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE)");
  const pages = yield* sql<{ name: string; type: string; bytes: number }>`
    SELECT d.name AS name, COALESCE(m.type, 'table') AS type, SUM(d.pgsize) AS bytes
    FROM dbstat d LEFT JOIN sqlite_master m ON m.name = d.name
    GROUP BY d.name
  `;
  const split = yield* sql.unsafe<{ category: string; rows: number; payload: number }>(`
    SELECT ${CATEGORY} AS category, COUNT(*) AS rows,
      SUM(LENGTH(id) + LENGTH(entity_id) + LENGTH(attribute) + LENGTH(value_type)
        + COALESCE(LENGTH(value_string), 0) + COALESCE(LENGTH(value_json), 0)
        + COALESCE(LENGTH(value_sealed), 0) + COALESCE(LENGTH(value_blind), 0)
        + COALESCE(LENGTH(entity_type), 0) + COALESCE(LENGTH(tx_id), 0)
        + COALESCE(LENGTH(created_by), 0) + COALESCE(LENGTH(retract_tx_id), 0)
        + 8 * 6) AS payload
    FROM triples GROUP BY 1 ORDER BY 1
  `);
  const plainAndIndex = pages
    .filter((p) => p.name === "plain" || p.name === "sqlite_autoindex_plain_1")
    .reduce((sum, p) => sum + Number(p.bytes), 0);
  return {
    backend: "SQLite",
    relations: pages
      .filter((p) => !p.name.startsWith("plain") && !p.name.startsWith("sqlite_autoindex_plain"))
      .map((p) => ({
        name: p.name,
        kind: p.type === "index" ? "index" : "table",
        bytes: Number(p.bytes),
      })),
    split: split.map((s) => ({
      category: s.category,
      rows: Number(s.rows),
      payload: Number(s.payload),
    })),
    plain: plainAndIndex,
  } satisfies Report;
});

const postgresql = Effect.gen(function* () {
  let url = process.env["PG_BENCH_URL"];
  if (url === undefined) {
    const container = yield* Effect.acquireRelease(
      Effect.promise(() =>
        new GenericContainer(process.env["PG_BENCH_IMAGE"] ?? "postgres:17-alpine")
          .withEnvironment({
            POSTGRES_USER: "bench",
            POSTGRES_PASSWORD: "bench",
            POSTGRES_DB: "bench",
          })
          .withExposedPorts(5432)
          .withTmpFs({ "/var/lib/postgresql/data": "rw" })
          .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
          .start(),
      ),
      (container) => Effect.promise(() => container.stop()),
    );
    url = `postgresql://bench:bench@${container.getHost()}:${container.getMappedPort(5432)}/bench`;
  }
  const parsed = new URL(url);
  const admin = Context.get(
    yield* Layer.build(PgClient.layer({ url: Redacted.make(url) })),
    SqlClient.SqlClient,
  );
  const database = DatabaseId.make(`footprint-${randomUUID().slice(0, 8)}`);
  const schema = databaseToSchema(database);
  yield* Effect.addFinalizer(() =>
    admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).pipe(Effect.orDie),
  );
  const config: PostgresqlConfig = {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    database: decodeURIComponent(parsed.pathname.slice(1)),
    username: decodeURIComponent(parsed.username),
    password: Redacted.make(decodeURIComponent(parsed.password)),
    pool: { min: 1, max: 2 },
  };
  const context = yield* Layer.build(PgTriples.layerForDatabaseMigrated(config, database));
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* write.pipe(Effect.provideService(Triples, Context.get(context, Triples)));
  yield* sql`CREATE TABLE plain (entity TEXT NOT NULL, attribute TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (entity, attribute))`;
  for (const facts of rows) {
    for (const fact of facts) {
      yield* sql`INSERT INTO plain VALUES (${fact.entity}, ${fact.attribute}, ${fact.value})`;
    }
  }
  yield* sql.unsafe("VACUUM ANALYZE");
  const relations = yield* sql<{ name: string; kind: string; bytes: string }>`
    SELECT c.relname AS name,
      CASE c.relkind WHEN 'i' THEN 'index' ELSE 'table' END AS kind,
      (pg_relation_size(c.oid)
        + CASE WHEN c.reltoastrelid <> 0 THEN pg_total_relation_size(c.reltoastrelid) ELSE 0 END)::text AS bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'i')
  `;
  const split = yield* sql.unsafe<{ category: string; rows: string; payload: string }>(`
    SELECT ${CATEGORY} AS category, COUNT(*)::text AS rows, SUM(pg_column_size(t.*))::text AS payload
    FROM triples t GROUP BY 1 ORDER BY 1
  `);
  const isPlain = (name: string) => name === "plain" || name === "plain_pkey";
  return {
    backend: "PostgreSQL",
    relations: relations
      .filter((r) => !isPlain(r.name))
      .map((r) => ({ name: r.name, kind: r.kind, bytes: Number(r.bytes) })),
    split: split.map((s) => ({
      category: s.category,
      rows: Number(s.rows),
      payload: Number(s.payload),
    })),
    plain: relations.filter((r) => isPlain(r.name)).reduce((sum, r) => sum + Number(r.bytes), 0),
  } satisfies Report;
});

const program = Effect.gen(function* () {
  if (BACKENDS.includes("sqlite")) print(yield* Effect.scoped(sqlite));
  if (BACKENDS.includes("postgresql")) print(yield* Effect.scoped(postgresql));
});

Effect.runPromise(Effect.scoped(program)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
