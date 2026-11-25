/**
 * Tiered routing, federated hot+cold DuckDB views, pagination cursors across W,
 * history/transactions/why parity, and sensitive-value blind-index tests.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import {
  EntityId,
  ReadError,
  SqliteDialect,
  Triples,
  type DatalogQuery,
  type TransactionId,
} from "@triplex-internal/core/internal";
import { ConfigStore } from "@triplex-internal/core/config";
import * as Why from "@triplex-internal/core/why";
import { KeyProvider, Sensitive, ValueCodec } from "@triplex-internal/core/sensitive";
import type { SqlStatementRunner } from "@triplex-build/triplex-sql";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";
import { openDuckDbConnection } from "../src/DuckDbQueryExecutor.js";
import {
  makeInMemoryColdManifestStore,
  makeParquetCompactor,
  readColdWatermark,
  type ColdManifest,
} from "../src/compaction/index.js";
import {
  TieredTriples,
  buildAttachHotSql,
  buildFederatedViewsDdl,
  decideTierRoute,
  inspectDatalogQueryForRouting,
  makeTieredQueryExecutor,
  recordColdErasedKeys,
  setupFederatedViews,
  syncHotTablesToDuckDb,
  type TierRoutingDecision,
} from "../src/tiered/index.js";

const makeTempDir = () => fs.mkdtemp(path.join(os.tmpdir(), "triplex-tiered-test-"));

const sqlClientToRunner = (sql: SqlClient.SqlClient): SqlStatementRunner => ({
  run: <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[]) =>
    sql.unsafe<Row>(statement, [...params]),
});

// =============================================================================
// 1. Pure Routing & DDL Unit Tests
// =============================================================================

describe("TieredQueryExecutor routing decisions", () => {
  const simpleQuery: DatalogQuery = {
    find: ["?e", "?name"],
    where: [["?e", ":person/name", "?name"]],
  };

  it("routes all queries to hot when watermark is 0", () => {
    const decision = decideTierRoute({
      query: simpleQuery,
      watermark: 0,
      basis: { recordedPosition: 5 },
    });
    expect(decision.target).toBe("hot");
    expect(decision.reason).toBe("no-cold-data");
  });

  it("routes live and recent cuts (recordedPosition > W) 100% to hot", () => {
    const liveDecision = decideTierRoute({
      query: simpleQuery,
      watermark: 10,
      watermarkInstant: 1_000,
    });
    expect(liveDecision.target).toBe("hot");
    expect(liveDecision.reason).toBe("live-above-watermark");

    const recentDecision = decideTierRoute({
      query: simpleQuery,
      watermark: 10,
      watermarkInstant: 1_000,
      basis: { recordedPosition: 15, recordedAt: 2_000 },
    });
    expect(recentDecision.target).toBe("hot");
    expect(recentDecision.reason).toBe("recent-above-watermark");
  });

  it("routes historical cuts (recordedPosition <= W) to federated DuckDB", () => {
    const atWatermark = decideTierRoute({
      query: simpleQuery,
      watermark: 10,
      basis: { recordedPosition: 10 },
    });
    expect(atWatermark.target).toBe("federated");
    expect(atWatermark.reason).toBe("historical-at-or-below-watermark");

    const belowWatermark = decideTierRoute({
      query: simpleQuery,
      watermark: 10,
      basis: { recordedPosition: 4 },
    });
    expect(belowWatermark.target).toBe("federated");
    expect(belowWatermark.reason).toBe("historical-at-or-below-watermark");
  });

  it("routes historical recordedAt cuts (< watermarkInstant) to federated DuckDB", () => {
    const decision = decideTierRoute({
      query: simpleQuery,
      watermark: 10,
      watermarkInstant: 5_000,
      basis: { recordedPosition: 20, recordedAt: 4_000 },
    });
    expect(decision.target).toBe("federated");
    expect(decision.reason).toBe("recorded-at-cut");
  });

  it("routes queries touching :_tx/* or variable attributes to federated when W > 0", () => {
    const txQuery: DatalogQuery = {
      find: ["?tx", "?actor"],
      where: [["?tx", ":_tx/actor", "?actor"]],
    };
    expect(inspectDatalogQueryForRouting(txQuery)).toEqual({
      readsJournal: true,
      hasVariableAttribute: false,
    });
    expect(
      decideTierRoute({ query: txQuery, watermark: 5, basis: { recordedPosition: 20 } }).target,
    ).toBe("federated");

    const varAttrQuery: DatalogQuery = {
      find: ["?e", "?a", "?v"],
      where: [["?e", "?a", "?v"]],
    };
    expect(inspectDatalogQueryForRouting(varAttrQuery)).toEqual({
      readsJournal: false,
      hasVariableAttribute: true,
    });
    expect(
      decideTierRoute({ query: varAttrQuery, watermark: 5, basis: { recordedPosition: 20 } })
        .target,
    ).toBe("federated");

    // Predicates like [">", "?age", 18] must NOT be misclassified as variable attributes.
    const predQuery: DatalogQuery = {
      find: ["?e"],
      where: [
        ["?e", ":person/age", "?age"],
        [">", "?age", 18],
      ],
    };
    expect(inspectDatalogQueryForRouting(predQuery)).toEqual({
      readsJournal: false,
      hasVariableAttribute: false,
    });
    expect(
      decideTierRoute({ query: predQuery, watermark: 5, basis: { recordedPosition: 20 } }).target,
    ).toBe("hot");
  });

  it("honors preferAnalyticalCold and dispatches to the chosen QueryExecutorService", async () => {
    let hotCalls = 0;
    let federatedCalls = 0;
    const routes: TierRoutingDecision[] = [];

    const stubExecutor = (onCall: () => void) => ({
      execute: () =>
        Effect.sync(() => {
          onCall();
          return { results: [] };
        }),
      executePage: () =>
        Effect.sync(() => {
          onCall();
          return { results: [] };
        }),
      explain: () =>
        Effect.sync(() => {
          onCall();
          return { queryPlan: { backend: "stub", steps: [] } };
        }),
      explainPage: () =>
        Effect.sync(() => {
          onCall();
          return { queryPlan: { backend: "stub", steps: [] } };
        }),
    });

    const executor = makeTieredQueryExecutor({
      hot: stubExecutor(() => {
        hotCalls++;
      }),
      federated: stubExecutor(() => {
        federatedCalls++;
      }),
      policy: {
        watermark: Effect.succeed(10),
        watermarkInstant: Effect.succeed(1_000),
        onRoute: (d) => routes.push(d),
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        // Above watermark -> hot only
        yield* executor.execute(simpleQuery, false, { recordedPosition: 12, validAt: 2_000 });
        // Below watermark -> federated
        yield* executor.execute(simpleQuery, false, { recordedPosition: 8, validAt: 2_000 });
      }),
    );

    expect(hotCalls).toBe(1);
    expect(federatedCalls).toBe(1);
    expect(routes.map((r) => r.target)).toEqual(["hot", "federated"]);

    const analyticalDecision = decideTierRoute({
      query: simpleQuery,
      watermark: 0,
      preferAnalyticalCold: true,
    });
    expect(analyticalDecision.target).toBe("federated");
    expect(analyticalDecision.reason).toBe("prefer-analytical-cold");
  });
});

describe("FederatedViews SQL generation & overlap deduplication", () => {
  it("generates ATTACH statements for SQLite and PostgreSQL hot sources", () => {
    expect(buildAttachHotSql({ type: "sqlite", path: "/data/hot.db" })).toBe(
      `ATTACH IF NOT EXISTS '/data/hot.db' AS "hot_tier" (TYPE SQLITE, READ_ONLY)`,
    );
    expect(
      buildAttachHotSql({
        type: "postgres",
        connectionString: "postgresql://user:pass@localhost:5432/triplex",
        alias: "pg_hot",
      }),
    ).toBe(
      `ATTACH IF NOT EXISTS 'postgresql://user:pass@localhost:5432/triplex' AS "pg_hot" (TYPE POSTGRES, READ_ONLY)`,
    );
    expect(buildAttachHotSql({ type: "schema", schema: "hot_tier" })).toBeUndefined();
  });

  it("deduplicates hot+cold overlap window cleanly by id and tx_id", async () => {
    const tmpDir = await makeTempDir();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const duck = yield* openDuckDbConnection();
            const hotTriples = yield* Triples;
            const sql = yield* SqlClient.SqlClient;
            const hotRunner = sqlClientToRunner(sql);

            const e1 = EntityId.make("user:overlap-1");
            const t1 = yield* hotTriples.assert({
              entityId: e1,
              attribute: ":name",
              value: { type: "string", value: "Alice v1" },
            });
            yield* hotTriples.retract(t1.id);
            yield* hotTriples.assert({
              entityId: e1,
              attribute: ":name",
              value: { type: "string", value: "Alice v2" },
            });

            // Export retracted rows to cold Parquet while intentionally keeping them
            // in hot (simulating the two-phase compaction overlap window).
            const manifestStore = makeInMemoryColdManifestStore();
            const compactor = makeParquetCompactor({
              databaseScope: "sqlite::memory:",
              hotRunner,
              dialect: SqliteDialect,
              manifestStore,
              outputDir: tmpDir,
              onPhase: (phase) =>
                phase === "after_watermark_update"
                  ? Effect.fail(
                      // Stop before hot DELETE to simulate overlap window!
                      {
                        _tag: "ColdCompactionError",
                        code: "hot_write_failed",
                        message: "stop",
                      } as never,
                    )
                  : Effect.void,
            });
            yield* compactor.compact({ targetWatermark: 2 }).pipe(Effect.ignore);
            const manifest = (yield* manifestStore.load)!;
            expect(manifest).not.toBeNull();
            expect(manifest.segments.triples.length).toBe(1);

            // Both hot AND cold contain the retracted triple t1 and tx pos 1..2.
            yield* syncHotTablesToDuckDb(hotRunner, duck.runner, "hot_tier");
            yield* setupFederatedViews(duck.runner, {
              hot: { type: "schema", schema: "hot_tier" },
              cold: manifest,
            });

            const tripleRows = yield* duck.runner.run<{ id: string }>(
              "SELECT id FROM triples WHERE entity_id = $1",
              [e1],
            );
            // Must be exactly 2 distinct facts (v1 + v2), zero duplicates!
            expect(tripleRows.length).toBe(2);
            expect(new Set(tripleRows.map((r) => r.id)).size).toBe(2);

            const txRows = yield* duck.runner.run<{ tx_id: string }>(
              "SELECT tx_id FROM triplex_transactions",
              [],
            );
            expect(txRows.length).toBe(3);
            expect(new Set(txRows.map((r) => r.tx_id)).size).toBe(3);

            const ddl = buildFederatedViewsDdl({
              hot: { type: "schema", schema: "hot_tier" },
              cold: manifest,
            });
            expect(ddl.some((s) => s.includes("QUALIFY ROW_NUMBER() OVER (PARTITION BY id"))).toBe(
              true,
            );
          }).pipe(Effect.provide(SqliteTriples.layerMemoryWithSqlClient)),
        ),
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// 2. End-to-End Parity: Routing, Cursors Across W, History, Transactions, Why
// =============================================================================

describe("TieredTriples end-to-end hot + cold parity", () => {
  it("preserves query, cursor pagination across W, history, transactions, and why after compaction", async () => {
    const tmpDir = await makeTempDir();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const duck = yield* openDuckDbConnection();
            const hotTriples = yield* Triples;
            const sql = yield* SqlClient.SqlClient;
            const hotRunner = sqlClientToRunner(sql);
            const scope = "sqlite::memory:";

            const alice = EntityId.make("person:alice");
            const bob = EntityId.make("person:bob");
            const carol = EntityId.make("person:carol");
            const dave = EntityId.make("person:dave");
            const eve = EntityId.make("person:eve");

            // Tx 1: assert initial Alice & Bob
            const tx1 = yield* hotTriples.transact(
              [
                {
                  op: "assert",
                  entityId: alice,
                  attribute: ":person/name",
                  value: { type: "string", value: "Alice" },
                },
                {
                  op: "assert",
                  entityId: alice,
                  attribute: ":person/role",
                  value: { type: "string", value: "intern" },
                },
                {
                  op: "assert",
                  entityId: bob,
                  attribute: ":person/name",
                  value: { type: "string", value: "Bob" },
                },
              ],
              { actor: "hr-bot", commandId: "cmd-hire-1" },
            );
            const aliceInternTriple = tx1.triples[1]!;

            // Tx 2: promote Alice (retract intern, assert engineer)
            const tx2 = yield* hotTriples.transact(
              [
                { op: "retract", id: aliceInternTriple.id },
                {
                  op: "assert",
                  entityId: alice,
                  attribute: ":person/role",
                  value: { type: "string", value: "engineer" },
                },
              ],
              { actor: "manager", commandId: "cmd-promote-1", causationId: "cmd-hire-1" },
            );

            // Tx 3: add Carol, Dave, Eve
            const tx3 = yield* hotTriples.transact(
              [
                {
                  op: "assert",
                  entityId: carol,
                  attribute: ":person/name",
                  value: { type: "string", value: "Carol" },
                },
                {
                  op: "assert",
                  entityId: dave,
                  attribute: ":person/name",
                  value: { type: "string", value: "Dave" },
                },
                {
                  op: "assert",
                  entityId: eve,
                  attribute: ":person/name",
                  value: { type: "string", value: "Eve" },
                },
              ],
              { actor: "hr-bot", commandId: "cmd-hire-2" },
            );

            // Tx 4: promote Alice again (retract engineer, assert staff)
            const aliceEngineerTriple = tx2.triples[0]!;
            const tx4 = yield* hotTriples.transact(
              [
                { op: "retract", id: aliceEngineerTriple.id },
                {
                  op: "assert",
                  entityId: alice,
                  attribute: ":person/role",
                  value: { type: "string", value: "staff" },
                },
              ],
              { actor: "vp", commandId: "cmd-promote-2", causationId: "cmd-promote-1" },
            );

            // Capture pre-compaction ground truth!
            const preHistoryAlice = yield* hotTriples.history(alice);
            const preTx1 = yield* hotTriples.transaction(tx1.txId);
            const preTx1ByCmd = yield* hotTriples.transactionByCommand("cmd-hire-1");
            const preAllTxs = yield* hotTriples.transactions({ after: 0, limit: 10 });
            const preAliceTxs = yield* hotTriples.transactionsForEntity(alice);
            const preRoleAtTx1 = yield* hotTriples.queryAll(
              { find: ["?r"], where: [[alice, ":person/role", "?r"]] },
              { basis: { recordedPosition: tx1.position } },
            );
            const preRoleAtTx2 = yield* hotTriples.queryAll(
              { find: ["?r"], where: [[alice, ":person/role", "?r"]] },
              { basis: { recordedPosition: tx2.position } },
            );
            const fixedValidAt = Date.now();
            const preWhyFact = yield* Effect.gen(function* () {
              const whyService = yield* Why.Why;
              return yield* whyService.why(
                { kind: "fact", tripleId: aliceInternTriple.id },
                {
                  basis: { recordedPosition: tx4.position, validAt: fixedValidAt },
                  causationDepth: 4,
                },
              );
            }).pipe(
              Effect.provide(
                Why.Why.layer.pipe(
                  Layer.provide(ConfigStore.layer),
                  Layer.provide(Layer.succeed(Triples, hotTriples)),
                ),
              ),
            );
            const preWhyEntityAtTx1 = yield* Effect.gen(function* () {
              const whyService = yield* Why.Why;
              return yield* whyService.why(
                { kind: "entity", entityId: alice },
                {
                  basis: { recordedPosition: tx1.position, validAt: fixedValidAt },
                  causationDepth: 4,
                },
              );
            }).pipe(
              Effect.provide(
                Why.Why.layer.pipe(
                  Layer.provide(ConfigStore.layer),
                  Layer.provide(Layer.succeed(Triples, hotTriples)),
                ),
              ),
            );

            // Start a paginated query BEFORE compaction (at position tx4.position = 4)
            const pagedQuery: DatalogQuery = {
              find: ["?name"],
              where: [["?e", ":person/name", "?name"]],
              orderBy: [{ variable: "?name", direction: "asc" }],
            };

            const routes: TierRoutingDecision[] = [];
            let federatedSyncCalls = 0;
            let currentManifest: ColdManifest | null = null;
            const manifestStore = makeInMemoryColdManifestStore();

            const watermarkEffect = readColdWatermark(hotRunner, SqliteDialect, scope).pipe(
              Effect.mapError((cause) => new ReadError({ message: cause.message, cause })),
            );

            const refreshFederated = Effect.gen(function* () {
              federatedSyncCalls++;
              yield* syncHotTablesToDuckDb(hotRunner, duck.runner, "hot_tier");
              yield* setupFederatedViews(duck.runner, {
                hot: { type: "schema", schema: "hot_tier" },
                cold: currentManifest ?? { triples: [], transactions: [], transactionEntities: [] },
              });
            });

            const tieredLayer = TieredTriples.layer({
              federatedRunner: duck.runner,
              watermark: watermarkEffect,
              scope,
              onRoute: (d) => routes.push(d),
              beforeFederatedRead: refreshFederated,
            }).pipe(Layer.provide(Layer.succeed(Triples, hotTriples)));

            // Run page 1 BEFORE compaction -> must route to hot!
            const page1 = yield* Effect.gen(function* () {
              const t = yield* Triples;
              return yield* t.query(pagedQuery, { pageSize: 2 });
            }).pipe(Effect.provide(tieredLayer));

            expect(page1.results.map((r) => r["?name"])).toEqual(["Alice", "Bob"]);
            expect(page1.nextCursor).toBeDefined();
            expect(routes.at(-1)?.target).toBe("hot");

            // Now compact at W = tx4.position (archives retracted facts & journal rows <= 4,
            // and DELETES them from hot SQLite!).
            const compactor = makeParquetCompactor({
              databaseScope: scope,
              hotRunner,
              dialect: SqliteDialect,
              manifestStore,
              outputDir: tmpDir,
            });
            const compactRes = yield* compactor.compact({ targetWatermark: tx4.position });
            currentManifest = compactRes.manifest;
            expect(compactRes.archivedTriples).toBe(2); // intern + engineer
            expect(compactRes.deletedTriples).toBe(2);
            expect(compactRes.archivedTransactions).toBe(4);
            expect(compactRes.deletedTransactions).toBe(4);

            // Confirm hot SQLite no longer has the compacted journal row or retracted triple!
            expect(yield* hotTriples.transaction(tx1.txId)).toBeNull();
            expect(yield* hotTriples.assertion(aliceInternTriple.id)).toBeNull();

            // Write Tx 5 AFTER compaction (position 5 > W = 4)
            const tx5 = yield* hotTriples.transact(
              [
                {
                  op: "assert",
                  entityId: bob,
                  attribute: ":person/role",
                  value: { type: "string", value: "designer" },
                },
              ],
              { actor: "hr-bot", commandId: "cmd-role-bob" },
            );

            // Continue page 2 and page 3 using page1.nextCursor (recordedPosition = 4 <= W = 4)
            // -> MUST route seamlessly to federated DuckDB and finish the exact snapshot!
            routes.length = 0;
            // First verify a live cut (position 5 > W = 4, no recordedAt) makes ZERO calls to DuckDB!
            const syncBeforeLive = federatedSyncCalls;
            const liveFirstRes = yield* Effect.gen(function* () {
              const t = yield* Triples;
              return yield* t.queryAll({
                find: ["?r"],
                where: [[alice, ":person/role", "?r"]],
              });
            }).pipe(Effect.provide(tieredLayer));
            expect(liveFirstRes.results).toEqual([{ "?r": "staff" }]);
            expect(federatedSyncCalls).toBe(syncBeforeLive);
            expect(routes.map((r) => r.target)).toEqual(["hot"]);

            routes.length = 0;
            const { page2, page3, liveRes, histTx1, histTx2, txJoinRes } = yield* Effect.gen(
              function* () {
                const t = yield* Triples;
                const p2 = yield* t.query(pagedQuery, { pageSize: 2, cursor: page1.nextCursor });
                const p3 = yield* t.query(pagedQuery, { pageSize: 2, cursor: p2.nextCursor });

                // Live query at latest (position 5 > W = 4) -> MUST route 100% to hot!
                const live = yield* t.queryAll({
                  find: ["?r"],
                  where: [[alice, ":person/role", "?r"]],
                });

                // Historical queries at tx1 (pos 1 <= W) and tx2 (pos 2 <= W) -> federated!
                const h1 = yield* t.queryAll(
                  { find: ["?r"], where: [[alice, ":person/role", "?r"]] },
                  { basis: { recordedPosition: tx1.position } },
                );
                const h2 = yield* t.queryAll(
                  { find: ["?r"], where: [[alice, ":person/role", "?r"]] },
                  { basis: { recordedPosition: tx2.position } },
                );

                // :_tx/* query across compacted + hot transactions -> federated!
                const txJoin = yield* t.queryAll({
                  find: ["?actor"],
                  where: [["?tx", ":_tx/actor", "?actor"]],
                });

                return {
                  page2: p2,
                  page3: p3,
                  liveRes: live,
                  histTx1: h1,
                  histTx2: h2,
                  txJoinRes: txJoin,
                };
              },
            ).pipe(Effect.provide(tieredLayer));

            expect(page2.results.map((r) => r["?name"])).toEqual(["Carol", "Dave"]);
            expect(page2.nextCursor).toBeDefined();
            expect(page3.results.map((r) => r["?name"])).toEqual(["Eve"]);
            expect(page3.nextCursor).toBeUndefined();

            // Verify routing decisions:
            // [page2=federated, page3=federated, live=hot, h1=federated, h2=federated, txJoin=federated]
            expect(routes.map((r) => r.target)).toEqual([
              "federated",
              "federated",
              "hot",
              "federated",
              "federated",
              "federated",
            ]);

            expect(liveRes.results).toEqual([{ "?r": "staff" }]);
            expect(histTx1.results).toEqual(preRoleAtTx1.results);
            expect(histTx2.results).toEqual(preRoleAtTx2.results);
            expect(new Set(txJoinRes.results.map((r) => r["?actor"]))).toEqual(
              new Set(["hr-bot", "manager", "vp"]),
            );

            // Verify history, transaction, transactionByCommand, transactions, transactionsForEntity parity!
            const post = yield* Effect.gen(function* () {
              const t = yield* Triples;
              const historyAlice = yield* t.history(alice);
              const t1 = yield* t.transaction(tx1.txId);
              const t1ByCmd = yield* t.transactionByCommand("cmd-hire-1");
              const allTxs = yield* t.transactions({ after: 0, limit: 10 });
              const hotOnlyTxs = yield* t.transactions({ after: tx4.position, limit: 10 });
              const aliceTxs = yield* t.transactionsForEntity(alice);
              return { historyAlice, t1, t1ByCmd, allTxs, hotOnlyTxs, aliceTxs };
            }).pipe(Effect.provide(tieredLayer));

            expect(post.historyAlice).toEqual(preHistoryAlice);
            expect(post.t1).toEqual(preTx1);
            expect(post.t1ByCmd).toEqual(preTx1ByCmd);
            expect(post.allTxs.transactions.slice(0, 4)).toEqual(preAllTxs.transactions);
            expect(post.allTxs.transactions.length).toBe(5);
            expect(post.hotOnlyTxs.transactions.map((x) => x.txId)).toEqual([tx5.txId]);
            expect(post.aliceTxs.transactions).toEqual(preAliceTxs.transactions);

            // Verify Why.why parity across compacted facts & causation chain!
            const tieredWhyLayer = Why.Why.layer.pipe(
              Layer.provide(ConfigStore.layer.pipe(Layer.provide(tieredLayer))),
              Layer.provide(tieredLayer),
            );
            const { postWhyFact, postWhyEntityAtTx1 } = yield* Effect.gen(function* () {
              const whyService = yield* Why.Why;
              const wf = yield* whyService.why(
                { kind: "fact", tripleId: aliceInternTriple.id },
                {
                  basis: { recordedPosition: tx4.position, validAt: fixedValidAt },
                  causationDepth: 4,
                },
              );
              const we = yield* whyService.why(
                { kind: "entity", entityId: alice },
                {
                  basis: { recordedPosition: tx1.position, validAt: fixedValidAt },
                  causationDepth: 4,
                },
              );
              return { postWhyFact: wf, postWhyEntityAtTx1: we };
            }).pipe(Effect.provide(tieredWhyLayer));

            expect(postWhyFact).toEqual(preWhyFact);
            expect(postWhyEntityAtTx1).toEqual(preWhyEntityAtTx1);
            expect(tx3.position).toBe(3);
          }).pipe(Effect.provide(SqliteTriples.layerMemoryWithSqlClient)),
        ),
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// 3. Sensitive Values: Blind-Index Queries & Erasure Tombstones Across Tiers (§6)
// =============================================================================

describe("TieredTriples sensitive values across hot + cold (§6)", () => {
  it("preserves value_sealed/value_blind, blind-index Datalog queries, Sensitive.open, and cold erasure tombstones", async () => {
    const tmpDir = await makeTempDir();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const duck = yield* openDuckDbConnection();
            const hotTriples = yield* Triples;
            const sql = yield* SqlClient.SqlClient;
            const hotRunner = sqlClientToRunner(sql);
            const scope = "sqlite::memory:";

            let currentManifest: ColdManifest | null = null;
            const manifestStore = makeInMemoryColdManifestStore();
            const watermarkEffect = readColdWatermark(hotRunner, SqliteDialect, scope).pipe(
              Effect.mapError((cause) => new ReadError({ message: cause.message, cause })),
            );

            const refreshFederated = Effect.gen(function* () {
              yield* syncHotTablesToDuckDb(hotRunner, duck.runner, "hot_tier");
              yield* setupFederatedViews(duck.runner, {
                hot: { type: "schema", schema: "hot_tier" },
                cold: currentManifest ?? { triples: [], transactions: [], transactionEntities: [] },
              });
            });

            const tieredBase = TieredTriples.layer({
              federatedRunner: duck.runner,
              watermark: watermarkEffect,
              scope,
              beforeFederatedRead: refreshFederated,
            }).pipe(Layer.provide(Layer.succeed(Triples, hotTriples)));

            const sensitiveLayer = Sensitive.layer({
              database: "acme/tiered-test",
              attributes: [{ key: ":person/ssn", valueType: "string" }],
            }).pipe(
              Layer.provide(ValueCodec.aesGcm),
              Layer.provide(KeyProvider.test({ seed: "tiered-sensitive-test-seed" })),
              Layer.provideMerge(tieredBase),
            );

            const p1 = EntityId.make("person:s1");
            const p2 = EntityId.make("person:s2");

            const { oldTripleId, keyIdP1, tx1Pos } = yield* Effect.gen(function* () {
              const t = yield* Triples;
              const tx1 = yield* t.transact([
                {
                  op: "assert",
                  entityId: p1,
                  attribute: ":person/ssn",
                  value: { type: "string", value: "111-11-1111" },
                },
                {
                  op: "assert",
                  entityId: p2,
                  attribute: ":person/ssn",
                  value: { type: "string", value: "222-22-2222" },
                },
              ]);
              const oldTriple = tx1.triples[0]!;
              expect(oldTriple.value.type).toBe("sealed");
              const keyId = oldTriple.value.type === "sealed" ? oldTriple.value.keyId : "";

              // Retract p1's old SSN and assert a new one
              yield* t.transact([
                { op: "retract", id: oldTriple.id },
                {
                  op: "assert",
                  entityId: p1,
                  attribute: ":person/ssn",
                  value: { type: "string", value: "999-99-9999" },
                },
              ]);

              return { oldTripleId: oldTriple.id, keyIdP1: keyId, tx1Pos: tx1.position };
            }).pipe(Effect.provide(sensitiveLayer));

            // Compact retracted SSN (tx2 pos = 2) to cold Parquet!
            const compactor = makeParquetCompactor({
              databaseScope: scope,
              hotRunner,
              dialect: SqliteDialect,
              manifestStore,
              outputDir: tmpDir,
            });
            const compactRes = yield* compactor.compact({ targetWatermark: 2 });
            currentManifest = compactRes.manifest;
            expect(compactRes.archivedTriples).toBe(1);
            expect(compactRes.deletedTriples).toBe(1);

            // Verify Parquet file stores ONLY value_sealed/value_blind and never plaintext!
            const parquetPath = currentManifest.segments.triples[0]!.path;
            const coldRaw = yield* duck.runner.run<{
              value_type: string;
              value_string: string | null;
              value_sealed: string | null;
              value_blind: string | null;
            }>(
              `SELECT value_type, value_string, value_sealed, value_blind FROM read_parquet('${parquetPath.replace(/'/g, "''")}')`,
              [],
            );
            expect(coldRaw.length).toBe(1);
            expect(coldRaw[0]!.value_type).toBe("sealed");
            expect(coldRaw[0]!.value_string).toBeNull();
            expect(coldRaw[0]!.value_sealed).not.toBeNull();
            expect(coldRaw[0]!.value_sealed).not.toContain("111-11-1111");
            expect(coldRaw[0]!.value_blind).not.toBeNull();

            // Query blind-index equality at historical cut (tx1Pos = 1 <= W = 2) -> federated DuckDB!
            // AND query live blind-index equality -> hot SQL!
            // AND open sealed value from cold history via Sensitive.open!
            const { histMatch, liveMatch, openedOld } = yield* Effect.gen(function* () {
              const t = yield* Triples;
              const h = yield* t.queryAll(
                { find: ["?e"], where: [["?e", ":person/ssn", "111-11-1111"]] },
                { basis: { recordedPosition: tx1Pos } },
              );
              const l = yield* t.queryAll({
                find: ["?e"],
                where: [["?e", ":person/ssn", "222-22-2222"]],
              });
              const oldFact = yield* t.assertion(oldTripleId);
              expect(oldFact).not.toBeNull();
              expect(Option.isSome(oldFact!.retractedAt)).toBe(true);
              const opened = yield* Sensitive.open(oldFact!);
              return { histMatch: h.results, liveMatch: l.results, openedOld: opened.value };
            }).pipe(Effect.provide(sensitiveLayer));

            expect(histMatch).toEqual([{ "?e": p1 }]);
            expect(liveMatch).toEqual([{ "?e": p2 }]);
            expect(openedOld).toEqual({ type: "string", value: "111-11-1111" });

            // Now record erasure tombstone for p1's keyId -> cold blind token is immediately masked
            // without rewriting the Parquet file!
            yield* recordColdErasedKeys(duck.runner, [keyIdP1]);
            const afterErase = yield* Effect.gen(function* () {
              const t = yield* Triples;
              return yield* t.queryAll(
                { find: ["?e"], where: [["?e", ":person/ssn", "111-11-1111"]] },
                { basis: { recordedPosition: tx1Pos } },
              );
            }).pipe(Effect.provide(sensitiveLayer));

            expect(afterErase.results).toEqual([]);

            // Subject p2 (different keyId) is unaffected!
            const p2StillMatches = yield* Effect.gen(function* () {
              const t = yield* Triples;
              return yield* t.queryAll(
                { find: ["?e"], where: [["?e", ":person/ssn", "222-22-2222"]] },
                { basis: { recordedPosition: tx1Pos } },
              );
            }).pipe(Effect.provide(sensitiveLayer));
            expect(p2StillMatches.results).toEqual([{ "?e": p2 }]);

            // Unused type import guard check
            const _txCheck: TransactionId | undefined = undefined;
            expect(_txCheck).toBeUndefined();
          }).pipe(Effect.provide(SqliteTriples.layerMemoryWithSqlClient)),
        ),
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
