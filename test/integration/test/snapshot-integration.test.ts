import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import {
  Triples,
  TriplesLive,
  CurrentDialect,
  SqliteDialect,
  SnapshotService,
  SnapshotWriter,
  SnapshotServiceLive,
  SnapshotWriterLive,
  string,
  number,
  EMPTY_ENTITY_HASH,
  // Composable capabilities
  composeStore,
  makeEntitySnapshotsCapability,
  makeChangeEmissionCapability,
  type StoreCapability,
  validateDependencies,
  describeCapabilities,
  TripleStoreRuntime,
  TripleStoreRuntimeLayer,
} from "@triplex-build/triplex/internal";
import { EntityId, TransactionId, TripleId } from "@triplex-build/triplex";
import { SqliteAdapterLive } from "@triplex-build/triplex-sqlite";
import { SqlQueryExecutorLive } from "@triplex-build/triplex-sql";

const sqliteDialectLayer = Layer.succeed(CurrentDialect, SqliteDialect);
const eid = EntityId.make;

// ---------------------------------------------------------------------------
// Test layer: Triples wrapped with automatic snapshot materialization
// ---------------------------------------------------------------------------

/**
 * Creates a test layer where the Triples is wrapped with snapshot auto-materialization.
 * This mirrors how the system would work in production: every write automatically
 * materializes snapshots for all touched entities.
 */
const makeIntegrationLayer = () => {
  const sqliteLayer = SqliteClient.layer({ filename: ":memory:" });
  const adapterLayer = SqliteAdapterLive.pipe(Layer.provide(sqliteLayer));

  // Base store
  const baseStoreLayer = TriplesLive.pipe(
    Layer.provideMerge(SqlQueryExecutorLive),
    Layer.provideMerge(adapterLayer),
    Layer.provideMerge(sqliteDialectLayer),
    Layer.provideMerge(sqliteLayer),
    Layer.provide(TripleStoreRuntimeLayer),
  );

  // Snapshot layers need StorageAdapter
  const writerLayer = SnapshotWriterLive.pipe(
    Layer.provide(baseStoreLayer),
    Layer.provide(adapterLayer),
  );
  const readerLayer = SnapshotServiceLive.pipe(Layer.provide(adapterLayer));

  // Combined: compose automatic snapshot materialization over Triples.
  const wrappedStoreLayer = Layer.effect(
    Triples,
    Effect.gen(function* () {
      const baseStore = yield* Triples;
      const writer = yield* SnapshotWriter;
      return composeStore(baseStore, makeEntitySnapshotsCapability(writer));
    }),
  ).pipe(Layer.provide(Layer.mergeAll(baseStoreLayer, writerLayer, readerLayer)));

  return Layer.mergeAll(wrappedStoreLayer, readerLayer);
};

describe("Snapshot Integration (auto-materialization)", () => {
  describe("transact", () => {
    it("should automatically materialize snapshots on transact", async () => {
      const TestLayer = makeIntegrationLayer();

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const snapService = yield* SnapshotService;

          // Before: no snapshot
          expect(yield* snapService.current("p:alice")).toBeNull();

          // Transact
          yield* store.transact([
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

          // After: snapshot exists automatically
          const snap = yield* snapService.current("p:alice");
          expect(snap).not.toBeNull();
          expect(snap!.entityId).toBe("p:alice");
          expect(snap!.attributes[":person/name"]).toEqual({
            type: "string",
            value: "Alice",
          });
          expect(snap!.attributes[":person/age"]).toEqual({ type: "number", value: 30 });
        }).pipe(Effect.provide(TestLayer)),
      );
    });

    it("should update snapshot when entity is modified", async () => {
      const TestLayer = makeIntegrationLayer();

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const snapService = yield* SnapshotService;

          const entityId = eid("p:alice-modify");

          // Create entity
          yield* store.transact([
            {
              op: "assert",
              entityId,
              attribute: ":person/name",
              value: string("Alice"),
            },
          ]);

          const snap1 = yield* snapService.current(entityId);
          const originalHash = snap1?.hash;

          // Modify entity
          yield* store.transact([
            {
              op: "assert",
              entityId,
              attribute: ":person/email",
              value: string("alice@example.com"),
            },
          ]);

          const snap2 = yield* snapService.current(entityId);
          expect(snap2).not.toBeNull();
          expect(snap2!.hash).not.toBe(originalHash);
          expect(snap2!.attributes[":person/email"]).toEqual({
            type: "string",
            value: "alice@example.com",
          });
          // Original attribute still present
          expect(snap2!.attributes[":person/name"]).toEqual({
            type: "string",
            value: "Alice",
          });
        }).pipe(Effect.provide(TestLayer)),
      );
    });

    it("should handle multiple entities in one transaction", async () => {
      const TestLayer = makeIntegrationLayer();

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const snapService = yield* SnapshotService;

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
            {
              op: "assert",
              entityId: eid("p:charlie"),
              attribute: ":person/name",
              value: string("Charlie"),
            },
          ]);

          const batch = yield* snapService.batchCurrent(["p:alice", "p:bob", "p:charlie"]);
          expect(batch.size).toBe(3);
        }).pipe(Effect.provide(TestLayer)),
      );
    });
  });

  describe("assert", () => {
    it("should auto-materialize on single assert", async () => {
      const TestLayer = makeIntegrationLayer();

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const snapService = yield* SnapshotService;

          yield* store.assert({
            entityId: eid("p:alice"),
            attribute: ":person/name",
            value: string("Alice"),
          });

          const snap = yield* snapService.current("p:alice");
          expect(snap).not.toBeNull();
          expect(snap!.attributes[":person/name"]).toEqual({
            type: "string",
            value: "Alice",
          });
        }).pipe(Effect.provide(TestLayer)),
      );
    });
  });

  describe("assertBatch", () => {
    it("should auto-materialize on batch assert", async () => {
      const TestLayer = makeIntegrationLayer();

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const snapService = yield* SnapshotService;

          yield* store.assertBatch([
            { entityId: eid("p:alice"), attribute: ":person/name", value: string("Alice") },
            { entityId: eid("p:bob"), attribute: ":person/name", value: string("Bob") },
          ]);

          const alice = yield* snapService.current("p:alice");
          const bob = yield* snapService.current("p:bob");
          expect(alice).not.toBeNull();
          expect(bob).not.toBeNull();
        }).pipe(Effect.provide(TestLayer)),
      );
    });
  });

  describe("retract", () => {
    it("should update snapshot when a triple is retracted", async () => {
      const TestLayer = makeIntegrationLayer();

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const snapService = yield* SnapshotService;

          // Create entity with two attributes
          const result = yield* store.transact([
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

          const snap1 = yield* snapService.current("p:alice");
          expect(snap1).not.toBeNull();
          expect(snap1!.attributes[":person/age"]).toBeDefined();

          // Retract age
          const ageTriple = result.triples.find((t) => t.attribute === ":person/age");
          yield* store.retract(ageTriple!.id);

          // Snapshot should be updated (no more age)
          const snap2 = yield* snapService.current("p:alice");
          expect(snap2).not.toBeNull();
          expect(snap2!.hash).not.toBe(snap1!.hash);
          expect(snap2!.attributes[":person/age"]).toBeUndefined();
          expect(snap2!.attributes[":person/name"]).toEqual({
            type: "string",
            value: "Alice",
          });
        }).pipe(Effect.provide(TestLayer)),
      );
    });
  });

  describe("retractByPattern", () => {
    it("should update snapshot when all triples retracted (tombstone)", async () => {
      const TestLayer = makeIntegrationLayer();

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const snapService = yield* SnapshotService;

          yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:temp"),
              attribute: ":person/name",
              value: string("Temp"),
            },
          ]);

          expect(yield* snapService.current("p:temp")).not.toBeNull();

          // Retract all triples for this entity
          yield* store.retractByPattern({ entityId: eid("p:temp") });

          // Snapshot should show tombstone (empty hash)
          const snap = yield* snapService.current("p:temp");
          expect(snap).not.toBeNull();
          expect(snap!.hash).toBe(EMPTY_ENTITY_HASH);
          expect(Object.keys(snap!.attributes)).toHaveLength(0);
        }).pipe(Effect.provide(TestLayer)),
      );
    });
  });

  describe("getEntity fast path", () => {
    it("should return entity data from snapshot (fast path)", async () => {
      const TestLayer = makeIntegrationLayer();

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          yield* store.transact([
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

          // getEntity should work via snapshot fast path
          const triples = yield* store.entity("p:alice" as EntityId);
          expect(triples.length).toBe(2);

          const nameTriple = triples.find((t) => t.attribute === ":person/name");
          const ageTriple = triples.find((t) => t.attribute === ":person/age");
          expect(nameTriple).toBeDefined();
          expect(nameTriple!.value).toEqual({ type: "string", value: "Alice" });
          expect(ageTriple).toBeDefined();
          expect(ageTriple!.value).toEqual({ type: "number", value: 30 });
        }).pipe(Effect.provide(TestLayer)),
      );
    });

    it("should allow retracting IDs returned by snapshot fast path", async () => {
      const TestLayer = makeIntegrationLayer();

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Alice"),
            },
          ]);

          const triples = yield* store.entity("p:alice" as EntityId);
          expect(triples).toHaveLength(1);

          yield* store.retract(triples[0]!.id as TripleId);

          const after = yield* store.entity("p:alice" as EntityId);
          expect(after).toHaveLength(0);
        }).pipe(Effect.provide(TestLayer)),
      );
    });
  });

  describe("hash chain over time", () => {
    it("should track entity state changes as a hash chain", async () => {
      const TestLayer = makeIntegrationLayer();

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const snapService = yield* SnapshotService;

          // State 1: name only
          yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Alice"),
            },
          ]);

          // State 2: name + age
          yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/age",
              value: number(30),
            },
          ]);

          // State 3: name + age + email
          yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/email",
              value: string("alice@example.com"),
            },
          ]);

          const chain = yield* snapService.hashes("p:alice");
          expect(chain.length).toBe(3);
          // Each state should have a different hash
          const hashes = chain.map((h) => h.hash);
          expect(new Set(hashes).size).toBe(3);
        }).pipe(Effect.provide(TestLayer)),
      );
    });
  });

  describe("structural sharing", () => {
    it("should share blobs between entities with identical state", async () => {
      const TestLayer = makeIntegrationLayer();

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const snapService = yield* SnapshotService;

          // Two entities with identical attributes
          yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/role",
              value: string("engineer"),
            },
          ]);
          yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:bob"),
              attribute: ":person/role",
              value: string("engineer"),
            },
          ]);

          const alice = yield* snapService.current("p:alice");
          const bob = yield* snapService.current("p:bob");
          expect(alice!.hash).toBe(bob!.hash); // structural sharing

          // findByHash should return both
          const entities = yield* snapService.findByHash(alice!.hash);
          expect(entities).toContain("p:alice");
          expect(entities).toContain("p:bob");
        }).pipe(Effect.provide(TestLayer)),
      );
    });
  });
});

// ===========================================================================
// Composable Store Capability Tests
// ===========================================================================

describe("StoreCapability composition", () => {
  describe("validateDependencies", () => {
    it("should pass for capabilities with no dependencies", () => {
      const caps: StoreCapability[] = [
        { name: "A", priority: 10, requires: [], wrap: (s) => s },
        { name: "B", priority: 20, requires: [], wrap: (s) => s },
      ];
      expect(() => validateDependencies(caps)).not.toThrow();
    });

    it("should pass when all dependencies are satisfied", () => {
      const caps: StoreCapability[] = [
        { name: "A", priority: 10, requires: [], wrap: (s) => s },
        { name: "B", priority: 20, requires: ["A"], wrap: (s) => s },
      ];
      expect(() => validateDependencies(caps)).not.toThrow();
    });

    it("should throw for missing dependency", () => {
      const caps: StoreCapability[] = [
        { name: "B", priority: 20, requires: ["A"], wrap: (s) => s },
      ];
      expect(() => validateDependencies(caps)).toThrow(/requires "A"/);
    });

    it("should throw for duplicate capability names", () => {
      const caps: StoreCapability[] = [
        { name: "A", priority: 10, requires: [], wrap: (s) => s },
        { name: "A", priority: 20, requires: [], wrap: (s) => s },
      ];
      expect(() => validateDependencies(caps)).toThrow(/Duplicate capability name/);
    });
  });

  describe("describeCapabilities", () => {
    it("should list capabilities in outermost-first order", () => {
      const caps: StoreCapability[] = [
        { name: "Inner", priority: 10, requires: [], wrap: (s) => s },
        { name: "Outer", priority: 90, requires: [], wrap: (s) => s },
        { name: "Middle", priority: 50, requires: [], wrap: (s) => s },
      ];
      const desc = describeCapabilities(caps);
      expect(desc[0]!.name).toBe("Outer");
      expect(desc[1]!.name).toBe("Middle");
      expect(desc[2]!.name).toBe("Inner");
    });
  });

  describe("composeStore with EntitySnapshotsCapability", () => {
    /**
     * Build a test layer using `composeStore` + `makeEntitySnapshotsCapability`.
     *
     * Uses the same layer construction pattern as `makeIntegrationLayer` above
     * to ensure layer memoization shares the same Triples + StorageAdapter
     * instances between the base store, writer, and reader.
     */
    const makeCapabilityLayer = () => {
      const sqliteLayer = SqliteClient.layer({ filename: ":memory:" });
      const adapterLayer = SqliteAdapterLive.pipe(Layer.provide(sqliteLayer));

      // Base store
      const baseStoreLayer = TriplesLive.pipe(
        Layer.provideMerge(SqlQueryExecutorLive),
        Layer.provideMerge(adapterLayer),
        Layer.provideMerge(sqliteDialectLayer),
        Layer.provideMerge(sqliteLayer),
        Layer.provide(TripleStoreRuntimeLayer),
      );

      // Snapshot layers need StorageAdapter + Triples
      const writerLayer = SnapshotWriterLive.pipe(
        Layer.provide(baseStoreLayer),
        Layer.provide(adapterLayer),
      );
      const readerLayer = SnapshotServiceLive.pipe(Layer.provide(adapterLayer));

      // Use composeStore + makeEntitySnapshotsCapability
      // Same pattern as makeIntegrationLayer but using capabilities
      const composedStoreLayer = Layer.effect(
        Triples,
        Effect.gen(function* () {
          const baseStore = yield* Triples;
          const writer = yield* SnapshotWriter;

          const snapshotCap = makeEntitySnapshotsCapability(writer);
          return composeStore(baseStore, snapshotCap);
        }),
      ).pipe(Layer.provide(Layer.mergeAll(baseStoreLayer, writerLayer, readerLayer)));

      return Layer.mergeAll(composedStoreLayer, readerLayer);
    };

    it("should auto-materialize snapshots on transact", async () => {
      const TestLayer = makeCapabilityLayer();

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const snapService = yield* SnapshotService;

          yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Alice"),
            },
            { op: "assert", entityId: eid("p:alice"), attribute: ":person/age", value: number(30) },
          ]);

          const snap = yield* snapService.current("p:alice");
          expect(snap).not.toBeNull();
          expect(snap!.attributes[":person/name"]).toEqual({ type: "string", value: "Alice" });
          expect(snap!.attributes[":person/age"]).toEqual({ type: "number", value: 30 });
        }).pipe(Effect.provide(TestLayer)),
      );
    });

    it("should work with multiple capabilities composed", async () => {
      const sqliteLayer = SqliteClient.layer({ filename: ":memory:" });
      const adapterLayer = SqliteAdapterLive.pipe(Layer.provide(sqliteLayer));
      const baseStoreLayer = TriplesLive.pipe(
        Layer.provideMerge(SqlQueryExecutorLive),
        Layer.provideMerge(adapterLayer),
        Layer.provideMerge(sqliteDialectLayer),
        Layer.provideMerge(sqliteLayer),
        Layer.provide(TripleStoreRuntimeLayer),
      );

      const writerLayer = SnapshotWriterLive.pipe(
        Layer.provide(baseStoreLayer),
        Layer.provide(adapterLayer),
      );
      const readerLayer = SnapshotServiceLive.pipe(Layer.provide(adapterLayer));

      // Compose both ChangeEmission and EntitySnapshots capabilities
      const composedStoreLayer = Layer.effect(
        Triples,
        Effect.gen(function* () {
          const baseStore = yield* Triples;
          const writer = yield* SnapshotWriter;

          const snapshotCap = makeEntitySnapshotsCapability(writer);
          const emitCap = makeChangeEmissionCapability(
            { emit: () => Effect.void },
            Effect.sync(() => Date.now()),
          );

          return composeStore(baseStore, snapshotCap, emitCap);
        }),
      ).pipe(Layer.provide(Layer.mergeAll(baseStoreLayer, writerLayer, readerLayer)));

      const TestLayer = Layer.mergeAll(composedStoreLayer, readerLayer);

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const snapService = yield* SnapshotService;

          yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:bob"),
              attribute: ":person/name",
              value: string("Bob"),
            },
          ]);

          const snap = yield* snapService.current("p:bob");
          expect(snap).not.toBeNull();
          expect(snap!.attributes[":person/name"]).toEqual({ type: "string", value: "Bob" });
        }).pipe(Effect.provide(TestLayer)),
      );
    });

    it("should support getEntity fast path via capability", async () => {
      const TestLayer = makeCapabilityLayer();

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Alice"),
            },
            { op: "assert", entityId: eid("p:alice"), attribute: ":person/age", value: number(25) },
          ]);

          const triples = yield* store.entity("p:alice" as EntityId);
          expect(triples.length).toBe(2);
          const nameTriple = triples.find((t) => t.attribute === ":person/name");
          expect(nameTriple!.value).toEqual({ type: "string", value: "Alice" });
        }).pipe(Effect.provide(TestLayer)),
      );
    });

    it("should allow retracting IDs returned by capability fast path", async () => {
      const TestLayer = makeCapabilityLayer();

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Alice"),
            },
          ]);

          const triples = yield* store.entity("p:alice" as EntityId);
          expect(triples).toHaveLength(1);

          yield* store.retract(triples[0]!.id as TripleId);

          const after = yield* store.entity("p:alice" as EntityId);
          expect(after).toHaveLength(0);
        }).pipe(Effect.provide(TestLayer)),
      );
    });

    it("should update snapshots on retract via capability", async () => {
      const TestLayer = makeCapabilityLayer();

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const snapService = yield* SnapshotService;

          const result = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Alice"),
            },
            { op: "assert", entityId: eid("p:alice"), attribute: ":person/age", value: number(30) },
          ]);

          const snap1 = yield* snapService.current("p:alice");
          expect(snap1).not.toBeNull();
          expect(snap1!.attributes[":person/age"]).toBeDefined();

          // Retract age using transact (which goes through the capability's transact path)
          const ageTriple = result.triples.find((t) => t.attribute === ":person/age");
          yield* store.transact([{ op: "retract", id: ageTriple!.id }]);

          const snap2 = yield* snapService.current("p:alice");
          expect(snap2).not.toBeNull();
          expect(snap2!.hash).not.toBe(snap1!.hash);
          expect(snap2!.attributes[":person/age"]).toBeUndefined();
        }).pipe(Effect.provide(TestLayer)),
      );
    });

    it("should prefer the newest snapshot when tx_time ties", async () => {
      const sqliteLayer = SqliteClient.layer({ filename: ":memory:" });
      const adapterLayer = SqliteAdapterLive.pipe(Layer.provide(sqliteLayer));
      const runtimeLayer = Layer.succeed(TripleStoreRuntime, {
        scope: "test:snapshots",
        now: Effect.succeed(1234567890),
        nextTripleId: Effect.sync(
          (() => {
            let index = 0;
            return () => TripleId.make(String(++index).padStart(26, "0"));
          })(),
        ),
        nextTxId: Effect.sync(
          (() => {
            const txIds = [
              TransactionId.make("_tx/01ZZZZZZZZZZZZZZZZZZZZZZZZ"),
              TransactionId.make("_tx/01AAAAAAAAAAAAAAAAAAAAAAAA"),
            ];
            let index = 0;
            return () =>
              txIds[index++] ?? TransactionId.make(`_tx/${String(index).padStart(26, "0")}`);
          })(),
        ),
      });

      const baseStoreLayer = TriplesLive.pipe(
        Layer.provideMerge(SqlQueryExecutorLive),
        Layer.provideMerge(adapterLayer),
        Layer.provideMerge(sqliteDialectLayer),
        Layer.provideMerge(sqliteLayer),
        Layer.provide(runtimeLayer),
      );
      const writerLayer = SnapshotWriterLive.pipe(
        Layer.provide(baseStoreLayer),
        Layer.provide(adapterLayer),
      );
      const readerLayer = SnapshotServiceLive.pipe(Layer.provide(adapterLayer));

      const composedStoreLayer = Layer.effect(
        Triples,
        Effect.gen(function* () {
          const baseStore = yield* Triples;
          const writer = yield* SnapshotWriter;

          const snapshotCap = makeEntitySnapshotsCapability(writer);
          return composeStore(baseStore, snapshotCap);
        }),
      ).pipe(Layer.provide(Layer.mergeAll(baseStoreLayer, writerLayer, readerLayer)));

      const TestLayer = Layer.mergeAll(composedStoreLayer, readerLayer);

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const snapService = yield* SnapshotService;

          const result = yield* store.transact([
            {
              op: "assert",
              entityId: eid("p:alice"),
              attribute: ":person/name",
              value: string("Alice"),
            },
            { op: "assert", entityId: eid("p:alice"), attribute: ":person/age", value: number(30) },
          ]);

          const ageTriple = result.triples.find((triple) => triple.attribute === ":person/age");
          yield* store.transact([{ op: "retract", id: ageTriple!.id }]);

          const snap = yield* snapService.current("p:alice");
          expect(snap).not.toBeNull();
          expect(snap!.txId).toBe("_tx/01AAAAAAAAAAAAAAAAAAAAAAAA");
          expect(snap!.attributes[":person/age"]).toBeUndefined();
        }).pipe(Effect.provide(TestLayer)),
      );
    });
  });
});
