import { describe, it, expect } from "vitest";
import { Effect, Stream } from "effect";
import { makeTestKvBackend } from "../../../src/kv/kv/InMemoryKvBackend.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const run = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect);

describe("InMemoryKvBackend", () => {
  describe("get/set", () => {
    it("returns null for missing keys", async () => {
      const kv = makeTestKvBackend();
      const result = await run(kv.get(enc("missing")));
      expect(result).toBeNull();
    });

    it("stores and retrieves a value", async () => {
      const kv = makeTestKvBackend();
      await run(kv.set(enc("key1"), enc("value1")));
      const result = await run(kv.get(enc("key1")));
      expect(result).toEqual(enc("value1"));
    });

    it("overwrites existing values", async () => {
      const kv = makeTestKvBackend();
      await run(kv.set(enc("key1"), enc("v1")));
      await run(kv.set(enc("key1"), enc("v2")));
      const result = await run(kv.get(enc("key1")));
      expect(result).toEqual(enc("v2"));
    });
  });

  describe("delete", () => {
    it("removes a key", async () => {
      const kv = makeTestKvBackend();
      await run(kv.set(enc("key1"), enc("value1")));
      await run(kv.delete(enc("key1")));
      const result = await run(kv.get(enc("key1")));
      expect(result).toBeNull();
    });

    it("no-ops on missing keys", async () => {
      const kv = makeTestKvBackend();
      await run(kv.delete(enc("missing")));
      // No error thrown
    });
  });

  describe("getRange", () => {
    it("returns entries in lexicographic order", async () => {
      const kv = makeTestKvBackend();
      await run(kv.set(enc("c"), enc("3")));
      await run(kv.set(enc("a"), enc("1")));
      await run(kv.set(enc("b"), enc("2")));

      const results = await run(Stream.runCollect(kv.getRange({ start: enc("a"), end: enc("d") })));

      const keys = Array.from(results).map(([k, _v]) => new TextDecoder().decode(k));
      expect(keys).toEqual(["a", "b", "c"]);
    });

    it("respects start (inclusive) and end (exclusive)", async () => {
      const kv = makeTestKvBackend();
      await run(kv.set(enc("a"), enc("1")));
      await run(kv.set(enc("b"), enc("2")));
      await run(kv.set(enc("c"), enc("3")));
      await run(kv.set(enc("d"), enc("4")));

      const results = await run(Stream.runCollect(kv.getRange({ start: enc("b"), end: enc("d") })));

      const keys = Array.from(results).map(([k, _v]) => new TextDecoder().decode(k));
      expect(keys).toEqual(["b", "c"]);
    });

    it("respects limit", async () => {
      const kv = makeTestKvBackend();
      await run(kv.set(enc("a"), enc("1")));
      await run(kv.set(enc("b"), enc("2")));
      await run(kv.set(enc("c"), enc("3")));

      const results = await run(
        Stream.runCollect(kv.getRange({ start: enc("a"), end: enc("z"), limit: 2 })),
      );

      expect(Array.from(results).length).toBe(2);
    });

    it("supports reverse scanning", async () => {
      const kv = makeTestKvBackend();
      await run(kv.set(enc("a"), enc("1")));
      await run(kv.set(enc("b"), enc("2")));
      await run(kv.set(enc("c"), enc("3")));

      const results = await run(
        Stream.runCollect(kv.getRange({ start: enc("a"), end: enc("d"), reverse: true })),
      );

      const keys = Array.from(results).map(([k, _v]) => new TextDecoder().decode(k));
      expect(keys).toEqual(["c", "b", "a"]);
    });

    it("returns empty for empty range", async () => {
      const kv = makeTestKvBackend();
      await run(kv.set(enc("a"), enc("1")));

      const results = await run(Stream.runCollect(kv.getRange({ start: enc("b"), end: enc("c") })));

      expect(Array.from(results).length).toBe(0);
    });

    it("collects a large cross-partition range without spreading into the call stack", async () => {
      const kv = makeTestKvBackend();
      const count = 150_000;
      const entries = Array.from({ length: count }, (_, index) => {
        const key = new Uint8Array(5);
        key[0] = 1;
        new DataView(key.buffer).setUint32(1, index);
        return [key, enc("v")] as const;
      });
      await run(kv.setAll(entries));

      const results = kv.getRangeSync!({
        start: new Uint8Array([1]),
        end: new Uint8Array([2]),
      });

      expect(results).toHaveLength(count);
    });
  });

  describe("transact", () => {
    it("commits writes atomically", async () => {
      const kv = makeTestKvBackend();

      await run(
        kv.transact((tx) =>
          Effect.gen(function* () {
            yield* tx.set(enc("k1"), enc("v1"));
            yield* tx.set(enc("k2"), enc("v2"));
          }),
        ),
      );

      expect(await run(kv.get(enc("k1")))).toEqual(enc("v1"));
      expect(await run(kv.get(enc("k2")))).toEqual(enc("v2"));
    });

    it("rolls back on error", async () => {
      const kv = makeTestKvBackend();
      await run(kv.set(enc("existing"), enc("original")));

      const result = await Effect.runPromiseExit(
        kv.transact((tx) =>
          Effect.gen(function* () {
            yield* tx.set(enc("existing"), enc("modified"));
            yield* tx.set(enc("new"), enc("value"));
            return yield* Effect.fail("boom" as const);
          }),
        ),
      );

      expect(result._tag).toBe("Failure");
      // Original value should be unchanged (writes weren't committed)
      expect(await run(kv.get(enc("existing")))).toEqual(enc("original"));
      expect(await run(kv.get(enc("new")))).toBeNull();
    });

    it("can read committed data within transaction", async () => {
      const kv = makeTestKvBackend();
      await run(kv.set(enc("pre"), enc("existing")));

      const readValue = await run(
        kv.transact((tx) =>
          Effect.gen(function* () {
            return yield* tx.get(enc("pre"));
          }),
        ),
      );

      expect(readValue).toEqual(enc("existing"));
    });

    it("can read own writes within transaction", async () => {
      const kv = makeTestKvBackend();

      const readValue = await run(
        kv.transact((tx) =>
          Effect.gen(function* () {
            yield* tx.set(enc("new"), enc("hello"));
            return yield* tx.get(enc("new"));
          }),
        ),
      );

      expect(readValue).toEqual(enc("hello"));
    });

    it("handles deletes in transactions", async () => {
      const kv = makeTestKvBackend();
      await run(kv.set(enc("k1"), enc("v1")));

      await run(
        kv.transact((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(enc("k1"));
          }),
        ),
      );

      expect(await run(kv.get(enc("k1")))).toBeNull();
    });
  });

  describe("incremental ordering", () => {
    const latin1 = (k: Uint8Array) => String.fromCharCode(...k);

    it("keeps range scans sorted across interleaved writes, overwrites and deletes", async () => {
      const kv = makeTestKvBackend();
      const model = new Map<string, Uint8Array>();
      let seed = 7;
      const random = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
      const key = () => {
        const bytes = new Uint8Array(1 + Math.floor(random() * 4));
        bytes[0] = 0x01 + Math.floor(random() * 2);
        for (let i = 1; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
        return bytes;
      };
      for (let round = 0; round < 40; round++) {
        for (let i = 0; i < 25; i++) {
          const k = key();
          const value = enc(String(round));
          if (random() < 0.1) {
            await run(kv.delete(k));
            model.delete(latin1(k));
          } else {
            await run(kv.set(k, value));
            model.set(latin1(k), value);
          }
        }
        const scanned = await run(
          Stream.runCollect(
            kv.getRange({ start: new Uint8Array([0x01]), end: new Uint8Array([0x03]) }),
          ),
        );
        const expected = [...model.keys()].sort();
        expect(Array.from(scanned, ([k]) => latin1(k))).toEqual(expected);
        expect(Array.from(scanned, ([, v]) => v)).toEqual(expected.map((k) => model.get(k)));
      }
    });

    it("applies string-keyed bulk writes in order with the transaction's other writes", async () => {
      const kv = makeTestKvBackend();
      await run(
        kv.transact((tx) =>
          Effect.gen(function* () {
            tx.setAllStr!([
              ["\x01a", enc("bulk-1")],
              ["\x01b", enc("bulk-1")],
            ]);
            // A later per-key write must win over the earlier bulk write ...
            yield* tx.set(enc("\x01a"), enc("set"));
            expect(yield* tx.get(enc("\x01b"))).toEqual(enc("bulk-1"));
            // ... and a later bulk write over an earlier delete.
            yield* tx.delete(enc("\x01c"));
            tx.setAllStr!([["\x01c", enc("bulk-2")]]);
          }),
        ),
      );
      const entries = await run(
        Stream.runCollect(
          kv.getRange({ start: new Uint8Array([0x01]), end: new Uint8Array([0x02]) }),
        ),
      );
      expect(Array.from(entries, ([k, v]) => [latin1(k), new TextDecoder().decode(v)])).toEqual([
        ["\x01a", "set"],
        ["\x01b", "bulk-1"],
        ["\x01c", "bulk-2"],
      ]);
    });
  });

  describe("clear", () => {
    it("removes all entries", async () => {
      const kv = makeTestKvBackend();
      await run(kv.set(enc("a"), enc("1")));
      await run(kv.set(enc("b"), enc("2")));
      await run(kv.clear());
      expect(await run(kv.get(enc("a")))).toBeNull();
      expect(await run(kv.get(enc("b")))).toBeNull();
    });
  });
});
