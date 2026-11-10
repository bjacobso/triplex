import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { EntityId, Triples } from "../../src/index.js";
import { Outbox } from "../../src/operational/index.js";
import { Domain, hash } from "../../src/content/ContentId.js";
import { encodeOrThrow } from "../../src/content/CanonicalJson.js";
import { KvBackend, type KvBackendService, type KvTransaction } from "../../src/kv/kv/KvBackend.js";
import { makeTestKvBackend } from "../../src/kv/kv/InMemoryKvBackend.js";
import { makeKvOperationalEntryStorage } from "../../src/kv/kv/OperationalEntries.js";
import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import { TripleStoreRuntimeLayer } from "../../src/store/TripleStoreRuntime.js";

const scope = EntityId.make("entries:cost");

describe("indexed operational entries on KV", () => {
  it.each([10, 10000])(
    "bounds entry operations with %i acknowledged history records",
    { timeout: 30000 },
    async (history) => {
      const backend = makeTestKvBackend();
      const counts = { get: 0, set: 0, delete: 0, ranges: 0, yielded: 0 };
      const entryKey = (key: Uint8Array) => key[0]! >= 0x23 && key[0]! <= 0x25;
      const instrument = (kv: KvTransaction): KvTransaction => ({
        get: (key) => {
          if (entryKey(key)) counts.get++;
          return kv.get(key);
        },
        set: (key, value) => {
          if (entryKey(key)) counts.set++;
          return kv.set(key, value);
        },
        delete: (key) => {
          if (entryKey(key)) counts.delete++;
          return kv.delete(key);
        },
        getRange: (range) => {
          if (!entryKey(range.start)) return kv.getRange(range);
          counts.ranges++;
          expect(range.limit).toBe(2);
          return kv.getRange(range).pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                counts.yielded++;
              }),
            ),
          );
        },
      });
      const measured: KvBackendService = {
        ...backend,
        ...instrument(backend),
        transact: (run) => backend.transact((tx) => run(instrument(tx))),
      };
      const reset = () => {
        for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
      };
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const t = yield* Triples;
          yield* t.transact([
            Outbox.append({ scope, idempotencyKey: "template", payload: "original" }),
          ]);
          const seed = makeKvOperationalEntryStorage(backend);
          const template = (yield* seed.getOperationalEntry(Outbox.id(scope, "template")))!;
          yield* t.transact([Outbox.acknowledge(template.id)]);
          for (let i = 1; i < history; i++) {
            const key = `history:${i}`;
            yield* seed.insertOperationalEntry({
              ...template,
              id: Outbox.id(scope, key),
              idempotencyKey: key,
            });
            yield* seed.acknowledgeOperationalEntry(
              Outbox.id(scope, key),
              template.recordedPosition,
              template.recordedAt,
              template.txId,
            );
          }
          reset();
          yield* t.transact([
            Outbox.append({ scope, idempotencyKey: "pending", payload: { redelivery: true } }),
          ]);
          const append = { ...counts };
          reset();
          expect((yield* Outbox.pending(t, { scope, limit: 1 })).entries).toHaveLength(1);
          expect((yield* Outbox.pending(t, { limit: 1 })).entries).toHaveLength(1);
          const pending = { ...counts };
          reset();
          yield* t.transact([Outbox.acknowledge(Outbox.id(scope, "pending"))]);
          return { append, pending, ack: { ...counts } };
        }).pipe(
          Effect.provide(
            KvTriples.layerBackend.pipe(
              Layer.provide(Layer.succeed(KvBackend, measured)),
              Layer.provide(TripleStoreRuntimeLayer),
            ),
          ),
        ),
      );
      expect(result).toEqual({
        append: { get: 1, set: 3, delete: 0, ranges: 0, yielded: 0 },
        pending: { get: 2, set: 0, delete: 0, ranges: 2, yielded: 2 },
        ack: { get: 2, set: 1, delete: 2, ranges: 0, yielded: 0 },
      });
    },
  );

  it("binds pending cursors to the database scope", async () => {
    const cursor = await Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* Triples;
        yield* t.transact(
          [1, 2].map((payload) =>
            Outbox.append({ scope, idempotencyKey: String(payload), payload }),
          ),
        );
        return (yield* Outbox.pending(t, { limit: 1 })).nextCursor!;
      }).pipe(Effect.provide(KvTriples.layerWithScope("one"))),
    );
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* Triples;
        return yield* Outbox.pending(t, { cursor }).pipe(Effect.flip);
      }).pipe(Effect.provide(KvTriples.layerWithScope("two"))),
    );
    expect(error).toMatchObject({ _tag: "PaginationCursorError", reason: "scope_mismatch" });
  });

  it("separates Unicode scope identities", async () => {
    // Distinct ill-formed JS strings must not collapse through UTF-8 replacement.
    expect(hash(Domain.operationalScope, encodeOrThrow("\ud800"))).not.toBe(
      hash(Domain.operationalScope, encodeOrThrow("\ud801")),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* Triples;
        const a = EntityId.make("\ud800");
        const b = EntityId.make("\ud801");
        yield* t.transact([
          Outbox.append({ scope: a, idempotencyKey: "k", payload: 1 }),
          Outbox.append({ scope: b, idempotencyKey: "k", payload: 2 }),
        ]);
        expect((yield* Outbox.pending(t, { scope: a })).entries.map((e) => e.payload)).toEqual([1]);
        expect((yield* Outbox.pending(t, { scope: b })).entries.map((e) => e.payload)).toEqual([2]);
      }).pipe(Effect.provide(KvTriples.layer)),
    );
  });
});
