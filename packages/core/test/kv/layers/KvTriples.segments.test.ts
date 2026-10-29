/**
 * Segment attachments behind the `Triples` contract, on the in-memory KV backend.
 */

import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { Triples } from "../../../src/store/Triples.js";
import { KvTriplesLive } from "../../../src/kv/layers/KvTriplesLive.js";
import { KvBackend } from "../../../src/kv/kv/KvBackend.js";
import { makeTestKvBackend } from "../../../src/kv/kv/InMemoryKvBackend.js";
import { DeterministicTripleStoreRuntimeLive } from "../../../src/store/TripleStoreRuntime.js";
import { Import, PositionRef, Segment } from "../../../src/operational/index.js";
import type { EntityId, TripleInput } from "../../../src/Triple.js";

const layer = () =>
  KvTriplesLive.pipe(
    Layer.provide(DeterministicTripleStoreRuntimeLive({ now: 1_000 })),
    Layer.provide(Layer.sync(KvBackend, makeTestKvBackend)),
  );
const run = <A, E>(effect: Effect.Effect<A, E, Triples>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer())));

const eid = (id: string) => id as EntityId;
const num = (value: number) => ({ type: "number" as const, value });
const str = (value: string) => ({ type: "string" as const, value });

const facts: TripleInput[] = [
  {
    entityId: eid("w:1"),
    attribute: ":w/name",
    value: str("Ada"),
    entityType: "Worker",
    validFrom: 0,
  },
  { entityId: eid("w:1"), attribute: ":w/rate", value: num(10), validFrom: 0, validTo: 500 },
  { entityId: eid("w:1"), attribute: ":w/rate", value: num(12), validFrom: 500 },
  {
    entityId: eid("w:2"),
    attribute: ":w/name",
    value: str("Bo"),
    entityType: "Worker",
    validFrom: 0,
  },
  {
    entityId: eid("w:2"),
    attribute: ":w/site",
    value: { type: "ref", value: eid("s:1") },
    validFrom: 0,
  },
];

const values = (rows: readonly { readonly value: { readonly value: unknown } }[]) =>
  rows.map((row) => row.value.value).sort();

describe("segment attachments", () => {
  it("merge with transacted facts in every read path, at any basis", async () => {
    await run(
      Effect.gen(function* () {
        const t = yield* Triples;
        const before = yield* t.transact([
          {
            op: "assert",
            entityId: eid("w:1"),
            attribute: ":w/badge",
            value: str("B1"),
            validFrom: 0,
          },
        ]);
        const segment = Segment.build(facts);
        const attached = yield* Segment.attach(t, segment, { actor: "loader" });
        expect(attached.triples).toHaveLength(0);
        expect(attached.summary?.segments).toEqual([segment.id]);

        // Latest state, at two valid times either side of the closed interval.
        expect(values(yield* t.entity(eid("w:1"), { validAt: 100 }))).toEqual([10, "Ada", "B1"]);
        expect(values(yield* t.entity(eid("w:1"), { validAt: 600 }))).toEqual([12, "Ada", "B1"]);
        expect(values(yield* t.match({ attribute: ":w/name" }, { validAt: 1 }))).toEqual([
          "Ada",
          "Bo",
        ]);
        expect(
          (yield* t.match({ attribute: ":w/rate", value: num(12) }, { validAt: 600 })).map(
            (row) => row.entityId,
          ),
        ).toEqual(["w:1"]);
        expect(
          (yield* t.match({ value: { type: "ref", value: eid("s:1") } })).map(
            (row) => row.entityId,
          ),
        ).toEqual(["w:2"]);
        expect(
          (yield* t.match({ entityType: "Worker" })).map((row) => row.entityId).sort(),
        ).toEqual(["w:1", "w:2"]);
        const [one, missing] = yield* t.entities([eid("w:2"), eid("w:9")], { validAt: 1 });
        expect(one).toHaveLength(2);
        expect(missing).toHaveLength(0);

        // Recorded time: before the attachment, only the transacted fact.
        expect(
          values(yield* t.entity(eid("w:1"), { recordedPosition: before.position, validAt: 100 })),
        ).toEqual(["B1"]);
        // The fixed test clock records everything at one instant, so `recordedAt` can't separate them.
        expect(
          yield* t.entity(eid("w:1"), { recordedAt: attached.instant - 1, validAt: 100 }),
        ).toEqual([]);

        // Datalog joins segment facts with transacted ones and binds the attaching transaction.
        const { results } = yield* t.queryAll(
          {
            find: ["?name", "?badge", "?tx"],
            where: [
              ["?w", ":w/name", "?name", "?tx"],
              ["?w", ":w/badge", "?badge"],
            ],
          },
          { basis: { validAt: 1 } },
        );
        expect(results).toEqual([{ "?name": "Ada", "?badge": "B1", "?tx": attached.txId }]);

        const page = yield* t.entityPage({ entityType: "Worker", limit: 1 });
        expect(page.entities[0]!.map((row) => row.entityId)).toContain("w:1");
        expect(page.nextCursor).toBeDefined();

        // Facts carry the attachment's recorded time and actor.
        const [name] = yield* t.match(
          { entityId: eid("w:2"), attribute: ":w/name" },
          { validAt: 1 },
        );
        expect(name!.recordedAt).toBe(attached.instant);
        expect(Option.getOrNull(name!.txId)).toBe(attached.txId);
        expect(Option.getOrNull(name!.createdBy)).toBe("loader");
        expect((yield* t.get(name!.id))?.value).toEqual(str("Bo"));
      }),
    );
  });

  it("retract segment facts as history", async () => {
    await run(
      Effect.gen(function* () {
        const t = yield* Triples;
        yield* Segment.attach(t, Segment.build(facts));
        const [name] = yield* t.match(
          { entityId: eid("w:2"), attribute: ":w/name" },
          { validAt: 1 },
        );
        const retraction = yield* t.transact([{ op: "retract", id: name!.id }]);
        expect(retraction.retracted).toBe(1);

        expect(
          yield* t.match({ entityId: eid("w:2"), attribute: ":w/name" }, { validAt: 1 }),
        ).toEqual([]);
        // Still visible before the retraction, and kept in history.
        expect(
          values(
            yield* t.match(
              { entityId: eid("w:2"), attribute: ":w/name" },
              { recordedPosition: retraction.position - 1, validAt: 1 },
            ),
          ),
        ).toEqual(["Bo"]);
        const history = yield* t.history(eid("w:2"));
        expect(history.find((row) => row.id === name!.id)?.retractedAt).toEqual(
          Option.some(retraction.instant),
        );
        const record = yield* t.transaction(retraction.txId);
        expect(record?.changes.map((change) => [change.op, change.tripleId])).toEqual([
          ["retract", name!.id],
        ]);
        // Retracting it again is a no-op, like any retracted fact.
        expect((yield* t.transact([{ op: "retract", id: name!.id }])).retracted).toBe(0);
      }),
    );
  });

  it("journal one attach record and derive its changes on demand", async () => {
    await run(
      Effect.gen(function* () {
        const t = yield* Triples;
        const segment = Segment.build(facts);
        const ordinary = yield* t.transact([
          { op: "assert", entityId: eid("w:1"), attribute: ":w/badge", value: str("B1") },
        ]);
        const attached = yield* Segment.attach(t, segment, {
          actor: "loader",
          commandId: "load:1",
        });

        const feed = yield* t.transactions({ after: ordinary.position });
        expect(feed.transactions).toHaveLength(1);
        const [entry] = feed.transactions;
        expect(entry!.changes).toEqual([]);
        expect(entry!.summary).toEqual({
          asserted: 5,
          retracted: 0,
          attributes: [":w/name", ":w/rate", ":w/site"],
          digest: segment.id,
          segments: [segment.id],
        });
        expect(entry!.actor).toBe("loader");

        const record = yield* t.transaction(attached.txId);
        expect(record?.changes).toHaveLength(5);
        expect(record?.changes.every((change) => change.op === "assert")).toBe(true);
        expect(record?.changes.map((change) => change.entityId).sort()).toEqual(
          facts.map((f) => f.entityId).sort(),
        );
        expect((yield* t.transactionByCommand("load:1"))?.txId).toBe(attached.txId);
        const again = yield* Segment.attach(t, segment, { commandId: "load:1" }).pipe(Effect.flip);
        expect(again._tag).toBe("CommandAlreadyCommittedError");

        const entityHistory = yield* t.transactionsForEntity(eid("w:1"));
        expect(entityHistory.transactions.map((tx) => tx.txId)).toEqual([
          attached.txId,
          ordinary.txId,
        ]);
        const paged = yield* t.transactionsForEntity(eid("w:1"), { limit: 1 });
        expect(paged.transactions.map((tx) => tx.txId)).toEqual([attached.txId]);
        expect(paged.nextBeforePosition).toBe(attached.position);
        expect((yield* t.transactionsForEntity(eid("w:2"))).transactions).toHaveLength(1);
      }),
    );
  });

  it("refuse reserved facts and extra operations", async () => {
    await run(
      Effect.gen(function* () {
        const t = yield* Triples;
        const reserved = yield* Segment.attach(
          t,
          Segment.build([{ entityId: eid("_triplex/x"), attribute: ":a/b", value: num(1) }]),
        ).pipe(Effect.flip);
        expect(reserved._tag).toBe("WriteError");
        const reservedAttribute = yield* Segment.attach(
          t,
          Segment.build([{ entityId: eid("x"), attribute: ":_tx/position", value: num(1) }]),
        ).pipe(Effect.flip);
        expect(reservedAttribute._tag).toBe("WriteError");
        expect(yield* t.currentPosition()).toBe(0);
      }),
    );
  });

  it("import in chunks and publish through a ref without partial reads", async () => {
    await run(
      Effect.gen(function* () {
        const t = yield* Triples;
        const generation = (n: number) =>
          Array.from({ length: 30 }, (_, i) => ({
            entityId: eid(`w:${i}`),
            attribute: ":w/generation",
            value: num(n),
            validFrom: 0,
          }));
        const atRef = PositionRef.basis(t, "live", { validAt: 1 }).pipe(
          Effect.flatMap((basis) => t.match({ attribute: ":w/generation" }, basis)),
        );

        const first = yield* Import.run(t, generation(1), {
          store: "segments",
          chunkSize: 7,
          ref: "live",
          expectedRefPosition: null,
        });
        expect(first.chunks).toBe(5);
        expect((yield* atRef).length).toBe(30);
        const firstBasis = yield* PositionRef.basis(t, "live", { validAt: 1 });

        const midway: number[] = [];
        const second = yield* Import.run(t, generation(2), {
          store: "segments",
          chunkSize: 7,
          ref: "live",
          expectedRefPosition: first.lastPosition,
          onProgress: () =>
            atRef.pipe(
              Effect.map((rows) => {
                midway.push(rows.filter((row) => row.value.value === 2).length);
              }),
            ),
        });
        expect(midway).toEqual([0, 0, 0, 0, 0]);
        const published = yield* atRef;
        expect(published.filter((row) => row.value.value === 2)).toHaveLength(30);
        expect(published).toHaveLength(60);

        // Reading at the previous publication is unchanged.
        expect((yield* t.match({ attribute: ":w/generation" }, firstBasis)).length).toBe(30);

        const moves = (yield* t.transactions({ after: second.lastPosition })).transactions;
        expect(moves).toHaveLength(1);
        expect(second.ref?.position).toBe(second.lastPosition);
      }),
    );
  });

  it("attach a decoded image", async () => {
    await run(
      Effect.gen(function* () {
        const t = yield* Triples;
        const image = Segment.encode(Segment.build(facts));
        const segment = Segment.decode(image, { verify: true });
        yield* Segment.attach(t, segment);
        expect(values(yield* t.entity(eid("w:2"), { validAt: 1 }))).toEqual(["Bo", "s:1"]);
      }),
    );
  });
});
