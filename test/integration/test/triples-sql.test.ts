import { describe, it, expect } from "vitest";
import { Effect, Layer, Option } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import {
  Triples,
  TriplesLive,
  CurrentDialect,
  SqliteDialect,
  TripleStoreRuntime,
  DeterministicTripleStoreRuntimeLive,
  TxAttributes,
  string,
  number,
  boolean,
  ref as makeRef,
} from "@triplex-build/triplex/internal";
import { SqlQueryExecutorLive } from "@triplex-build/triplex-sql";
import { SqliteAdapterLive } from "@triplex-build/triplex-sqlite";
import { EntityId, TransactionId, TripleId } from "@triplex-build/triplex";
import { SqliteTestLayer } from "./fixtures/SqliteTestLayer.js";

const TestLayer = SqliteTestLayer;
const eid = EntityId.make;
const ref = (value: string) => makeRef(eid(value));
const makeRuntimeTestLayer = (runtimeLayer: Layer.Layer<TripleStoreRuntime>) =>
  TriplesLive.pipe(
    Layer.provideMerge(SqlQueryExecutorLive),
    Layer.provideMerge(SqliteAdapterLive),
    Layer.provideMerge(Layer.succeed(CurrentDialect, SqliteDialect)),
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
    Layer.provide(runtimeLayer),
  );

describe("Triples", () => {
  describe("assert", () => {
    it("should create a triple with string value", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const triple = yield* store.assert({
            entityId: eid("person-1"),
            attribute: ":name",
            value: string("Alice"),
            entityType: "Person",
          });

          expect(triple.id).toBeDefined();
          expect(triple.entityId).toBe("person-1");
          expect(triple.attribute).toBe(":name");
          expect(triple.value).toEqual({ type: "string", value: "Alice" });
          expect(Option.isSome(triple.entityType)).toBe(true);
          expect(Option.getOrNull(triple.entityType)).toBe("Person");

          return triple;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toBeDefined();
    });

    it("should create a triple with number value", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const triple = yield* store.assert({
            entityId: eid("person-1"),
            attribute: ":age",
            value: number(30),
          });

          expect(triple.value).toEqual({ type: "number", value: 30 });
          return triple;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toBeDefined();
    });

    it("should create a triple with boolean value", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const triple = yield* store.assert({
            entityId: eid("person-1"),
            attribute: ":active",
            value: boolean(true),
          });

          expect(triple.value).toEqual({ type: "boolean", value: true });
          return triple;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toBeDefined();
    });

    it("should create a triple with ref value", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const triple = yield* store.assert({
            entityId: eid("person-1"),
            attribute: ":works-at",
            value: ref("company-1"),
          });

          expect(triple.value).toEqual({ type: "ref", value: "company-1" });
          return triple;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toBeDefined();
    });
  });

  describe("assertBatch", () => {
    it("should create multiple triples", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const triples = yield* store.assertBatch([
            { entityId: eid("person-1"), attribute: ":name", value: string("Alice") },
            { entityId: eid("person-1"), attribute: ":age", value: number(30) },
            { entityId: eid("person-1"), attribute: ":active", value: boolean(true) },
          ]);

          expect(triples).toHaveLength(3);
          return triples;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toHaveLength(3);
    });
  });

  describe("getTriple", () => {
    it("should retrieve a triple by id", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const created = yield* store.assert({
            entityId: eid("person-1"),
            attribute: ":name",
            value: string("Alice"),
          });

          const retrieved = yield* store.get(created.id);

          expect(retrieved).not.toBeNull();
          expect(retrieved?.id).toBe(created.id);
          expect(retrieved?.value).toEqual({ type: "string", value: "Alice" });
          return retrieved;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toBeDefined();
    });

    it("should return null for non-existent triple", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const retrieved = yield* store.get("non-existent" as TripleId);
          return retrieved;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toBeNull();
    });
  });

  describe("getEntity", () => {
    it("should retrieve all triples for an entity", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          yield* store.assertBatch([
            { entityId: eid("person-1"), attribute: ":name", value: string("Alice") },
            { entityId: eid("person-1"), attribute: ":age", value: number(30) },
            { entityId: eid("person-2"), attribute: ":name", value: string("Bob") },
          ]);

          const triples = yield* store.entity("person-1" as EntityId);

          expect(triples).toHaveLength(2);
          return triples;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toHaveLength(2);
    });
  });

  describe("retract", () => {
    it("should soft-delete a triple", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const created = yield* store.assert({
            entityId: eid("person-1"),
            attribute: ":name",
            value: string("Alice"),
          });

          yield* store.retract(created.id);

          const retrieved = yield* store.get(created.id);
          expect(retrieved).toBeNull();

          // But history should still have it
          const history = yield* store.history("person-1" as EntityId);
          expect(history).toHaveLength(1);
          expect(Option.isSome(history[0]!.retractedAt)).toBe(true);

          return history;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toHaveLength(1);
    });
  });

  describe("runtime injection", () => {
    it("should use injected clock and tx-id generator for writes", async () => {
      let now = 1_000;
      let txCounter = 0;
      let tripleCounter = 0;

      const RuntimeLayer = Layer.succeed(TripleStoreRuntime, {
        scope: "test:triples-sql",
        now: Effect.sync(() => {
          now += 10;
          return now;
        }),
        nextTripleId: Effect.sync(() => TripleId.make(String(++tripleCounter).padStart(26, "0"))),
        nextTxId: Effect.sync(() =>
          TransactionId.make(`_tx/${String(++txCounter).padStart(26, "0")}`),
        ),
      });

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const batch = yield* store.assertBatch([
            { entityId: eid("person-1"), attribute: ":name", value: string("Alice") },
            { entityId: eid("person-1"), attribute: ":age", value: number(30) },
          ]);

          expect(batch).toHaveLength(2);
          expect(batch[0]!.recordedAt).toBe(1010);
          expect(batch[1]!.recordedAt).toBe(1010);
          expect(batch[0]!.id).toBe("00000000000000000000000001");
          expect(batch[1]!.id).toBe("00000000000000000000000002");
          expect(Option.getOrNull(batch[0]!.txId)).toBe("_tx/00000000000000000000000001");

          const tx = yield* store.transact([
            {
              op: "assert",
              entityId: eid("person-2"),
              attribute: ":name",
              value: string("Bob"),
            },
          ]);

          expect(tx.txId).toBe("_tx/00000000000000000000000002");
          expect(tx.position).toBe(2);

          const txPosition = yield* store.match({
            entityId: eid(tx.txId),
            attribute: TxAttributes.POSITION,
          });
          expect(txPosition).toHaveLength(1);
          expect(txPosition[0]!.id).toBe("00000000000000000000000009");
          expect(txPosition[0]!.value).toEqual({ type: "number", value: 2 });

          const txMeta = yield* store.match({
            entityId: eid(tx.txId),
            attribute: TxAttributes.INSTANT,
          });
          expect(txMeta).toHaveLength(1);
          expect(txMeta[0]!.id).toBe("00000000000000000000000010");
          expect(txMeta[0]!.value).toEqual({ type: "datetime", value: 1020 });

          yield* store.retract(batch[0]!.id);
          const history = yield* store.history("person-1" as EntityId);
          const retracted = history.find((triple) => triple.id === batch[0]!.id);
          expect(retracted).toBeDefined();
          expect(Option.getOrNull(retracted!.retractTxId)).toBe("_tx/00000000000000000000000003");
          // The two current-state reads resolve business time through the
          // injected clock before the retraction allocates its own instant.
          expect(Option.getOrNull(retracted!.retractedAt)).toBe(1050);
        }).pipe(Effect.provide(makeRuntimeTestLayer(RuntimeLayer))),
      );

      expect(result).toBeUndefined();
    });

    it("should provide deterministic clock, tx ids, and triple ids", async () => {
      const RuntimeLayer = DeterministicTripleStoreRuntimeLive({
        now: 123_456,
        idSeed: "unit",
      });

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const triple = yield* store.assert({
            entityId: eid("person-1"),
            attribute: ":name",
            value: string("Alice"),
          });

          expect(triple.id).toBe("00W1X84B000000000000000001");
          expect(triple.recordedAt).toBe(123_456);
          expect(Option.getOrNull(triple.txId)).toBe("_tx/0051DTYX000000000000000001");

          const tx = yield* store.transact([
            { op: "assert", entityId: eid("person-2"), attribute: ":name", value: string("Bob") },
          ]);

          expect(tx.txId).toBe("_tx/0051DTYX000000000000000002");
          expect(tx.triples[0]!.id).toBe("00W1X84B000000000000000006");
        }).pipe(Effect.provide(makeRuntimeTestLayer(RuntimeLayer))),
      );
    });

    it("keeps paged results stable when every transaction has the same millisecond", async () => {
      let txCounter = 0;
      let tripleCounter = 0;
      const RuntimeLayer = Layer.succeed(TripleStoreRuntime, {
        scope: "test:sqlite-pagination-position",
        now: Effect.succeed(1_800_000_000_000),
        nextTripleId: Effect.sync(() => TripleId.make(String(++tripleCounter).padStart(26, "0"))),
        nextTxId: Effect.sync(() =>
          TransactionId.make(`_tx/${String(++txCounter).padStart(26, "0")}`),
        ),
      });

      const pages = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const seeded = yield* store.assertBatch(
            ["a", "b", "c", "d"].map((suffix, index) => ({
              entityId: eid(`same-time:${suffix}`),
              attribute: ":page/rank",
              value: number(index === 3 ? 2 : 1),
            })),
          );
          const query = {
            inner: {
              find: ["?entity", "?rank"],
              where: [["?entity", ":page/rank", "?rank"]],
            },
            orderBy: [{ variable: "?rank", direction: "asc" }],
            limit: 2,
          } as const;

          const first = yield* store.queryPage(query);
          yield* store.assert({
            entityId: eid("same-time:later"),
            attribute: ":page/rank",
            value: number(0),
          });
          yield* store.retract(seeded[2]!.id);
          const second = yield* store.queryPage({ ...query, cursor: first.nextCursor });
          return { first, second };
        }).pipe(Effect.provide(makeRuntimeTestLayer(RuntimeLayer))),
      );

      expect(pages.first.results.map((row) => row["?entity"])).toEqual([
        "same-time:a",
        "same-time:b",
      ]);
      expect(pages.second.results.map((row) => row["?entity"])).toEqual([
        "same-time:c",
        "same-time:d",
      ]);
    });
  });

  describe("transaction journal", () => {
    it("owns causal audit records independently of entity snapshots", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;
          const created = yield* store.transact(
            [
              {
                op: "assert",
                entityId: eid("person:audit"),
                entityType: "Person",
                attribute: ":person/name",
                value: string("Alice"),
              },
              {
                op: "assert",
                entityId: eid("person:audit"),
                entityType: "Person",
                attribute: ":person/age",
                value: number(42),
                validFrom: 1_700_000_000_000,
              },
            ],
            {
              actor: "agent:auditor",
              commandId: "person:create",
              correlationId: "case:1",
              configSnapshot: "sha256-config",
            },
          );
          const age = created.triples.find((triple) => triple.attribute === ":person/age")!;
          const corrected = yield* store.transact(
            [
              { op: "retract", id: age.id },
              {
                op: "assert",
                entityId: eid("person:audit"),
                entityType: "Person",
                attribute: ":person/age",
                value: number(43),
                validFrom: 1_700_000_000_000,
              },
            ],
            { causationId: created.txId },
          );

          return {
            created,
            corrected,
            createdRecord: yield* store.transaction(created.txId),
            correctedRecord: yield* store.transaction(corrected.txId),
            commandRecord: yield* store.transactionByCommand("person:create"),
            page: yield* store.transactions({ after: created.position }),
          };
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.createdRecord).toEqual(
        expect.objectContaining({
          actor: "agent:auditor",
          commandId: "person:create",
          correlationId: "case:1",
          configSnapshot: "sha256-config",
          changes: expect.arrayContaining([
            expect.objectContaining({
              op: "assert",
              entityId: eid("person:audit"),
              attribute: ":person/age",
              value: number(42),
              validFrom: 1_700_000_000_000,
            }),
          ]),
        }),
      );
      expect(result.correctedRecord).toEqual(
        expect.objectContaining({
          causationId: result.created.txId,
          changes: expect.arrayContaining([
            expect.objectContaining({ op: "retract", tripleId: result.created.triples[1]!.id }),
            expect.objectContaining({
              op: "assert",
              attribute: ":person/age",
              value: number(43),
            }),
          ]),
        }),
      );
      expect(result.commandRecord?.txId).toBe(result.created.txId);
      expect(result.page.transactions.map((record) => record.txId)).toEqual([
        result.corrected.txId,
      ]);
    });
  });

  describe("query", () => {
    it("should query by entity type", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          yield* store.assertBatch([
            {
              entityId: eid("person-1"),
              attribute: ":name",
              value: string("Alice"),
              entityType: "Person",
            },
            {
              entityId: eid("person-2"),
              attribute: ":name",
              value: string("Bob"),
              entityType: "Person",
            },
            {
              entityId: eid("company-1"),
              attribute: ":name",
              value: string("Acme"),
              entityType: "Company",
            },
          ]);

          const people = yield* store.match({ entityType: "Person" });

          expect(people).toHaveLength(2);
          return people;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toHaveLength(2);
    });

    it("should query by attribute", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          yield* store.assertBatch([
            { entityId: eid("person-1"), attribute: ":name", value: string("Alice") },
            { entityId: eid("person-1"), attribute: ":age", value: number(30) },
            { entityId: eid("person-2"), attribute: ":name", value: string("Bob") },
          ]);

          const names = yield* store.match({ attribute: ":name" });

          expect(names).toHaveLength(2);
          return names;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toHaveLength(2);
    });

    it("should query by value", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          yield* store.assertBatch([
            { entityId: eid("person-1"), attribute: ":name", value: string("Alice") },
            { entityId: eid("person-2"), attribute: ":name", value: string("Alice") },
            { entityId: eid("person-3"), attribute: ":name", value: string("Bob") },
          ]);

          const alices = yield* store.match({ value: string("Alice") });

          expect(alices).toHaveLength(2);
          return alices;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toHaveLength(2);
    });
  });

  describe("time travel", () => {
    it("should query entity state as of a specific time", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          // Create initial state
          const first = yield* store.assert({
            entityId: eid("person-1"),
            attribute: ":name",
            value: string("Alice"),
          });

          const timeAfterFirst = Date.now();

          // Wait a bit to ensure different timestamp
          yield* Effect.sleep("10 millis");

          // Retract and add new value
          yield* store.retract(first.id);
          yield* store.assert({
            entityId: eid("person-1"),
            attribute: ":name",
            value: string("Alice Smith"),
          });

          // Query as of before the change
          const pastState = yield* store.match(
            { entityId: eid("person-1") },
            { recordedAt: timeAfterFirst, validAt: timeAfterFirst },
          );

          expect(pastState).toHaveLength(1);
          expect(pastState[0]!.value).toEqual({ type: "string", value: "Alice" });

          // Query current state
          const currentState = yield* store.entity("person-1" as EntityId);
          expect(currentState).toHaveLength(1);
          expect(currentState[0]!.value).toEqual({ type: "string", value: "Alice Smith" });

          return { pastState, currentState };
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result.pastState).toHaveLength(1);
      expect(result.currentState).toHaveLength(1);
    });

    it("should get full entity history", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Triples;

          const first = yield* store.assert({
            entityId: eid("person-1"),
            attribute: ":name",
            value: string("Alice"),
          });

          yield* Effect.sleep("5 millis");
          yield* store.retract(first.id);

          yield* Effect.sleep("5 millis");
          yield* store.assert({
            entityId: eid("person-1"),
            attribute: ":name",
            value: string("Alice Smith"),
          });

          const history = yield* store.history("person-1" as EntityId);

          expect(history).toHaveLength(2);
          // First one should be retracted
          expect(Option.isSome(history[0]!.retractedAt)).toBe(true);
          // Second one should be active
          expect(Option.isNone(history[1]!.retractedAt)).toBe(true);

          return history;
        }).pipe(Effect.provide(TestLayer)),
      );

      expect(result).toHaveLength(2);
    });
  });
});
