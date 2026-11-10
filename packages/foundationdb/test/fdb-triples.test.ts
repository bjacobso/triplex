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

import { Context, Effect, Layer, Stream } from "effect";
import { describe, expect, layer } from "@effect/vitest";
import { createRequire } from "node:module";
import {
  EntityId,
  KvTriples,
  Triples,
  string as str,
  number as num,
  ref,
} from "@triplex-build/triplex";
import { KvBackend, KvTriplesLive, TripleStoreRuntimeLayer } from "@triplex-build/triplex/internal";
import { FdbTestLayer } from "./fixtures/FdbTestLayer.js";
import { FdbClusterFile } from "./fixtures/FdbTestLayer.js";
import { FdbTriples } from "../src/index.js";
import { Outbox } from "@triplex-build/triplex/operational";
import {
  makeTriplesConformanceSuite,
  makeSealedStorageSuite,
  makeSensitiveConformanceSuite,
  sensitiveConformanceLayer,
  findPlaintext,
} from "@triplex-build/triplex-testkit";

// ─── Helpers ───────────────────────────────────────────────────────────────

const refVal = (value: string) => ref(EntityId.make(value));
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
  Layer.provideMerge(FdbTestLayer),
);

// ─── Tests ─────────────────────────────────────────────────────────────────

const nativeSuite = layer(FdbTriplesLayer, { timeout: "60 seconds", excludeTestServices: true });
const describeFdb: typeof nativeSuite = fdbAvailable
  ? nativeSuite
  : (name: unknown) =>
      describe.skip(typeof name === "string" ? name : "FoundationDB native suite", () => {});

describeFdb("FDB Integration: Triples", (it) => {
  it.effect(
    "passes the shared transaction, temporal, operational and query contract",
    () => makeTriplesConformanceSuite(),
    120000,
  );

  it.effect("passes the sealed-storage engine contract", () => makeSealedStorageSuite(), 120000);

  it.effect(
    "passes sensitive and full Triples conformance in a fresh subspace",
    () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(Layer.fresh(FdbTriplesLayer));
        const raw = Context.get(context, Triples);
        const kv = Context.get(context, KvBackend);
        yield* makeSensitiveConformanceSuite().pipe(
          Effect.andThen(makeTriplesConformanceSuite()),
          Effect.provide(sensitiveConformanceLayer(Layer.succeed(Triples, raw))),
        );
        const entries = yield* Stream.runCollect(
          kv.getRange({ start: new Uint8Array(), end: new Uint8Array([255]) }),
        );
        const dump = entries
          .map(
            ([key, value]) =>
              Buffer.from(key).toString("utf8") + "\n" + Buffer.from(value).toString("utf8"),
          )
          .join("\n");
        expect(entries.length).toBeGreaterThan(0);
        expect(findPlaintext(dump, "Grace").length).toBeGreaterThan(0);
        expect(findPlaintext(dump)).toEqual([]);
      }),
    120000,
  );

  it.effect(
    "rejects an operational cursor from a foreign subspace",
    () =>
      Effect.gen(function* () {
        const { clusterFilePath } = yield* FdbClusterFile;
        const namespace = `__cursor_${crypto.randomUUID()}/`;
        const a = Layer.fresh(
          FdbTriples.layer({
            clusterFile: clusterFilePath,
            subspace: Buffer.from(namespace + "a/"),
          }),
        );
        const b = Layer.fresh(
          FdbTriples.layer({
            clusterFile: clusterFilePath,
            subspace: Buffer.from(namespace + "b/"),
          }),
        );
        const scope = EntityId.make("cursor:home");
        const cursor = yield* Effect.gen(function* () {
          const t = yield* Triples;
          yield* t.transact([
            Outbox.append({ scope, idempotencyKey: "a", payload: 1 }),
            Outbox.append({ scope, idempotencyKey: "b", payload: 2 }),
          ]);
          return (yield* Outbox.pending(t, { limit: 1 })).nextCursor!;
        }).pipe(Effect.provide(a));
        const error = yield* Effect.gen(function* () {
          const t = yield* Triples;
          expect((yield* Outbox.pending(t, {})).entries).toEqual([]);
          return yield* Outbox.pending(t, { cursor }).pipe(Effect.flip);
        }).pipe(Effect.provide(b));
        expect(error).toMatchObject({ _tag: "PaginationCursorError" });
      }),
    30000,
  );

  it.effect(
    "resumes the legacy live-index backfill on native transactions",
    () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(Layer.fresh(FdbTriplesLayer));
        const t = Context.get(context, Triples),
          kv = Context.get(context, KvBackend);
        const entityId = EntityId.make("native:legacy");
        const first = yield* t.assert({ entityId, attribute: ":native/value", value: num(1) });
        // Reproduce the pre-live-index durable format without importing core source.
        const live = yield* Stream.runCollect(
          kv.getRange({ start: new Uint8Array([6]), end: new Uint8Array([7]) }),
        );
        yield* kv.transact((tx) =>
          Effect.gen(function* () {
            for (const [key] of live) yield* tx.delete(key);
            yield* tx.delete(new Uint8Array([0x26, 0x01]));
          }),
        );
        const unavailable = yield* t
          .transact([], {
            preconditions: [{ _tag: "AttributeAbsent", entityId, attribute: ":missing" }],
          })
          .pipe(Effect.flip);
        expect(unavailable.message).toContain("migrateLiveFacts");
        const migrate = () =>
          KvTriples.migrateLiveFacts({ batchSize: 1 }).pipe(Effect.provideService(KvBackend, kv));
        expect((yield* migrate()).complete).toBe(false);
        yield* t.retract(first.id);
        yield* t.assert({ entityId, attribute: ":native/value", value: num(2) });
        let done = false;
        for (let batch = 0; batch < 100 && !done; batch++) done = (yield* migrate()).complete;
        expect(done).toBe(true);
        yield* t.transact([], {
          preconditions: [
            { _tag: "AttributeValue", entityId, attribute: ":native/value", value: num(2) },
          ],
        });
        expect(yield* migrate()).toEqual({ complete: true, processed: 0 });
      }),
    30000,
  );
  // ── Triples CRUD ────────────────────────────────────────────────────────

  it.effect("asserts and retrieves a single triple", () =>
    Effect.gen(function* () {
      const store = yield* Triples;

      const triple = yield* store.assert({
        entityId: EntityId.make("emp:alice"),
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
        {
          entityId: EntityId.make("emp:batch-a"),
          attribute: ":employee/name",
          value: str("Alice"),
        },
        { entityId: EntityId.make("emp:batch-a"), attribute: ":employee/age", value: num(30) },
        {
          entityId: EntityId.make("emp:batch-b"),
          attribute: ":employee/name",
          value: str("Bob"),
        },
        { entityId: EntityId.make("emp:batch-b"), attribute: ":employee/age", value: num(25) },
      ]);

      expect(triples).toHaveLength(4);
    }),
  );

  it.effect("queries by entity", () =>
    Effect.gen(function* () {
      const store = yield* Triples;

      yield* store.assertBatch([
        {
          entityId: EntityId.make("emp:qe-alice"),
          attribute: ":employee/name",
          value: str("Alice"),
        },
        { entityId: EntityId.make("emp:qe-alice"), attribute: ":employee/age", value: num(30) },
        { entityId: EntityId.make("emp:qe-bob"), attribute: ":employee/name", value: str("Bob") },
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
        {
          entityId: EntityId.make("emp:qp-alice"),
          attribute: ":employee/name",
          value: str("Alice"),
        },
        { entityId: EntityId.make("emp:qp-bob"), attribute: ":employee/name", value: str("Bob") },
        { entityId: EntityId.make("emp:qp-alice"), attribute: ":employee/age", value: num(30) },
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
        entityId: EntityId.make("emp:retract-test"),
        attribute: ":employee/name",
        value: str("Alice"),
      });

      yield* store.retract(triple.id);

      const result = yield* store.match({
        entityId: EntityId.make("emp:retract-test"),
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
          entityId: EntityId.make("emp:tx-carol"),
          attribute: ":employee/name",
          value: str("Carol"),
        },
        {
          op: "assert",
          entityId: EntityId.make("emp:tx-carol"),
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
        { entityId: EntityId.make("emp:dl-alice"), attribute: ":emp/name", value: str("Alice") },
        { entityId: EntityId.make("emp:dl-bob"), attribute: ":emp/name", value: str("Bob") },
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
        {
          entityId: EntityId.make("emp:join-alice"),
          attribute: ":person/name",
          value: str("Alice"),
        },
        { entityId: EntityId.make("emp:join-alice"), attribute: ":person/age", value: num(30) },
        { entityId: EntityId.make("emp:join-bob"), attribute: ":person/name", value: str("Bob") },
        { entityId: EntityId.make("emp:join-bob"), attribute: ":person/age", value: num(25) },
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
        {
          entityId: EntityId.make("dept:ref-eng"),
          attribute: ":dept/name",
          value: str("Engineering"),
        },
        {
          entityId: EntityId.make("emp:ref-alice"),
          attribute: ":employee/name",
          value: str("Alice"),
        },
        {
          entityId: EntityId.make("emp:ref-alice"),
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
        {
          entityId: EntityId.make("emp:pred-alice"),
          attribute: ":person/name",
          value: str("Alice"),
        },
        { entityId: EntityId.make("emp:pred-alice"), attribute: ":person/age", value: num(30) },
        { entityId: EntityId.make("emp:pred-bob"), attribute: ":person/name", value: str("Bob") },
        { entityId: EntityId.make("emp:pred-bob"), attribute: ":person/age", value: num(25) },
        {
          entityId: EntityId.make("emp:pred-carol"),
          attribute: ":person/name",
          value: str("Carol"),
        },
        { entityId: EntityId.make("emp:pred-carol"), attribute: ":person/age", value: num(35) },
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
