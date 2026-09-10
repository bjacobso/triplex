/**
 * Triple-level tests for the KV-backed Triples service.
 *
 * These tests verify the KV-backed triple store works correctly when accessed
 * through the standard Triples API that the rest of the system uses.
 */

import { describe, it, expect } from "vitest";
import { Effect, Layer, Option } from "effect";
import { Triples } from "../../../src/store/Triples.js";
import type { TripleId, EntityId } from "@triplex-build/triplex";
import { KvTriplesLive } from "../../../src/kv/layers/KvTriplesLive.js";
import { KvBackend } from "../../../src/kv/kv/KvBackend.js";
import { makeTestKvBackend } from "../../../src/kv/kv/InMemoryKvBackend.js";
import { TripleStoreRuntimeLayer } from "../../../src/store/TripleStoreRuntime.js";

// ─── Test setup ────────────────────────────────────────────────────────────

// Fresh layer per test to ensure isolation: Layer.effect creates a new
// InMemoryKvBackend instance for each layer instantiation.
const makeTestLayer = () =>
  KvTriplesLive.pipe(
    Layer.provide(TripleStoreRuntimeLayer),
    Layer.provide(
      Layer.effect(
        KvBackend,
        Effect.sync(() => makeTestKvBackend()),
      ),
    ),
  );

const runTest = <A, E>(effect: Effect.Effect<A, E, Triples>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, makeTestLayer()));

// ─── String helpers (create TripleValue objects) ───────────────────────────

const str = (value: string) => ({ type: "string" as const, value });
const num = (value: number) => ({ type: "number" as const, value });
const bool = (value: boolean) => ({ type: "boolean" as const, value });
const refVal = (value: string) => ({ type: "ref" as const, value });

// ─── Assert ────────────────────────────────────────────────────────────────

describe("KvTriplesLive - assert", () => {
  it("creates a triple and returns it with a generated ID", async () => {
    await runTest(
      Effect.gen(function* () {
        const store = yield* Triples;
        const triple = yield* store.assert({
          entityId: "person:1",
          attribute: ":person/name",
          value: str("Alice"),
          entityType: "Person",
        });

        expect(triple.id).toBeDefined();
        expect(triple.entityId).toBe("person:1");
        expect(triple.attribute).toBe(":person/name");
        expect(triple.value).toEqual(str("Alice"));
        expect(Option.isSome(triple.entityType)).toBe(true);
        expect(Option.getOrNull(triple.entityType)).toBe("Person");
        expect(Option.isNone(triple.retractedAt)).toBe(true);
      }),
    );
  });

  it("assigns unique IDs to each triple", async () => {
    await runTest(
      Effect.gen(function* () {
        const store = yield* Triples;
        const t1 = yield* store.assert({ entityId: "e:1", attribute: ":a", value: str("v1") });
        const t2 = yield* store.assert({ entityId: "e:2", attribute: ":a", value: str("v2") });

        expect(t1.id).not.toBe(t2.id);
      }),
    );
  });
});

// ─── AssertBatch ───────────────────────────────────────────────────────────

describe("KvTriplesLive - assertBatch", () => {
  it("inserts multiple triples in one call", async () => {
    await runTest(
      Effect.gen(function* () {
        const store = yield* Triples;
        const triples = yield* store.assertBatch([
          { entityId: "p:alice", attribute: ":name", value: str("Alice") },
          { entityId: "p:bob", attribute: ":name", value: str("Bob") },
          { entityId: "p:alice", attribute: ":age", value: num(30) },
        ]);

        expect(triples.length).toBe(3);
        // All share the same txId
        const txIds = new Set(triples.map((t) => Option.getOrNull(t.txId)));
        expect(txIds.size).toBe(1);
      }),
    );
  });
});

// ─── GetTriple ─────────────────────────────────────────────────────────────

describe("KvTriplesLive - getTriple", () => {
  it("retrieves a triple by ID", async () => {
    await runTest(
      Effect.gen(function* () {
        const store = yield* Triples;
        const created = yield* store.assert({
          entityId: "e:1",
          attribute: ":attr",
          value: str("val"),
        });

        const retrieved = yield* store.get(created.id);
        expect(retrieved).not.toBeNull();
        expect(retrieved!.id).toBe(created.id);
        expect(retrieved!.value).toEqual(str("val"));
      }),
    );
  });

  it("returns null for non-existent ID", async () => {
    await runTest(
      Effect.gen(function* () {
        const store = yield* Triples;
        const result = yield* store.get("01NONEXISTENT000000000000" as TripleId);
        expect(result).toBeNull();
      }),
    );
  });
});

// ─── Retract ───────────────────────────────────────────────────────────────

describe("KvTriplesLive - retract", () => {
  it("retracts a triple", async () => {
    await runTest(
      Effect.gen(function* () {
        const store = yield* Triples;
        const triple = yield* store.assert({
          entityId: "e:1",
          attribute: ":a",
          value: str("v"),
        });

        yield* store.retract(triple.id);

        const after = yield* store.get(triple.id);
        expect(after).not.toBeNull();
        expect(Option.isSome(after!.retractedAt)).toBe(true);
      }),
    );
  });

  it("retracted triples are excluded from query results", async () => {
    await runTest(
      Effect.gen(function* () {
        const store = yield* Triples;
        const t1 = yield* store.assert({
          entityId: "e:1",
          attribute: ":name",
          value: str("Alice"),
        });
        yield* store.assert({ entityId: "e:1", attribute: ":age", value: num(30) });

        yield* store.retract(t1.id);

        const results = yield* store.entity("e:1" as EntityId);
        expect(results.length).toBe(1);
        expect(results[0]!.attribute).toBe(":age");
      }),
    );
  });
});

// ─── RetractByPattern ──────────────────────────────────────────────────────

describe("KvTriplesLive - retractByPattern", () => {
  it("retracts all matching triples and returns count", async () => {
    await runTest(
      Effect.gen(function* () {
        const store = yield* Triples;
        yield* store.assertBatch([
          { entityId: "e:1", attribute: ":name", value: str("Alice") },
          { entityId: "e:1", attribute: ":age", value: num(30) },
          { entityId: "e:2", attribute: ":name", value: str("Bob") },
        ]);

        const count = yield* store.retractByPattern({ entityId: "e:1" });
        expect(count).toBe(2);

        const remaining = (yield* store.match({})).filter(
          (triple) => !triple.entityId.startsWith("_tx/"),
        );
        expect(remaining.length).toBe(1);
        expect(remaining[0]!.entityId).toBe("e:2");
      }),
    );
  });
});

// ─── Query ─────────────────────────────────────────────────────────────────

describe("KvTriplesLive - query", () => {
  it("queries by entity", async () => {
    await runTest(
      Effect.gen(function* () {
        const store = yield* Triples;
        yield* store.assertBatch([
          { entityId: "e:1", attribute: ":name", value: str("Alice") },
          { entityId: "e:1", attribute: ":age", value: num(30) },
          { entityId: "e:2", attribute: ":name", value: str("Bob") },
        ]);

        const results = yield* store.match({ entityId: "e:1" });
        expect(results.length).toBe(2);
        expect(results.every((t) => t.entityId === "e:1")).toBe(true);
      }),
    );
  });

  it("queries by attribute", async () => {
    await runTest(
      Effect.gen(function* () {
        const store = yield* Triples;
        yield* store.assertBatch([
          { entityId: "e:1", attribute: ":name", value: str("Alice") },
          { entityId: "e:2", attribute: ":name", value: str("Bob") },
          { entityId: "e:1", attribute: ":age", value: num(30) },
        ]);

        const results = yield* store.match({ attribute: ":name" });
        expect(results.length).toBe(2);
      }),
    );
  });

  it("queries with empty pattern returns all", async () => {
    await runTest(
      Effect.gen(function* () {
        const store = yield* Triples;
        yield* store.assertBatch([
          { entityId: "e:1", attribute: ":name", value: str("Alice") },
          { entityId: "e:2", attribute: ":name", value: str("Bob") },
        ]);

        const results = (yield* store.match({})).filter(
          (triple) => !triple.entityId.startsWith("_tx/"),
        );
        expect(results.length).toBe(2);
      }),
    );
  });
});

// ─── GetEntity ─────────────────────────────────────────────────────────────

describe("KvTriplesLive - getEntity", () => {
  it("returns all active triples for an entity", async () => {
    await runTest(
      Effect.gen(function* () {
        const store = yield* Triples;
        yield* store.assertBatch([
          { entityId: "e:1", attribute: ":name", value: str("Alice") },
          { entityId: "e:1", attribute: ":age", value: num(30) },
          { entityId: "e:1", attribute: ":active", value: bool(true) },
          { entityId: "e:2", attribute: ":name", value: str("Bob") },
        ]);

        const results = yield* store.entity("e:1" as EntityId);
        expect(results.length).toBe(3);
        expect(results.every((t) => t.entityId === "e:1")).toBe(true);
      }),
    );
  });
});

// ─── Transact ──────────────────────────────────────────────────────────────

describe("KvTriplesLive - transact", () => {
  it("processes assert and retract operations atomically", async () => {
    await runTest(
      Effect.gen(function* () {
        const store = yield* Triples;
        const existing = yield* store.assert({
          entityId: "e:1",
          attribute: ":name",
          value: str("Alice"),
        });

        const result = yield* store.transact([
          { op: "retract", id: existing.id },
          { op: "assert", entityId: "e:1", attribute: ":name", value: str("Alice Smith") },
          { op: "assert", entityId: "e:2", attribute: ":name", value: str("Bob") },
        ]);

        expect(result.txId).toBeDefined();
        expect(result.triples.length).toBe(2);
        expect(result.retracted).toBe(1);

        // Verify state
        const entity = yield* store.entity("e:1" as EntityId);
        expect(entity.length).toBe(1);
        expect(entity[0]!.value).toEqual(str("Alice Smith"));
      }),
    );
  });
});

// ─── Temporal matching ─────────────────────────────────────────────────────

describe("KvTriplesLive - temporal match", () => {
  it("returns triples active at a point in time", async () => {
    await runTest(
      Effect.gen(function* () {
        const store = yield* Triples;

        // Assert a triple
        const triple = yield* store.assert({
          entityId: "e:1",
          attribute: ":name",
          value: str("Alice"),
        });

        const afterAssert = Date.now();
        // Small delay to ensure timestamps differ
        yield* Effect.sleep("10 millis");

        // Retract it
        yield* store.retract(triple.id);

        // Query at time before retraction — should see the triple
        const beforeRetract = yield* store.match(
          { entityId: "e:1" },
          { recordedAt: afterAssert, validAt: afterAssert },
        );
        expect(beforeRetract.length).toBe(1);

        // Query at current time — should not see the triple
        const now = Date.now();
        const afterRetract = yield* store.match(
          { entityId: "e:1" },
          { recordedAt: now, validAt: now },
        );
        expect(afterRetract.length).toBe(0);
      }),
    );
  });
});

// ─── History ───────────────────────────────────────────────────────────────

describe("KvTriplesLive - history", () => {
  it("returns all triples including retracted", async () => {
    await runTest(
      Effect.gen(function* () {
        const store = yield* Triples;

        const t1 = yield* store.assert({
          entityId: "e:1",
          attribute: ":name",
          value: str("Alice"),
        });
        yield* store.retract(t1.id);
        yield* store.assert({ entityId: "e:1", attribute: ":name", value: str("Alice Smith") });

        const history = yield* store.history("e:1" as EntityId);
        expect(history.length).toBe(2);
        expect(history.some((t) => Option.isSome(t.retractedAt))).toBe(true);
        expect(history.some((t) => Option.isNone(t.retractedAt))).toBe(true);
      }),
    );
  });
});

// ─── Value types ───────────────────────────────────────────────────────────

describe("KvTriplesLive - value types", () => {
  it("stores and retrieves all value types", async () => {
    await runTest(
      Effect.gen(function* () {
        const store = yield* Triples;
        const inputs = [
          { entityId: "e:1", attribute: ":str", value: str("hello") },
          { entityId: "e:1", attribute: ":num", value: num(42.5) },
          { entityId: "e:1", attribute: ":bool", value: bool(true) },
          { entityId: "e:1", attribute: ":ref", value: refVal("other:1") },
          {
            entityId: "e:1",
            attribute: ":dt",
            value: { type: "datetime" as const, value: 1700000000000 },
          },
          {
            entityId: "e:1",
            attribute: ":json",
            value: { type: "json" as const, value: { key: "val" } },
          },
        ];

        const triples = yield* store.assertBatch(inputs);
        expect(triples.length).toBe(6);

        const entity = yield* store.entity("e:1" as EntityId);
        expect(entity.length).toBe(6);

        // Verify each type roundtrips
        const byAttr = Object.fromEntries(entity.map((t) => [t.attribute, t.value]));
        expect(byAttr[":str"]).toEqual(str("hello"));
        expect(byAttr[":num"]).toEqual(num(42.5));
        expect(byAttr[":bool"]).toEqual(bool(true));
        expect(byAttr[":ref"]).toEqual(refVal("other:1"));
        expect(byAttr[":dt"]).toEqual({ type: "datetime", value: 1700000000000 });
        expect(byAttr[":json"]).toEqual({ type: "json", value: { key: "val" } });
      }),
    );
  });
});
