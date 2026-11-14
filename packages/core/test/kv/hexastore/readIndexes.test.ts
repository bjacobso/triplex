import { expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { makeTestKvBackend } from "../../../src/kv/kv/InMemoryKvBackend.js";
import { createKvTripleStore, type Datom } from "../../../src/kv/hexastore/KvTripleStore.js";
import {
  dependencyProjections,
  journalInstantEntries,
  recordedPositionAt,
  READ_INDEX_READY,
} from "../../../src/kv/hexastore/readIndexes.js";
import { resolveRecordedBasis } from "../../../src/store/recordedBasis.js";

const datom = (position: number, instant: number): Datom => ({
  tripleId: `fact-${position}`,
  entity: `entity-${position}`,
  attribute: ":test/at",
  entityType: null,
  value: { type: "datetime", value: instant },
  txId: `tx-${position}`,
  recordedAt: instant,
  recordedPosition: position,
  validFrom: instant,
  validTo: null,
  retractedAt: null,
  retractedPosition: null,
  retractTxId: null,
  createdBy: null,
});

it("seeks only bounded journal index ranges at a captured head, including negative instants and rollback", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const kv = makeTestKvBackend();
      // The journal writes these entries with each transaction's entry.
      yield* kv.setAll(
        [
          [1, -100],
          [2, 200],
          [3, 100],
          [4, 100],
        ].flatMap(([position, instant]) => journalInstantEntries(instant!, position!)),
      );
      let seeks = 0;
      const indexed = {
        ...kv,
        getRange: (options: Parameters<typeof kv.getRange>[0]) => {
          seeks++;
          expect(options.start[0]).toBe(0x0a);
          expect(options.limit).toBe(1);
          expect(options.reverse).toBe(true);
          return kv.getRange(options);
        },
      };
      expect(yield* recordedPositionAt(indexed, 100, 3)).toBe(3);
      expect(yield* recordedPositionAt(indexed, 100, 4)).toBe(4);
      expect(yield* recordedPositionAt(indexed, -101, 4)).toBe(0);
      expect(yield* recordedPositionAt(indexed, -100, 4)).toBe(1);
      expect(seeks).toBeLessThanOrEqual(4 * 65);
    }),
  );
});

it("backfills read indexes once and retains retraction metadata without reading fact payloads", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const kv = makeTestKvBackend();
      const store = createKvTripleStore(kv);
      yield* store.assert(datom(1, 100));
      yield* store.retract("fact-1", 200, "tx-2", 2);
      // Simulate an existing store with only the pre-upgrade indexes.
      for (const prefix of [0x09, 0x0a]) {
        const rows = yield* Stream.runCollect(
          kv.getRange({ start: new Uint8Array([prefix]), end: new Uint8Array([prefix + 1]) }),
        );
        for (const [key] of rows) yield* kv.delete(key);
      }
      yield* store.initializeReadIndexes();
      expect(yield* kv.get(READ_INDEX_READY)).not.toBeNull();
      // Facts never enter the journal's instant trie.
      expect(yield* recordedPositionAt(kv, 100, 2)).toBe(0);
      const projected = yield* dependencyProjections({
        ...kv,
        getRange: (options) => {
          expect(options.start[0]).toBe(0x09);
          return kv.getRange(options);
        },
      });
      expect(projected).toEqual([
        {
          recordedAt: 100,
          recordedPosition: 1,
          retractedAt: 200,
          retractedPosition: 2,
          validFrom: 100,
          validTo: null,
        },
      ]);
      yield* store.initializeReadIndexes();
      expect(yield* dependencyProjections(kv)).toEqual(projected);
    }),
  );
});

it("captures the head exactly once and passes that cut to the timestamp seek", async () => {
  let captures = 0;
  expect(
    await Effect.runPromise(
      resolveRecordedBasis(
        () =>
          Effect.sync(() => {
            captures++;
            return 7;
          }),
        (instant, head) => {
          expect([instant, head]).toEqual([150, 7]);
          return Effect.succeed(4);
        },
        Effect.succeed(200),
        { recordedAt: 150 },
      ),
    ),
  ).toEqual({ recordedPosition: 4 });
  expect(captures).toBe(1);
});
