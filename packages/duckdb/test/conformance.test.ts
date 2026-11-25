import type { DuckDBConnection, DuckDBValue } from "@duckdb/node-api";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { EntityId, Triples, boolean, datetime, number, ref, string } from "@triplex-internal/core";
import {
  CurrentDialect,
  QueryExecutor,
  TriplesLive,
  makeTripleStoreRuntimeLayer,
} from "@triplex-internal/core/internal";
import {
  JOURNAL_ATTRIBUTES_TABLE_DDLS,
  JOURNAL_FACTS_VIEW_DDL,
  TRANSACTIONS_TABLE_DDL,
  TRANSACTION_ENTITIES_TABLE_DDL,
  TRIPLES_TABLE_DDL,
  type SqlStatementRunner,
} from "@triplex-build/triplex-sql";
import {
  SqliteAdapterLive,
  SqliteDialect,
  SqliteTestLayer,
  SqliteTriples,
} from "@triplex-build/triplex-sqlite";
import {
  makeSealedStorageSuite,
  makeSensitiveConformanceSuite,
  makeTriplesConformanceSuite,
  sensitiveConformanceLayer,
} from "@triplex-build/triplex-testkit";
import {
  DuckDbDialect,
  makeDuckDbQueryExecutor,
  openDuckDbConnection,
  type DuckDbStatementRunner,
} from "@triplex-build/triplex-duckdb";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const TRIPLE_COLUMNS = [
  "id",
  "entity_id",
  "attribute",
  "value_type",
  "value_string",
  "value_number",
  "value_boolean",
  "value_datetime",
  "value_json",
  "recorded_at",
  "recorded_position",
  "valid_from",
  "valid_to",
  "created_by",
  "retracted_at",
  "retracted_position",
  "retract_tx_id",
  "entity_type",
  "schema_version",
  "tx_id",
  "value_sealed",
  "value_blind",
] as const;

const TX_COLUMNS = [
  "tx_id",
  "position",
  "instant",
  "actor",
  "command_id",
  "correlation_id",
  "causation_id",
  "config_snapshot",
  "changes",
] as const;

const TX_ENTITY_COLUMNS = ["entity_id", "position", "tx_id"] as const;

const initDuckDbSchema = (runner: DuckDbStatementRunner) =>
  Effect.gen(function* () {
    yield* runner.execute(TRIPLES_TABLE_DDL);
    yield* runner.execute(TRANSACTIONS_TABLE_DDL);
    yield* runner.execute(TRANSACTION_ENTITIES_TABLE_DDL);
    for (const ddl of JOURNAL_ATTRIBUTES_TABLE_DDLS) {
      yield* runner.execute(ddl);
    }
    yield* runner.execute(JOURNAL_FACTS_VIEW_DDL);
  });

const syncTableToDuckDb = (
  sql: SqlClient.SqlClient,
  connection: DuckDBConnection,
  runner: DuckDbStatementRunner,
  table: string,
  columns: readonly string[],
) =>
  Effect.gen(function* () {
    const rows = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT ${columns.join(", ")} FROM ${table}`,
    );
    yield* runner.execute(`DELETE FROM ${table}`);
    if (rows.length === 0) return;

    yield* Effect.tryPromise(async () => {
      const appender = await connection.createAppender(table);
      try {
        for (const row of rows) {
          for (const col of columns) {
            const value = row[col];
            if (value === null || value === undefined) {
              appender.appendNull();
            } else {
              appender.appendValue(value as DuckDBValue);
            }
          }
          appender.endRow();
        }
      } finally {
        appender.closeSync();
      }
    });
  });

const syncAllTablesToDuckDb = (
  sql: SqlClient.SqlClient,
  connection: DuckDBConnection,
  runner: DuckDbStatementRunner,
) =>
  Effect.gen(function* () {
    yield* runner.execute("BEGIN TRANSACTION");
    yield* Effect.onError(
      Effect.gen(function* () {
        yield* syncTableToDuckDb(sql, connection, runner, "triples", TRIPLE_COLUMNS);
        yield* syncTableToDuckDb(sql, connection, runner, "triplex_transactions", TX_COLUMNS);
        yield* syncTableToDuckDb(
          sql,
          connection,
          runner,
          "triplex_transaction_entities",
          TX_ENTITY_COLUMNS,
        );
        yield* runner.execute("COMMIT");
      }),
      () => runner.execute("ROLLBACK").pipe(Effect.ignore),
    );
  });

const sqliteFingerprint = (sql: SqlClient.SqlClient) =>
  sql
    .unsafe<{ fp: string }>(
      `SELECT
        (SELECT COUNT(*) FROM triples) || ':' ||
        COALESCE((SELECT MAX(recorded_position) FROM triples), 0) || ':' ||
        COALESCE((SELECT MAX(retracted_position) FROM triples), 0) || ':' ||
        COALESCE((SELECT SUM(CASE WHEN retracted_at IS NOT NULL THEN 1 ELSE 0 END) FROM triples), 0) || ':' ||
        (SELECT COUNT(*) FROM triplex_transactions) || ':' ||
        (SELECT COUNT(*) FROM triplex_transaction_entities) AS fp`,
    )
    .pipe(Effect.map((rows) => rows[0]?.fp ?? ""));

/**
 * Composes SQLite's StorageAdapter for writes/metadata with DuckDbQueryExecutor
 * for 100% of Datalog queries (`query`, `queryPage`, `explain`, `explainPage`).
 * Before each DuckDB statement executes, current SQLite rows (including
 * uncommitted rows inside commit-validator transactions) are mirrored into
 * the in-memory DuckDB instance whenever the SQLite fingerprint changes.
 */
const makeDuckDbBackedTriplesLayer = (scope = "duckdb::memory:") => {
  const duckDbQueryExecutorLayer = Layer.effect(
    QueryExecutor,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const handle = yield* openDuckDbConnection();
      yield* initDuckDbSchema(handle.runner);
      let lastFingerprint = "";

      const syncingRunner: SqlStatementRunner = {
        run: <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[]) =>
          Effect.gen(function* () {
            const fp = yield* sqliteFingerprint(sql);
            if (fp !== lastFingerprint) {
              yield* syncAllTablesToDuckDb(sql, handle.connection, handle.runner);
              lastFingerprint = fp;
            }
            return yield* handle.runner.run<Row>(statement, params);
          }),
      };

      return makeDuckDbQueryExecutor(syncingRunner);
    }),
  );

  return TriplesLive.pipe(
    Layer.provide(duckDbQueryExecutorLayer),
    Layer.provide(SqliteAdapterLive),
    Layer.provide(Layer.succeed(CurrentDialect, SqliteDialect)),
    Layer.provide(SqliteTestLayer),
    Layer.provide(makeTripleStoreRuntimeLayer(scope)),
  );
};

describe("DuckDB Datalog conformance", () => {
  it(
    "passes the full shared Triples conformance suite via DuckDbQueryExecutor",
    { timeout: 60_000 },
    async () => {
      await expect(
        Effect.runPromise(
          makeTriplesConformanceSuite().pipe(
            Effect.provide(Layer.fresh(makeDuckDbBackedTriplesLayer("duckdb:conformance"))),
            Effect.scoped,
          ) as Effect.Effect<void, unknown, never>,
        ),
      ).resolves.toBeUndefined();
    },
  );

  it(
    "passes the sealed-storage engine contract via DuckDbQueryExecutor",
    { timeout: 30_000 },
    async () => {
      await expect(
        Effect.runPromise(
          makeSealedStorageSuite().pipe(
            Effect.provide(Layer.fresh(makeDuckDbBackedTriplesLayer("duckdb:sealed"))),
            Effect.scoped,
          ) as Effect.Effect<void, unknown, never>,
        ),
      ).resolves.toBeUndefined();
    },
  );

  it(
    "passes the sensitive decorator contract via DuckDbQueryExecutor",
    { timeout: 30_000 },
    async () => {
      await expect(
        Effect.runPromise(
          makeSensitiveConformanceSuite().pipe(
            Effect.provide(
              sensitiveConformanceLayer(
                Layer.fresh(makeDuckDbBackedTriplesLayer("duckdb:sensitive")),
              ),
            ),
            Effect.scoped,
          ) as Effect.Effect<void, unknown, never>,
        ),
      ).resolves.toBeUndefined();
    },
  );

  it("executes Datalog queries directly over Parquet datasets with DuckDbDialect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triplex-duckdb-parquet-"));
    temporaryDirectories.push(dir);
    const triplesParquet = join(dir, "triples.parquet");
    const txParquet = join(dir, "transactions.parquet");
    const txEntitiesParquet = join(dir, "transaction_entities.parquet");

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // 1. Seed facts via Triples and export to Parquet from a writer DuckDB connection
        const writer = yield* openDuckDbConnection();
        yield* initDuckDbSchema(writer.runner);

        const sql = yield* SqlClient.SqlClient;
        const triples = yield* Triples;
        const alice = EntityId.make("user:alice");
        const bob = EntityId.make("user:bob");
        const carol = EntityId.make("user:carol");

        yield* triples.assertBatch([
          { entityId: alice, attribute: ":user/name", value: string("Alice") },
          { entityId: alice, attribute: ":user/score", value: number(95) },
          { entityId: alice, attribute: ":user/active", value: boolean(true) },
          { entityId: alice, attribute: ":user/joined", value: datetime(1_700_000_000_000) },
          { entityId: alice, attribute: ":user/manages", value: ref(bob) },
          { entityId: bob, attribute: ":user/name", value: string("Bob") },
          { entityId: bob, attribute: ":user/score", value: number(80) },
          { entityId: bob, attribute: ":user/manages", value: ref(carol) },
          { entityId: carol, attribute: ":user/name", value: string("Carol") },
          { entityId: carol, attribute: ":user/score", value: number(70) },
        ]);

        yield* syncAllTablesToDuckDb(sql, writer.connection, writer.runner);

        const escapeSql = (p: string) => p.replaceAll("'", "''");
        yield* writer.runner.execute(
          `COPY triples TO '${escapeSql(triplesParquet)}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
        );
        yield* writer.runner.execute(
          `COPY triplex_transactions TO '${escapeSql(txParquet)}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
        );
        yield* writer.runner.execute(
          `COPY triplex_transaction_entities TO '${escapeSql(txEntitiesParquet)}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
        );

        // 2. Open a fresh read-only DuckDB connection backed ONLY by Parquet views
        const reader = yield* openDuckDbConnection();
        yield* reader.runner.execute(
          `CREATE VIEW triples AS SELECT * FROM read_parquet('${escapeSql(triplesParquet)}')`,
        );
        yield* reader.runner.execute(
          `CREATE VIEW triplex_transactions AS SELECT * FROM read_parquet('${escapeSql(txParquet)}')`,
        );
        yield* reader.runner.execute(
          `CREATE VIEW triplex_transaction_entities AS SELECT * FROM read_parquet('${escapeSql(txEntitiesParquet)}')`,
        );
        for (const ddl of JOURNAL_ATTRIBUTES_TABLE_DDLS) {
          yield* reader.runner.execute(ddl);
        }
        yield* reader.runner.execute(JOURNAL_FACTS_VIEW_DDL);

        const executor = makeDuckDbQueryExecutor(reader.connection);

        // Recursive rule + join + predicate
        const recursive = yield* executor.execute({
          find: ["?report", "?name"],
          where: [
            ["reaches", "user:alice", "?report"],
            ["?report", ":user/name", "?name"],
          ],
          rules: [
            {
              name: "reaches",
              body: [["?x", ":user/manages", "?y"]],
            },
            {
              name: "reaches",
              body: [
                ["?x", ":user/manages", "?z"],
                ["reaches", "?z", "?y"],
              ],
            },
          ],
        });

        // Wrapped page with ILIKE filter + ordering + totalCount
        const page = yield* executor.executePage({
          inner: {
            find: ["?name", "?score"],
            where: [
              ["?e", ":user/name", "?name"],
              ["?e", ":user/score", "?score"],
            ],
          },
          filters: [{ column: "?name", op: "ilike", value: "%o%" }],
          orderBy: [{ variable: "?score", direction: "desc" }],
          includeCount: true,
        });

        // Explain reports duckdb dialect
        const plan = yield* executor.explain({
          find: ["?name"],
          where: [["?e", ":user/name", "?name"]],
        });

        return { recursive, page, plan };
      }).pipe(Effect.provide(Layer.fresh(SqliteTriples.layerMemoryWithSqlClient)), Effect.scoped),
    );

    expect(DuckDbDialect.name).toBe("duckdb");
    expect(DuckDbDialect.limitOffset(10, 5)).toBe("LIMIT 10 OFFSET 5");
    expect(DuckDbDialect.limitOffset(undefined, 5)).toBe("OFFSET 5");
    expect(DuckDbDialect.limitOffset(10, 0)).toBe("LIMIT 10");
    expect(DuckDbDialect.castAsText("x")).toBe("CAST(x AS TEXT)");
    expect(DuckDbDialect.booleanLiteral(true)).toBe("TRUE");
    expect(DuckDbDialect.booleanLiteral(false)).toBe("FALSE");
    expect(DuckDbDialect.paramPlaceholder(0)).toBe("$1");
    expect(DuckDbDialect.paramPlaceholder(2)).toBe("$3");
    expect(DuckDbDialect.escapeLikePattern("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
    expect(result.plan.queryPlan.backend).toBe("duckdb");
    expect(result.recursive.results).toEqual(
      expect.arrayContaining([
        { "?report": "user:bob", "?name": "Bob" },
        { "?report": "user:carol", "?name": "Carol" },
      ]),
    );
    expect(result.page.totalCount).toBe(2);
    expect(result.page.results).toEqual([
      { "?name": "Bob", "?score": 80 },
      { "?name": "Carol", "?score": 70 },
    ]);
  });
});
