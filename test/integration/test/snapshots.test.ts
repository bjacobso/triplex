import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import {
  Triples,
  SnapshotService,
  SnapshotWriter,
  SnapshotServiceLive,
  SnapshotWriterLive,
  string,
  number,
  canonicalize,
  hashCanonical,
  triplesToAttributeMap,
  diffAttributes,
  EMPTY_ENTITY_HASH,
} from "@triplex-build/triplex/internal";
import { EntityId, TransactionId } from "@triplex-build/triplex";
import { SqliteTestLayer } from "./fixtures/SqliteTestLayer.js";

const eid = EntityId.make;

// ---------------------------------------------------------------------------
// Test layer: Triples + SnapshotService + SnapshotWriter, all in-memory
// ---------------------------------------------------------------------------

const SnapshotTestLayer = SnapshotServiceLive.pipe(
  Layer.provideMerge(SnapshotWriterLive),
  Layer.provideMerge(SqliteTestLayer),
);

// ---------------------------------------------------------------------------
// Pure canonical functions
// ---------------------------------------------------------------------------

describe("canonical", () => {
  describe("canonicalize", () => {
    it("should produce deterministic output for sorted keys", () => {
      const attrs = {
        ":person/name": { type: "string" as const, value: "Alice" },
        ":person/age": { type: "number" as const, value: 30 },
      };
      const result = canonicalize(attrs);
      const parsed = JSON.parse(result);
      // Keys should be sorted: :person/age before :person/name
      expect(parsed[0][0]).toBe(":person/age");
      expect(parsed[1][0]).toBe(":person/name");
    });

    it("should sort multi-valued attributes deterministically", () => {
      const attrs = {
        ":person/tag": [
          { type: "string" as const, value: "senior" },
          { type: "string" as const, value: "backend" },
        ],
      };
      const result = canonicalize(attrs);
      const parsed = JSON.parse(result);
      // "backend" < "senior" lexicographically
      expect(parsed[0][1][0].value).toBe("backend");
      expect(parsed[0][1][1].value).toBe("senior");
    });

    it("should produce empty array for empty attributes", () => {
      expect(canonicalize({})).toBe("[]");
    });

    it("should produce same output regardless of input order", () => {
      const attrs1 = {
        ":b": { type: "string" as const, value: "x" },
        ":a": { type: "string" as const, value: "y" },
      };
      const attrs2 = {
        ":a": { type: "string" as const, value: "y" },
        ":b": { type: "string" as const, value: "x" },
      };
      expect(canonicalize(attrs1)).toBe(canonicalize(attrs2));
    });
  });

  describe("hashCanonical", () => {
    it("should produce a prefixed hash", () => {
      const hash = hashCanonical("[]");
      expect(hash).toMatch(/^sha256-[a-f0-9]{64}$/);
    });

    it("should produce consistent hashes for same input", () => {
      const h1 = hashCanonical("[]");
      const h2 = hashCanonical("[]");
      expect(h1).toBe(h2);
    });

    it("should produce different hashes for different input", () => {
      const h1 = hashCanonical("[]");
      const h2 = hashCanonical('[["a",1]]');
      expect(h1).not.toBe(h2);
    });
  });

  describe("EMPTY_ENTITY_HASH", () => {
    it("should be the hash of empty canonical form", () => {
      expect(EMPTY_ENTITY_HASH).toBe(hashCanonical("[]"));
    });
  });

  describe("triplesToAttributeMap", () => {
    it("should convert triples to attribute map", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          yield* store.assert({
            entityId: eid("p:alice"),
            attribute: ":person/name",
            value: string("Alice"),
          });
          yield* store.assert({
            entityId: eid("p:alice"),
            attribute: ":person/age",
            value: number(30),
          });
          const triples = yield* store.entity("p:alice" as EntityId);
          return triplesToAttributeMap(triples);
        }).pipe(Effect.provide(SqliteTestLayer)),
      );

      expect(result[":person/name"]).toEqual({ type: "string", value: "Alice" });
      expect(result[":person/age"]).toEqual({ type: "number", value: 30 });
    });

    it("should produce arrays for multi-valued attributes", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          yield* store.assert({
            entityId: eid("p:alice"),
            attribute: ":person/tag",
            value: string("senior"),
          });
          yield* store.assert({
            entityId: eid("p:alice"),
            attribute: ":person/tag",
            value: string("backend"),
          });
          const triples = yield* store.entity("p:alice" as EntityId);
          return triplesToAttributeMap(triples);
        }).pipe(Effect.provide(SqliteTestLayer)),
      );

      const tags = result[":person/tag"];
      expect(Array.isArray(tags)).toBe(true);
      expect(tags).toHaveLength(2);
    });
  });

  describe("diffAttributes", () => {
    it("should detect added attributes", () => {
      const old = {};
      const new_ = { ":a": { type: "string" as const, value: "x" } };
      const { added, removed, changed } = diffAttributes(old, new_);
      expect(Object.keys(added)).toEqual([":a"]);
      expect(Object.keys(removed)).toHaveLength(0);
      expect(Object.keys(changed)).toHaveLength(0);
    });

    it("should detect removed attributes", () => {
      const old = { ":a": { type: "string" as const, value: "x" } };
      const new_ = {};
      const { added, removed, changed } = diffAttributes(old, new_);
      expect(Object.keys(added)).toHaveLength(0);
      expect(Object.keys(removed)).toEqual([":a"]);
      expect(Object.keys(changed)).toHaveLength(0);
    });

    it("should detect changed attributes", () => {
      const old = { ":a": { type: "string" as const, value: "x" } };
      const new_ = { ":a": { type: "string" as const, value: "y" } };
      const { added, removed, changed } = diffAttributes(old, new_);
      expect(Object.keys(added)).toHaveLength(0);
      expect(Object.keys(removed)).toHaveLength(0);
      expect(Object.keys(changed)).toEqual([":a"]);
      expect(changed[":a"]!.old).toEqual({ type: "string", value: "x" });
      expect(changed[":a"]!.new).toEqual({ type: "string", value: "y" });
    });

    it("should not report unchanged attributes", () => {
      const attrs = { ":a": { type: "string" as const, value: "same" } };
      const { added, removed, changed } = diffAttributes(attrs, attrs);
      expect(Object.keys(added)).toHaveLength(0);
      expect(Object.keys(removed)).toHaveLength(0);
      expect(Object.keys(changed)).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// SnapshotWriter
// ---------------------------------------------------------------------------

describe("SnapshotWriter", () => {
  it("should materialize a snapshot for an entity", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Triples;
        const writer = yield* SnapshotWriter;
        const snapService = yield* SnapshotService;

        // Create an entity
        const result = yield* store.transact([
          {
            op: "assert",
            entityId: eid("p:alice"),
            attribute: ":person/name",
            value: string("Alice"),
          },
          { op: "assert", entityId: eid("p:alice"), attribute: ":person/age", value: number(30) },
        ]);

        // Materialize snapshot
        const snapshots = yield* writer.materialize(result.txId, Date.now(), ["p:alice"]);
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]!.entityId).toBe("p:alice");
        expect(snapshots[0]!.hash).toMatch(/^sha256-[a-f0-9]{64}$/);
        expect(snapshots[0]!.attributes[":person/name"]).toEqual({
          type: "string",
          value: "Alice",
        });
        expect(snapshots[0]!.attributes[":person/age"]).toEqual({ type: "number", value: 30 });

        // Read it back via SnapshotService
        const current = yield* snapService.current("p:alice");
        expect(current).not.toBeNull();
        expect(current!.hash).toBe(snapshots[0]!.hash);
        expect(current!.attributes[":person/name"]).toEqual({
          type: "string",
          value: "Alice",
        });
      }).pipe(Effect.provide(SnapshotTestLayer)),
    );
  });

  it("should deduplicate identical entity states (structural sharing)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Triples;
        const writer = yield* SnapshotWriter;

        // Create two entities with identical attributes
        const r1 = yield* store.transact([
          {
            op: "assert",
            entityId: eid("p:alice"),
            attribute: ":person/name",
            value: string("Alice"),
          },
        ]);
        const r2 = yield* store.transact([
          {
            op: "assert",
            entityId: eid("p:bob"),
            attribute: ":person/name",
            value: string("Alice"),
          },
        ]);

        const s1 = yield* writer.materialize(r1.txId, Date.now(), ["p:alice"]);
        const s2 = yield* writer.materialize(r2.txId, Date.now(), ["p:bob"]);

        // Same attributes → same hash
        expect(s1[0]!.hash).toBe(s2[0]!.hash);
      }).pipe(Effect.provide(SnapshotTestLayer)),
    );
  });

  it("should produce different hashes for different entity states", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Triples;
        const writer = yield* SnapshotWriter;

        const r1 = yield* store.transact([
          {
            op: "assert",
            entityId: eid("p:alice"),
            attribute: ":person/name",
            value: string("Alice"),
          },
        ]);
        const r2 = yield* store.transact([
          { op: "assert", entityId: eid("p:bob"), attribute: ":person/name", value: string("Bob") },
        ]);

        const s1 = yield* writer.materialize(r1.txId, Date.now(), ["p:alice"]);
        const s2 = yield* writer.materialize(r2.txId, Date.now(), ["p:bob"]);

        expect(s1[0]!.hash).not.toBe(s2[0]!.hash);
      }).pipe(Effect.provide(SnapshotTestLayer)),
    );
  });

  it("should handle entity retraction with tombstone hash", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Triples;
        const writer = yield* SnapshotWriter;
        const snapService = yield* SnapshotService;

        // Create then retract
        const r1 = yield* store.transact([
          { op: "assert", entityId: eid("p:temp"), attribute: ":name", value: string("Temp") },
        ]);
        yield* writer.materialize(r1.txId, Date.now(), ["p:temp"]);

        // Retract (via transact retract-pattern)
        const r2 = yield* store.transact([
          { op: "retract-pattern", pattern: { entityId: eid("p:temp") } },
        ]);
        yield* writer.materialize(r2.txId, Date.now() + 1, ["p:temp"]);

        // Should have the empty hash (tombstone)
        const snap = yield* snapService.current("p:temp");
        expect(snap).not.toBeNull();
        expect(snap!.hash).toBe(EMPTY_ENTITY_HASH);
        expect(Object.keys(snap!.attributes)).toHaveLength(0);
      }).pipe(Effect.provide(SnapshotTestLayer)),
    );
  });
});

// ---------------------------------------------------------------------------
// SnapshotService
// ---------------------------------------------------------------------------

describe("SnapshotService", () => {
  describe("current + at + hashAt", () => {
    it("should return null for non-existent entity", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const snapService = yield* SnapshotService;
          const result = yield* snapService.current("nonexistent");
          expect(result).toBeNull();
        }).pipe(Effect.provide(SnapshotTestLayer)),
      );
    });

    it("should return snapshot at a specific transaction", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const writer = yield* SnapshotWriter;
          const snapService = yield* SnapshotService;

          const r1 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Alice"),
            },
          ]);
          yield* writer.materialize(r1.txId, 1000, ["p:alice"]);

          const snap = yield* snapService.at("p:alice", r1.txId);
          expect(snap).not.toBeNull();
          expect(snap!.txId).toBe(r1.txId);
        }).pipe(Effect.provide(SnapshotTestLayer)),
      );
    });

    it("should return hash at a specific transaction", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const writer = yield* SnapshotWriter;
          const snapService = yield* SnapshotService;

          const r1 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Alice"),
            },
          ]);
          const snaps = yield* writer.materialize(r1.txId, 1000, ["p:alice"]);

          const hash = yield* snapService.hashAt("p:alice", r1.txId);
          expect(hash).toBe(snaps[0]!.hash);
        }).pipe(Effect.provide(SnapshotTestLayer)),
      );
    });
  });

  describe("asOf", () => {
    it("should return latest snapshot at or before the given time", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const writer = yield* SnapshotWriter;
          const snapService = yield* SnapshotService;

          // tx at time 1000
          const r1 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Alice"),
            },
          ]);
          const s1 = yield* writer.materialize(r1.txId, 1000, ["p:alice"]);

          // tx at time 2000
          const r2 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/age",
              value: number(30),
            },
          ]);
          const s2 = yield* writer.materialize(r2.txId, 2000, ["p:alice"]);

          // asOf 1500 should return the first snapshot
          const snap = yield* snapService.asOf("p:alice", 1500);
          expect(snap).not.toBeNull();
          expect(snap!.hash).toBe(s1[0]!.hash);

          // asOf 2500 should return the second snapshot
          const snap2 = yield* snapService.asOf("p:alice", 2500);
          expect(snap2).not.toBeNull();
          expect(snap2!.hash).toBe(s2[0]!.hash);
        }).pipe(Effect.provide(SnapshotTestLayer)),
      );
    });
  });

  describe("batchCurrent", () => {
    it("should batch read multiple entities", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const writer = yield* SnapshotWriter;
          const snapService = yield* SnapshotService;

          const r1 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Alice"),
            },
            {
              op: "assert",
              entityId: eid("p:bob"),
              attribute: ":person/name",
              value: string("Bob"),
            },
          ]);
          yield* writer.materialize(r1.txId, 1000, ["p:alice", "p:bob"]);

          const batch = yield* snapService.batchCurrent(["p:alice", "p:bob", "p:nonexistent"]);
          expect(batch.size).toBe(2);
          expect(batch.get("p:alice")).toBeDefined();
          expect(batch.get("p:bob")).toBeDefined();
          expect(batch.get("p:nonexistent")).toBeUndefined();
        }).pipe(Effect.provide(SnapshotTestLayer)),
      );
    });

    it("should return empty map for empty input", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const snapService = yield* SnapshotService;
          const batch = yield* snapService.batchCurrent([]);
          expect(batch.size).toBe(0);
        }).pipe(Effect.provide(SnapshotTestLayer)),
      );
    });
  });

  describe("hashes", () => {
    it("should return hash chain for an entity", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const writer = yield* SnapshotWriter;
          const snapService = yield* SnapshotService;

          // First state
          const r1 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Alice"),
            },
          ]);
          yield* writer.materialize(r1.txId, 1000, ["p:alice"]);

          // Second state (add age)
          const r2 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/age",
              value: number(30),
            },
          ]);
          yield* writer.materialize(r2.txId, 2000, ["p:alice"]);

          const chain = yield* snapService.hashes("p:alice");
          expect(chain).toHaveLength(2);
          expect(chain[0]!.txTime).toBe(1000);
          expect(chain[1]!.txTime).toBe(2000);
          expect(chain[0]!.hash).not.toBe(chain[1]!.hash);
        }).pipe(Effect.provide(SnapshotTestLayer)),
      );
    });
  });

  describe("diff", () => {
    it("should compute diff between two snapshots", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const writer = yield* SnapshotWriter;
          const snapService = yield* SnapshotService;

          const r1 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Alice"),
            },
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/age",
              value: number(30),
            },
          ]);
          yield* writer.materialize(r1.txId, 1000, ["p:alice"]);

          // Add email in second tx
          const r2 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/email",
              value: string("alice@example.com"),
            },
          ]);
          yield* writer.materialize(r2.txId, 2000, ["p:alice"]);

          const d = yield* snapService.diff("p:alice", r1.txId, r2.txId);
          expect(d.fromTxId).toBe(r1.txId);
          expect(d.toTxId).toBe(r2.txId);
          expect(d.added[":person/email"]).toBeDefined();
          expect(Object.keys(d.removed)).toHaveLength(0);
          // name and age are unchanged between r1 and r2
        }).pipe(Effect.provide(SnapshotTestLayer)),
      );
    });
  });

  describe("O(1) change detection", () => {
    it("should detect changes via hash comparison", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const writer = yield* SnapshotWriter;
          const snapService = yield* SnapshotService;

          const r1 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/salary",
              value: number(100000),
            },
          ]);
          yield* writer.materialize(r1.txId, 1000, ["p:alice"]);

          const r2 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/salary",
              value: number(110000),
            },
          ]);
          yield* writer.materialize(r2.txId, 2000, ["p:alice"]);

          const h1 = yield* snapService.hashAt("p:alice", r1.txId);
          const h2 = yield* snapService.hashAt("p:alice", r2.txId);
          expect(h1).not.toBe(h2); // entity changed
        }).pipe(Effect.provide(SnapshotTestLayer)),
      );
    });

    it("should detect structural sharing when entity reverts", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const writer = yield* SnapshotWriter;
          const snapService = yield* SnapshotService;

          // Initial state: name = Alice
          const r1 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Alice"),
            },
          ]);
          yield* writer.materialize(r1.txId, 1000, ["p:alice"]);
          const h1 = yield* snapService.hashAt("p:alice", r1.txId);

          // Add age
          const r2 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/age",
              value: number(30),
            },
          ]);
          yield* writer.materialize(r2.txId, 2000, ["p:alice"]);
          const h2 = yield* snapService.hashAt("p:alice", r2.txId);

          // Retract age — revert to first state
          const ageTriple = (yield* store.entity("p:alice" as EntityId)).find(
            (t) => t.attribute === ":person/age",
          );
          const r3 = yield* store.transact([{ op: "retract", id: ageTriple!.id }]);
          yield* writer.materialize(r3.txId, 3000, ["p:alice"]);
          const h3 = yield* snapService.hashAt("p:alice", r3.txId);

          // h1 and h3 should be the same (structural sharing)
          expect(h1).toBe(h3);
          // h2 should be different
          expect(h2).not.toBe(h1);
        }).pipe(Effect.provide(SnapshotTestLayer)),
      );
    });
  });

  describe("findByHash", () => {
    it("should find entities with the same hash", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const writer = yield* SnapshotWriter;
          const snapService = yield* SnapshotService;

          // Two entities with identical state
          const r1 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Same"),
            },
            {
              op: "assert",
              entityId: eid("p:bob"),
              attribute: ":person/name",
              value: string("Same"),
            },
          ]);
          yield* writer.materialize(r1.txId, 1000, ["p:alice", "p:bob"]);

          const snap = yield* snapService.current("p:alice");
          const entities = yield* snapService.findByHash(snap!.hash);
          expect(entities).toContain("p:alice");
          expect(entities).toContain("p:bob");
        }).pipe(Effect.provide(SnapshotTestLayer)),
      );
    });
  });

  describe("findChanged", () => {
    it("should find entities changed since a transaction", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const writer = yield* SnapshotWriter;
          const snapService = yield* SnapshotService;

          const r1 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Alice"),
            },
          ]);
          yield* writer.materialize(r1.txId, 1000, ["p:alice"]);

          const r2 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:bob"),
              attribute: ":person/name",
              value: string("Bob"),
            },
          ]);
          yield* writer.materialize(r2.txId, 2000, ["p:bob"]);

          // Find changes since r1
          const changed = yield* snapService.findChanged(r1.txId);
          expect(changed).toHaveLength(1);
          expect(changed[0]!.entityId).toBe("p:bob");
        }).pipe(Effect.provide(SnapshotTestLayer)),
      );
    });

    it("should include changes in the same millisecond via txId tie-break", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const writer = yield* SnapshotWriter;
          const snapService = yield* SnapshotService;

          const first = TransactionId.make("_tx/01AAAAAAAAAAAAAAAAAAAAAAAA");
          const second = TransactionId.make("_tx/01BBBBBBBBBBBBBBBBBBBBBBBB");
          yield* writer.materialize(first, 1000, ["p:alice"]);
          yield* writer.materialize(second, 1000, ["p:bob"]);

          const changed = yield* snapService.findChanged(first);
          expect(changed.some((entry) => entry.entityId === "p:bob")).toBe(true);
        }).pipe(Effect.provide(SnapshotTestLayer)),
      );
    });
  });

  describe("checkpoint", () => {
    it("should produce entity→hash map at a point in time", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const writer = yield* SnapshotWriter;
          const snapService = yield* SnapshotService;

          const r1 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Alice"),
            },
            {
              op: "assert",
              entityId: eid("p:bob"),
              attribute: ":person/name",
              value: string("Bob"),
            },
          ]);
          yield* writer.materialize(r1.txId, 1000, ["p:alice", "p:bob"]);

          const cp = yield* snapService.checkpoint(1500);
          expect(cp.size).toBe(2);
          expect(cp.has("p:alice")).toBe(true);
          expect(cp.has("p:bob")).toBe(true);
        }).pipe(Effect.provide(SnapshotTestLayer)),
      );
    });

    it("should respect time boundary", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const writer = yield* SnapshotWriter;
          const snapService = yield* SnapshotService;

          const r1 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Alice"),
            },
          ]);
          yield* writer.materialize(r1.txId, 1000, ["p:alice"]);

          const r2 = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:bob"),
              attribute: ":person/name",
              value: string("Bob"),
            },
          ]);
          yield* writer.materialize(r2.txId, 2000, ["p:bob"]);

          // Checkpoint at 1500 should only include alice
          const cp = yield* snapService.checkpoint(1500);
          expect(cp.size).toBe(1);
          expect(cp.has("p:alice")).toBe(true);
          expect(cp.has("p:bob")).toBe(false);
        }).pipe(Effect.provide(SnapshotTestLayer)),
      );
    });
  });

  describe("backfill", () => {
    it("should create snapshots for existing entities", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const writer = yield* SnapshotWriter;
          const snapService = yield* SnapshotService;

          // Create entities without snapshots
          yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Alice"),
            },
            {
              op: "assert",
              entityId: eid("p:bob"),
              attribute: ":person/name",
              value: string("Bob"),
            },
          ]);

          // No snapshots yet
          expect(yield* snapService.current("p:alice")).toBeNull();

          // Backfill
          const count = yield* writer.backfill();
          // backfill finds distinct entity_ids — alice, bob, plus the _Transaction entity
          expect(count).toBeGreaterThanOrEqual(2);

          // Now snapshots exist
          const alice = yield* snapService.current("p:alice");
          expect(alice).not.toBeNull();
          expect(alice!.attributes[":person/name"]).toEqual({
            type: "string",
            value: "Alice",
          });
        }).pipe(Effect.provide(SnapshotTestLayer)),
      );
    });
  });
});
