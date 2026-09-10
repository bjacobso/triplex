/**
 * FdbKvBackend tests using Testcontainers + @effect/vitest.
 *
 * A FoundationDB Docker container is started once for the entire suite
 * and shared across all tests. Each test gets an isolated subspace.
 *
 * Requires Docker + FoundationDB client libraries to be available.
 *
 * ```bash
 * pnpm test --filter @triplex-build/triplex-foundationdb -- test/FdbKvBackend.test.ts
 * ```
 */

import { Effect, Stream } from "effect";
import { describe, expect, layer } from "@effect/vitest";
import { createRequire } from "node:module";
import { KvBackend } from "@triplex-build/triplex";
import { makeFdbKvBackendService } from "../src/FdbKvBackend.js";
import { FdbClusterFile, FdbContainerLayer, FdbTestLayer } from "./fixtures/FdbTestLayer.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (u: Uint8Array): string => new TextDecoder().decode(u);
const require = createRequire(import.meta.url);
const fdbAvailable = (() => {
  try {
    require("foundationdb");
    return true;
  } catch {
    return false;
  }
})();

const describeFdb = fdbAvailable
  ? layer(FdbTestLayer, { timeout: "60 seconds" })
  : (name: string, _fn: () => void) => describe.skip(name, () => {});

const describeFdbCluster = fdbAvailable
  ? layer(FdbContainerLayer, { timeout: "60 seconds" })
  : (name: string, _fn: () => void) => describe.skip(name, () => {});

// ─── Tests ─────────────────────────────────────────────────────────────────

describeFdb("FdbKvBackend", (it) => {
  // ── get/set ────────────────────────────────────────────────────────────

  it.effect("returns null for missing keys", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      const result = yield* kv.get(enc("missing"));
      expect(result).toBeNull();
    }),
  );

  it.effect("stores and retrieves a value", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      yield* kv.set(enc("key1"), enc("value1"));
      const result = yield* kv.get(enc("key1"));
      expect(result).not.toBeNull();
      expect(dec(result!)).toBe("value1");
    }),
  );

  it.effect("overwrites existing values", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      yield* kv.set(enc("key1"), enc("v1"));
      yield* kv.set(enc("key1"), enc("v2"));
      const result = yield* kv.get(enc("key1"));
      expect(result).not.toBeNull();
      expect(dec(result!)).toBe("v2");
    }),
  );

  it.effect("rejects values over FoundationDB's value limit", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      const oversized = new Uint8Array(100_001);

      const result = yield* Effect.exit(kv.set(enc("oversized"), oversized));

      expect(result._tag).toBe("Failure");
      expect(yield* kv.get(enc("oversized"))).toBeNull();
    }),
  );

  // ── delete ─────────────────────────────────────────────────────────────

  it.effect("removes a key", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      yield* kv.set(enc("del-key"), enc("value"));
      yield* kv.delete(enc("del-key"));
      const result = yield* kv.get(enc("del-key"));
      expect(result).toBeNull();
    }),
  );

  it.effect("no-ops on missing keys", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      yield* kv.delete(enc("nonexistent"));
      // No error thrown
    }),
  );

  // ── getRange ───────────────────────────────────────────────────────────

  it.effect("returns entries in lexicographic order", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      yield* kv.set(enc("range-c"), enc("3"));
      yield* kv.set(enc("range-a"), enc("1"));
      yield* kv.set(enc("range-b"), enc("2"));

      const results = yield* Stream.runCollect(
        kv.getRange({ start: enc("range-a"), end: enc("range-d") }),
      );

      const keys = Array.from(results).map(([k]) => dec(k));
      expect(keys).toEqual(["range-a", "range-b", "range-c"]);
    }),
  );

  it.effect("respects start (inclusive) and end (exclusive)", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      yield* kv.set(enc("bound-a"), enc("1"));
      yield* kv.set(enc("bound-b"), enc("2"));
      yield* kv.set(enc("bound-c"), enc("3"));
      yield* kv.set(enc("bound-d"), enc("4"));

      const results = yield* Stream.runCollect(
        kv.getRange({ start: enc("bound-b"), end: enc("bound-d") }),
      );

      const keys = Array.from(results).map(([k]) => dec(k));
      expect(keys).toEqual(["bound-b", "bound-c"]);
    }),
  );

  it.effect("respects limit", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      yield* kv.set(enc("lim-a"), enc("1"));
      yield* kv.set(enc("lim-b"), enc("2"));
      yield* kv.set(enc("lim-c"), enc("3"));

      const results = yield* Stream.runCollect(
        kv.getRange({ start: enc("lim-a"), end: enc("lim-z"), limit: 2 }),
      );

      expect(Array.from(results).length).toBe(2);
    }),
  );

  it.effect("supports reverse scanning", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      yield* kv.set(enc("rev-a"), enc("1"));
      yield* kv.set(enc("rev-b"), enc("2"));
      yield* kv.set(enc("rev-c"), enc("3"));

      const results = yield* Stream.runCollect(
        kv.getRange({ start: enc("rev-a"), end: enc("rev-d"), reverse: true }),
      );

      const keys = Array.from(results).map(([k]) => dec(k));
      expect(keys).toEqual(["rev-c", "rev-b", "rev-a"]);
    }),
  );

  it.effect("returns empty for empty range", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      yield* kv.set(enc("empty-a"), enc("1"));

      const results = yield* Stream.runCollect(
        kv.getRange({ start: enc("empty-b"), end: enc("empty-c") }),
      );

      expect(Array.from(results).length).toBe(0);
    }),
  );

  // ── setAll / getRangeAll large batches ────────────────────────────────

  it.effect("setAll handles large batches without truncation", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      const entries = Array.from(
        { length: 2000 },
        (_, i) => [enc(`bulk-${i.toString().padStart(4, "0")}`), enc(`v-${i}`)] as const,
      );
      yield* kv.setAll(entries);

      const results = yield* Stream.runCollect(
        kv.getRange({ start: enc("bulk-"), end: enc("bulk-~") }),
      );
      expect(Array.from(results).length).toBe(2000);
    }),
  );

  it.effect("setAll chunks when over the transaction byte limit", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      const entries = Array.from(
        { length: 6000 },
        (_, i) => [enc(`chunk-${i.toString().padStart(4, "0")}`), enc(`v-${i}`)] as const,
      );
      yield* kv.setAll(entries);

      const results = yield* Stream.runCollect(
        kv.getRange({ start: enc("chunk-"), end: enc("chunk-~") }),
      );
      expect(Array.from(results).length).toBe(6000);
    }),
  );

  it.effect("setAll rejects oversize values before writing any entries", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      const oversized = new Uint8Array(100_001);

      const result = yield* Effect.exit(
        kv.setAll([
          [enc("oversized-batch-a"), enc("ok")],
          [enc("oversized-batch-b"), oversized],
        ]),
      );

      expect(result._tag).toBe("Failure");
      expect(yield* kv.get(enc("oversized-batch-a"))).toBeNull();
      expect(yield* kv.get(enc("oversized-batch-b"))).toBeNull();
    }),
  );

  it.effect("getRangeAll returns full scans for large ranges", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      const entries = Array.from(
        { length: 500 },
        (_, i) => [enc(`scan-${i.toString().padStart(3, "0")}`), enc(`v-${i}`)] as const,
      );
      yield* kv.setAll(entries);

      const results = yield* Stream.runCollect(
        kv.getRange({ start: enc("scan-"), end: enc("scan-~") }),
      );
      expect(Array.from(results).length).toBe(500);
    }),
  );

  // ── transact ───────────────────────────────────────────────────────────

  it.effect("commits writes atomically", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      yield* kv.transact((tx) =>
        Effect.gen(function* () {
          yield* tx.set(enc("tx-k1"), enc("v1"));
          yield* tx.set(enc("tx-k2"), enc("v2"));
        }),
      );

      const v1 = yield* kv.get(enc("tx-k1"));
      const v2 = yield* kv.get(enc("tx-k2"));
      expect(v1).not.toBeNull();
      expect(dec(v1!)).toBe("v1");
      expect(v2).not.toBeNull();
      expect(dec(v2!)).toBe("v2");
    }),
  );

  it.effect("rolls back on error", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      yield* kv.set(enc("rb-existing"), enc("original"));

      const result = yield* Effect.exit(
        kv.transact((tx) =>
          Effect.gen(function* () {
            yield* tx.set(enc("rb-existing"), enc("modified"));
            yield* tx.set(enc("rb-new"), enc("value"));
            return yield* Effect.fail("boom" as const);
          }),
        ),
      );

      expect(result._tag).toBe("Failure");
      const existing = yield* kv.get(enc("rb-existing"));
      expect(existing).not.toBeNull();
      expect(dec(existing!)).toBe("original");
      expect(yield* kv.get(enc("rb-new"))).toBeNull();
    }),
  );

  it.effect("can read committed data within transaction", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      yield* kv.set(enc("tx-pre"), enc("existing"));

      const readValue = yield* kv.transact((tx) =>
        Effect.gen(function* () {
          return yield* tx.get(enc("tx-pre"));
        }),
      );

      expect(readValue).not.toBeNull();
      expect(dec(readValue!)).toBe("existing");
    }),
  );

  it.effect("can read own writes within transaction", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;

      const readValue = yield* kv.transact((tx) =>
        Effect.gen(function* () {
          yield* tx.set(enc("tx-new"), enc("hello"));
          return yield* tx.get(enc("tx-new"));
        }),
      );

      expect(readValue).not.toBeNull();
      expect(dec(readValue!)).toBe("hello");
    }),
  );

  it.effect("handles deletes in transactions", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      yield* kv.set(enc("tx-del"), enc("v1"));

      yield* kv.transact((tx) =>
        Effect.gen(function* () {
          yield* tx.delete(enc("tx-del"));
        }),
      );

      expect(yield* kv.get(enc("tx-del"))).toBeNull();
    }),
  );

  // ── setAll ─────────────────────────────────────────────────────────────

  it.effect("writes multiple entries atomically", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      yield* kv.setAll([
        [enc("sa-x1"), enc("a")],
        [enc("sa-x2"), enc("b")],
        [enc("sa-x3"), enc("c")],
      ]);

      expect(dec((yield* kv.get(enc("sa-x1")))!)).toBe("a");
      expect(dec((yield* kv.get(enc("sa-x2")))!)).toBe("b");
      expect(dec((yield* kv.get(enc("sa-x3")))!)).toBe("c");
    }),
  );

  it.effect("handles empty array", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      yield* kv.setAll([]);
    }),
  );

  // ── clear ──────────────────────────────────────────────────────────────

  it.effect("removes all entries", () =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      yield* kv.set(enc("clr-a"), enc("1"));
      yield* kv.set(enc("clr-b"), enc("2"));
      yield* kv.clear();
      expect(yield* kv.get(enc("clr-a"))).toBeNull();
      expect(yield* kv.get(enc("clr-b"))).toBeNull();
    }),
  );
});

describeFdbCluster("FdbKvBackend multi-tenant isolation", (it) => {
  it.effect("keeps concurrent tenants isolated by subspace", () =>
    Effect.gen(function* () {
      const { clusterFilePath } = yield* FdbClusterFile;
      const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const tenantA = yield* makeFdbKvBackendService({
        clusterFile: clusterFilePath,
        subspace: Buffer.from(`__tenant_a_${suffix}/`),
        rangeScanPageSize: 2,
      });
      const tenantB = yield* makeFdbKvBackendService({
        clusterFile: clusterFilePath,
        subspace: Buffer.from(`__tenant_b_${suffix}/`),
        rangeScanPageSize: 2,
      });

      yield* Effect.all(
        [
          tenantA.setAll([
            [enc("shared"), enc("a-shared")],
            [enc("only-a"), enc("a-only")],
          ]),
          tenantB.setAll([
            [enc("shared"), enc("b-shared")],
            [enc("only-b"), enc("b-only")],
          ]),
        ],
        { concurrency: 2 },
      );

      expect(dec((yield* tenantA.get(enc("shared"))) ?? enc(""))).toBe("a-shared");
      expect(dec((yield* tenantB.get(enc("shared"))) ?? enc(""))).toBe("b-shared");
      expect(yield* tenantA.get(enc("only-b"))).toBeNull();
      expect(yield* tenantB.get(enc("only-a"))).toBeNull();

      const [tenantAEntries, tenantBEntries] = yield* Effect.all([
        Stream.runCollect(tenantA.getRange({ start: enc(""), end: enc("~") })),
        Stream.runCollect(tenantB.getRange({ start: enc(""), end: enc("~") })),
      ]);

      expect(Array.from(tenantAEntries).map(([key]) => dec(key))).toEqual(["only-a", "shared"]);
      expect(Array.from(tenantBEntries).map(([key]) => dec(key))).toEqual(["only-b", "shared"]);

      yield* tenantA.clear();
      expect(yield* tenantA.get(enc("shared"))).toBeNull();
      expect(dec((yield* tenantB.get(enc("shared"))) ?? enc(""))).toBe("b-shared");
    }),
  );
});
