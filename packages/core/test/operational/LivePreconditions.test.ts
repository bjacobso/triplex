import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { EntityId, Triples, number } from "../../src/index.js";
import { KvBackend, type KvBackendService } from "../../src/kv/kv/KvBackend.js";
import { makeTestKvBackend } from "../../src/kv/kv/InMemoryKvBackend.js";
import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import { createKvTripleStore, type Datom } from "../../src/kv/hexastore/KvTripleStore.js";
import {
  LIVE_FACT_PREFIX,
  LIVE_FACT_READY_KEY,
  LIVE_FACT_CURSOR_KEY,
  metaKey,
  liveFactRange,
} from "../../src/kv/hexastore/indexes.js";
import { TripleStoreRuntimeLayer } from "../../src/store/TripleStoreRuntime.js";

const entityId = EntityId.make("guard:legacy");
const datom = (i: number): Datom => ({
  tripleId: `legacy:${String(i).padStart(6, "0")}`,
  entity: entityId,
  attribute: ":guard/version",
  value: number(i),
  txId: "legacy",
  recordedAt: i,
  recordedPosition: i + 1,
  validFrom: 0,
  validTo: null,
  createdBy: null,
  retractedAt: null,
  retractedPosition: null,
  retractTxId: null,
  entityType: null,
});
const layer = (kv: KvBackendService) =>
  KvTriples.layerBackend.pipe(
    Layer.provide(Layer.succeed(KvBackend, kv)),
    Layer.provide(TripleStoreRuntimeLayer),
  );

describe("KV live precondition index", () => {
  it("reads only two live facts despite 1,000 retracted assertions", async () => {
    const kv = makeTestKvBackend();
    const store = createKvTripleStore(kv);
    let yielded = 0;
    const measured: KvBackendService = {
      ...kv,
      getRange: (range) =>
        kv.getRange(range).pipe(
          Stream.tap(() =>
            Effect.sync(() => {
              yielded++;
            }),
          ),
        ),
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        for (let i = 0; i < 1000; i++) {
          yield* store.assert(datom(i));
          yield* store.retract(datom(i).tripleId, 1001, "ret", 1001);
        }
        yield* store.assertBatch([
          { ...datom(1000), txId: "_tx/00000000000000000000000001", validFrom: 0, validTo: 1 },
          {
            ...datom(1001),
            txId: "_tx/00000000000000000000000001",
            validFrom: Date.now() + 1000000,
          },
        ]);
        yield* kv.set(LIVE_FACT_READY_KEY, new Uint8Array([1]));
        const t = yield* Triples;
        expect((yield* t.liveFacts(entityId)).map((f) => f.id).sort()).toEqual([
          datom(1000).tripleId,
          datom(1001).tripleId,
        ]);
        expect(yielded).toBe(2);
      }).pipe(Effect.provide(layer(measured))),
    );
  });

  it("resumes a bounded legacy backfill while upgraded writers maintain the index", async () => {
    const kv = makeTestKvBackend();
    const store = createKvTripleStore(kv);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.assertBatch([datom(0), datom(1), datom(2), datom(3)]);
        yield* store.retract(datom(0).tripleId, 5, "retraction", 5);
        // Reproduce old stores: META/history exist without any LIVE keys or marker.
        const keys = yield* Stream.runCollect(
          kv.getRange({ start: LIVE_FACT_PREFIX, end: new Uint8Array([7]) }),
        );
        for (const [key] of keys) yield* kv.delete(key);
        yield* kv.delete(LIVE_FACT_READY_KEY);
        const t = yield* Triples;
        const unavailable = yield* t
          .transact([], {
            preconditions: [{ _tag: "AttributeAbsent", entityId, attribute: ":missing" }],
          })
          .pipe(Effect.result);
        expect(unavailable._tag === "Failure" && unavailable.failure.message).toContain(
          "migrateLiveFacts",
        );
        const first = yield* KvTriples.migrateLiveFacts({ batchSize: 2 });
        expect(first).toEqual({ complete: false, processed: 2 });
        // The next batch must see a retraction of a record already backfilled,
        // and inserts before its cursor must already have their own live key.
        yield* store.retract(datom(1).tripleId, 6, "retraction", 6);
        yield* store.assert({
          ...datom(4),
          tripleId: "before-cursor",
          attribute: ":guard/inserted",
        });
        const last = yield* KvTriples.migrateLiveFacts({ batchSize: 2 });
        expect(last).toEqual({ complete: true, processed: 2 });
        expect(yield* KvTriples.migrateLiveFacts({ batchSize: 2 })).toEqual({
          complete: true,
          processed: 0,
        });
        const live = yield* Stream.runCollect(kv.getRange(liveFactRange(entityId)));
        expect(live).toHaveLength(3);
        expect(
          (yield* store.livePreconditionFacts(entityId, ":guard/inserted", 2)).map(
            (d) => d.tripleId,
          ),
        ).toEqual(["before-cursor"]);
        yield* t.transact([], {
          preconditions: [
            { _tag: "AttributeValue", entityId, attribute: ":guard/inserted", value: number(4) },
          ],
        });
        expect(yield* kv.get(LIVE_FACT_READY_KEY)).toEqual(new Uint8Array([1]));
        expect(
          yield* store.scanCollectAsync({ entity: entityId }, { includeRetracted: true }),
        ).toHaveLength(5);
      }).pipe(Effect.provide(layer(kv)), Effect.provideService(KvBackend, kv)),
    );
  });

  it("rolls back a failed backfill batch and refuses unknown index versions", async () => {
    const kv = makeTestKvBackend();
    const store = createKvTripleStore(kv);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.assert(datom(0));
        const keys = yield* Stream.runCollect(
          kv.getRange({ start: LIVE_FACT_PREFIX, end: new Uint8Array([7]) }),
        );
        for (const [key] of keys) yield* kv.delete(key);
        yield* kv.set(metaKey("z-corrupt"), new Uint8Array(0));
        const failed = yield* KvTriples.migrateLiveFacts({ batchSize: 10 }).pipe(Effect.result);
        expect(failed._tag === "Failure" && failed.failure._tag).toBe("MigrationError");
        expect(
          yield* Stream.runCollect(
            kv.getRange({ start: LIVE_FACT_PREFIX, end: new Uint8Array([7]) }),
          ),
        ).toHaveLength(0);
        expect(yield* kv.get(LIVE_FACT_CURSOR_KEY)).toBeNull();
        expect(yield* kv.get(LIVE_FACT_READY_KEY)).toBeNull();
        yield* kv.delete(metaKey("z-corrupt"));
        yield* kv.set(LIVE_FACT_READY_KEY, new Uint8Array([2]));
        const newer = yield* KvTriples.migrateLiveFacts().pipe(Effect.result);
        expect(newer._tag === "Failure" && newer.failure._tag).toBe("MigrationError");
        expect(yield* kv.get(LIVE_FACT_READY_KEY)).toEqual(new Uint8Array([2]));
        const invalid = yield* KvTriples.migrateLiveFacts({ batchSize: 0 }).pipe(Effect.result);
        expect(invalid._tag === "Failure" && invalid.failure._tag).toBe("MigrationError");
      }).pipe(Effect.provideService(KvBackend, kv)),
    );
  });

  it.each([10, 10000])(
    "bounds live reads with %i historical replacements and unrelated attributes",
    { timeout: 30000 },
    async (history) => {
      const kv = makeTestKvBackend();
      const store = createKvTripleStore(kv);
      let yielded = 0;
      let gets = 0;
      const measured: KvBackendService = {
        ...kv,
        get: (key) => {
          gets++;
          return kv.get(key);
        },
        getRange: (range) => {
          expect(range.limit).toBeLessThanOrEqual(2);
          return kv.getRange(range).pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                yielded++;
              }),
            ),
          );
        },
      };
      await Effect.runPromise(
        Effect.gen(function* () {
          for (let i = 0; i < history; i++) {
            yield* store.assert(datom(i));
            yield* store.retract(datom(i).tripleId, history + 1, "ret", history + 1);
          }
          yield* store.assert({ ...datom(history), tripleId: "live" });
          yield* store.assertBatch(
            Array.from({ length: history }, (_, i) => ({
              ...datom(i),
              tripleId: `other:${i}`,
              attribute: `:other/${i}`,
            })),
          );
          yield* kv.set(LIVE_FACT_READY_KEY, new Uint8Array([1]));
          const lookup = createKvTripleStore(measured);
          expect(
            (yield* lookup.livePreconditionFacts(entityId, ":guard/version", 2)).map(
              (d) => d.tripleId,
            ),
          ).toEqual(["live"]);
          expect(yield* lookup.livePreconditionFacts(entityId, ":missing", 1)).toHaveLength(0);
          expect(yield* lookup.livePreconditionFacts("missing-entity", undefined, 1)).toHaveLength(
            0,
          );
          expect(yielded).toBe(1);
          expect(gets).toBe(4); // Three readiness checks plus one META lookup.
        }),
      );
    },
  );
});
