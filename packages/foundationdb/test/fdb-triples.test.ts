/**
 * Integration tests: FoundationDB → Hexastore → Triples.
 *
 * Uses Testcontainers to spin up a real FDB instance. Tests the full stack:
 * FdbKvBackend → KvTripleStore → KvTriplesLive
 *
 * Requires Docker + FoundationDB client libraries to be available.
 *
 * ```bash
 * pnpm test --filter @triplex-build/triplex-foundationdb -- test/fdb-triples.test.ts
 * ```
 */

import { Effect, Layer } from "effect";
import { describe, expect, layer } from "@effect/vitest";
import { createRequire } from "node:module";
import { Triples } from "@triplex-build/triplex";
import { KvTriplesLive, TripleStoreRuntimeLayer } from "@triplex-build/triplex/internal";
import { FdbTestLayer } from "./fixtures/FdbTestLayer.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

const str = (value: string) => ({ type: "string" as const, value });
const num = (value: number) => ({ type: "number" as const, value });
const refVal = (value: string) => ({ type: "ref" as const, value });
const require = createRequire(import.meta.url);
const fdbAvailable = (() => {
  try {
    require("foundationdb");
    return true;
  } catch {
    return false;
  }
})();

// ─── Full-stack layer: FDB → KvBackend → Triples ──────────────────────────

const FdbTriplesLayer = KvTriplesLive.pipe(
  Layer.provide(TripleStoreRuntimeLayer),
  Layer.provide(FdbTestLayer),
);

const describeFdb = fdbAvailable
  ? layer(FdbTriplesLayer, { timeout: "60 seconds" })
  : (name: string, _fn: () => void) => describe.skip(name, () => {});

// ─── Tests ─────────────────────────────────────────────────────────────────

describeFdb("FDB Integration: Triples", (it) => {
  // ── Triples CRUD ────────────────────────────────────────────────────────

  it.effect("asserts and retrieves a single triple", () =>
    Effect.gen(function* () {
      const store = yield* Triples;

      const triple = yield* store.assert({
        entityId: "emp:alice",
        attribute: ":employee/name",
        value: str("Alice"),
      });

      expect(triple.entityId).toBe("emp:alice");
      expect(triple.attribute).toBe(":employee/name");
      expect(triple.value).toEqual(str("Alice"));
    }),
  );

  it.effect("batch asserts multiple triples", () =>
    Effect.gen(function* () {
      const store = yield* Triples;

      const triples = yield* store.assertBatch([
        { entityId: "emp:batch-a", attribute: ":employee/name", value: str("Alice") },
        { entityId: "emp:batch-a", attribute: ":employee/age", value: num(30) },
        { entityId: "emp:batch-b", attribute: ":employee/name", value: str("Bob") },
        { entityId: "emp:batch-b", attribute: ":employee/age", value: num(25) },
      ]);

      expect(triples).toHaveLength(4);
    }),
  );

  it.effect("queries by entity", () =>
    Effect.gen(function* () {
      const store = yield* Triples;

      yield* store.assertBatch([
        { entityId: "emp:qe-alice", attribute: ":employee/name", value: str("Alice") },
        { entityId: "emp:qe-alice", attribute: ":employee/age", value: num(30) },
        { entityId: "emp:qe-bob", attribute: ":employee/name", value: str("Bob") },
      ]);

      const aliceTriples = yield* store.entity("emp:qe-alice" as any);
      expect(aliceTriples).toHaveLength(2);
      expect(aliceTriples.map((t) => t.attribute).sort()).toEqual([
        ":employee/age",
        ":employee/name",
      ]);
    }),
  );

  it.effect("queries by pattern", () =>
    Effect.gen(function* () {
      const store = yield* Triples;

      yield* store.assertBatch([
        { entityId: "emp:qp-alice", attribute: ":employee/name", value: str("Alice") },
        { entityId: "emp:qp-bob", attribute: ":employee/name", value: str("Bob") },
        { entityId: "emp:qp-alice", attribute: ":employee/age", value: num(30) },
      ]);

      const names = yield* store.match({ attribute: ":employee/name" });
      // Should find at least the 2 we just inserted (may see more from shared subspace)
      expect(names.length).toBeGreaterThanOrEqual(2);
    }),
  );

  it.effect("retracts a triple so it is no longer query-visible", () =>
    Effect.gen(function* () {
      const store = yield* Triples;

      const triple = yield* store.assert({
        entityId: "emp:retract-test",
        attribute: ":employee/name",
        value: str("Alice"),
      });

      yield* store.retract(triple.id);

      const result = yield* store.match({
        entityId: "emp:retract-test",
        attribute: ":employee/name",
      });
      expect(result).toHaveLength(0);
    }),
  );

  it.effect("transact applies multiple ops atomically", () =>
    Effect.gen(function* () {
      const store = yield* Triples;

      const result = yield* store.transact([
        {
          op: "assert",
          entityId: "emp:tx-carol",
          attribute: ":employee/name",
          value: str("Carol"),
        },
        {
          op: "assert",
          entityId: "emp:tx-carol",
          attribute: ":employee/age",
          value: num(28),
        },
      ]);

      expect(result.triples).toHaveLength(2);

      const entity = yield* store.entity("emp:tx-carol" as any);
      expect(entity).toHaveLength(2);
    }),
  );

  // ── Datalog Queries ─────────────────────────────────────────────────────

  it.effect("executes a simple Datalog query", () =>
    Effect.gen(function* () {
      const store = yield* Triples;
      const datalog = yield* Triples;

      yield* store.assertBatch([
        { entityId: "emp:dl-alice", attribute: ":emp/name", value: str("Alice") },
        { entityId: "emp:dl-bob", attribute: ":emp/name", value: str("Bob") },
      ]);

      const result = yield* datalog.query({
        find: ["?name"],
        where: [["?e", ":emp/name", "?name"]],
      });

      const names = result.results.map((r) => r["?name"]).sort();
      expect(names).toContain("Alice");
      expect(names).toContain("Bob");
    }),
  );

  it.effect("executes a multi-pattern join query", () =>
    Effect.gen(function* () {
      const store = yield* Triples;
      const datalog = yield* Triples;

      yield* store.assertBatch([
        { entityId: "emp:join-alice", attribute: ":person/name", value: str("Alice") },
        { entityId: "emp:join-alice", attribute: ":person/age", value: num(30) },
        { entityId: "emp:join-bob", attribute: ":person/name", value: str("Bob") },
        { entityId: "emp:join-bob", attribute: ":person/age", value: num(25) },
      ]);

      const result = yield* datalog.query({
        find: ["?name", "?age"],
        where: [
          ["?e", ":person/name", "?name"],
          ["?e", ":person/age", "?age"],
        ],
      });

      expect(result.results.length).toBeGreaterThanOrEqual(2);
      const alice = result.results.find((r) => r["?name"] === "Alice");
      expect(alice?.["?age"]).toBe(30);
    }),
  );

  it.effect("handles reference-based joins", () =>
    Effect.gen(function* () {
      const store = yield* Triples;
      const datalog = yield* Triples;

      yield* store.assertBatch([
        { entityId: "dept:ref-eng", attribute: ":dept/name", value: str("Engineering") },
        { entityId: "emp:ref-alice", attribute: ":employee/name", value: str("Alice") },
        {
          entityId: "emp:ref-alice",
          attribute: ":employee/dept",
          value: refVal("dept:ref-eng"),
        },
      ]);

      const result = yield* datalog.query({
        find: ["?empName", "?deptName"],
        where: [
          ["?emp", ":employee/name", "?empName"],
          ["?emp", ":employee/dept", "?dept"],
          ["?dept", ":dept/name", "?deptName"],
        ],
      });

      expect(result.results.length).toBeGreaterThanOrEqual(1);
      const aliceRow = result.results.find((r) => r["?empName"] === "Alice");
      expect(aliceRow?.["?deptName"]).toBe("Engineering");
    }),
  );

  it.effect("supports predicate filters", () =>
    Effect.gen(function* () {
      const store = yield* Triples;
      const datalog = yield* Triples;

      yield* store.assertBatch([
        { entityId: "emp:pred-alice", attribute: ":person/name", value: str("Alice") },
        { entityId: "emp:pred-alice", attribute: ":person/age", value: num(30) },
        { entityId: "emp:pred-bob", attribute: ":person/name", value: str("Bob") },
        { entityId: "emp:pred-bob", attribute: ":person/age", value: num(25) },
        { entityId: "emp:pred-carol", attribute: ":person/name", value: str("Carol") },
        { entityId: "emp:pred-carol", attribute: ":person/age", value: num(35) },
      ]);

      const result = yield* datalog.query({
        find: ["?name"],
        where: [
          ["?e", ":person/name", "?name"],
          ["?e", ":person/age", "?age"],
          [">=", "?age", 30],
        ],
      });

      const names = result.results.map((r) => r["?name"]).sort();
      expect(names).toContain("Alice");
      expect(names).toContain("Carol");
      expect(names).not.toContain("Bob");
    }),
  );
});
