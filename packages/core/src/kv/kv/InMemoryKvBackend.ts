/**
 * In-memory ordered KV backend using a Map with lazily-sorted cache.
 *
 * Designed for development, testing, and single-node deployments.
 * All data lives in memory -- no persistence across restarts.
 *
 * Performance characteristics:
 * - get: O(1) via Map lookup
 * - set: O(1) via Map insertion (invalidates sorted cache)
 * - delete: O(1) via Map deletion (invalidates sorted cache)
 * - getRange: O(n log n) on first call after mutation (sorts), then O(log n + k)
 * - setAll: O(k) direct Map insertion (invalidates sorted cache once)
 * - transact: buffered writes, committed on success, discarded on error
 *
 * Bulk insertion is extremely fast because it never sorts during writes.
 * The sorted array is only rebuilt lazily when the first range scan is requested.
 *
 * Key insight: latin1 string encoding preserves byte order, so we store keys
 * as latin1 strings and sort natively (faster than byte-by-byte comparison).
 * Uint8Array keys are only reconstructed on-demand for getRange results.
 */

import { Effect, Layer, Semaphore, Stream } from "effect";
import {
  KvBackend,
  type KvBackendService,
  type KvEntry,
  type KvTransaction,
  type RangeOptions,
} from "./KvBackend.js";

/**
 * Convert a Uint8Array key to a latin1 string.
 * Latin1 encoding maps each byte 1:1 to a char code, preserving lexicographic order.
 */
const keyToString = (k: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < k.length; i++) s += String.fromCharCode(k[i]!);
  return s;
};

/**
 * Convert a latin1 string back to a Uint8Array.
 */
const stringToKey = (s: string): Uint8Array => {
  const k = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) k[i] = s.charCodeAt(i);
  return k;
};

/**
 * Binary search for the insertion index of a key (as string) in the sorted keys array.
 * Uses native string comparison which preserves byte order for latin1 strings.
 */
const bisectStr = (keys: readonly string[], target: string): number => {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid]! < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
};

// ─── Partition: a single Map + sorted cache ────────────────────────────────

class Partition {
  readonly map = new Map<string, Uint8Array>();
  sortedKeysCache: string[] | null = [];

  ensureSortedKeys(): string[] {
    if (this.sortedKeysCache === null) {
      const keys = Array.from(this.map.keys());
      keys.sort(); // Native string sort == byte-order sort for latin1
      this.sortedKeysCache = keys;
    }
    return this.sortedKeysCache;
  }

  invalidateCache(): void {
    this.sortedKeysCache = null;
  }

  clear(): void {
    this.map.clear();
    this.sortedKeysCache = [];
  }
}

// ─── InMemoryStore ─────────────────────────────────────────────────────────
//
// Partitioned by the first byte of the key (the index prefix). This keeps
// each Map at ~1/6 the total size, reducing V8 Map rehash cost and sorted
// cache rebuild time (sort 900K keys instead of 5.5M).
//
// Known prefixes: 0x01 (EAVT), 0x02 (AEVT), 0x03 (AVET), 0x04 (VAET),
//                 0x05 (TYPE), 0x20 (META). Unknown prefixes go to a
//                 catch-all partition.

class InMemoryStore {
  /** Partitions indexed by first byte of key string (charCode). */
  private readonly partitions = new Map<number, Partition>();

  /** Get or create the partition for a key string. */
  private partitionFor(ks: string): Partition {
    const prefix = ks.charCodeAt(0);
    let p = this.partitions.get(prefix);
    if (p === undefined) {
      p = new Partition();
      this.partitions.set(prefix, p);
    }
    return p;
  }

  get(key: Uint8Array): Uint8Array | null {
    const ks = keyToString(key);
    return this.partitionFor(ks).map.get(ks) ?? null;
  }

  set(key: Uint8Array, value: Uint8Array): void {
    const ks = keyToString(key);
    const p = this.partitionFor(ks);
    p.map.set(ks, value);
    p.invalidateCache();
  }

  delete(key: Uint8Array): void {
    const ks = keyToString(key);
    const p = this.partitionFor(ks);
    if (p.map.delete(ks)) {
      p.invalidateCache();
    }
  }

  getRange(options: RangeOptions): KvEntry[] {
    const startStr = keyToString(options.start);
    const endStr = keyToString(options.end);
    const { limit, reverse } = options;

    // Range scans always target a single index prefix (start and end share
    // the same first byte), so we only need one partition's sorted keys.
    const startPrefix = startStr.charCodeAt(0);
    const endPrefix = endStr.charCodeAt(0);

    // Common case: same prefix → single partition scan
    if (startPrefix === endPrefix) {
      const p = this.partitions.get(startPrefix);
      if (!p) return [];
      return this.scanPartition(p, startStr, endStr, limit, reverse);
    }

    // Cross-partition scan (rare, e.g. full store scan).
    // Merge sorted keys across all partitions in range.
    const results: KvEntry[] = [];
    const sortedPrefixes = Array.from(this.partitions.keys()).sort((a, b) => a - b);

    if (reverse) {
      for (let pi = sortedPrefixes.length - 1; pi >= 0; pi--) {
        const prefix = sortedPrefixes[pi]!;
        if (prefix < startPrefix || prefix > endPrefix) continue;
        const p = this.partitions.get(prefix)!;
        const partResults = this.scanPartition(
          p,
          startStr,
          endStr,
          limit !== undefined ? limit - results.length : undefined,
          true,
        );
        for (const entry of partResults) results.push(entry);
        if (limit !== undefined && results.length >= limit) break;
      }
    } else {
      for (const prefix of sortedPrefixes) {
        if (prefix < startPrefix || prefix > endPrefix) continue;
        const p = this.partitions.get(prefix)!;
        const partResults = this.scanPartition(
          p,
          startStr,
          endStr,
          limit !== undefined ? limit - results.length : undefined,
          false,
        );
        for (const entry of partResults) results.push(entry);
        if (limit !== undefined && results.length >= limit) break;
      }
    }

    return results;
  }

  private scanPartition(
    p: Partition,
    startStr: string,
    endStr: string,
    limit: number | undefined,
    reverse: boolean | undefined,
  ): KvEntry[] {
    const sortedKeys = p.ensureSortedKeys();
    const results: KvEntry[] = [];

    if (reverse) {
      let idx = bisectStr(sortedKeys, endStr) - 1;
      while (idx >= 0) {
        const ks = sortedKeys[idx]!;
        if (ks < startStr) break;
        results.push([stringToKey(ks), p.map.get(ks)!]);
        if (limit !== undefined && results.length >= limit) break;
        idx--;
      }
    } else {
      let idx = bisectStr(sortedKeys, startStr);
      while (idx < sortedKeys.length) {
        const ks = sortedKeys[idx]!;
        if (ks >= endStr) break;
        results.push([stringToKey(ks), p.map.get(ks)!]);
        if (limit !== undefined && results.length >= limit) break;
        idx++;
      }
    }

    return results;
  }

  /**
   * Set a key-value pair using pre-computed string key.
   * Does NOT invalidate cache — caller must call invalidateCache() after batch.
   */
  setDirect(ks: string, value: Uint8Array): void {
    this.partitionFor(ks).map.set(ks, value);
  }

  /** Invalidate all partition caches. */
  invalidateCache(): void {
    for (const p of this.partitions.values()) {
      p.invalidateCache();
    }
  }

  /**
   * Apply buffered writes directly from the transaction write buffer.
   */
  applyWriteBuffer(buffer: ReadonlyMap<string, Uint8Array | null>): void {
    if (buffer.size === 0) return;

    const dirtyPartitions = new Set<Partition>();
    for (const [ks, value] of buffer) {
      const p = this.partitionFor(ks);
      if (value === null) {
        if (p.map.delete(ks)) dirtyPartitions.add(p);
      } else {
        p.map.set(ks, value);
        dirtyPartitions.add(p);
      }
    }
    for (const p of dirtyPartitions) p.invalidateCache();
  }

  clear(): void {
    for (const p of this.partitions.values()) p.clear();
    this.partitions.clear();
  }

  get size(): number {
    let total = 0;
    for (const p of this.partitions.values()) total += p.map.size;
    return total;
  }
}

const makeInMemoryKvBackend = (): KvBackendService => {
  const store = new InMemoryStore();
  const transactionMutex = Semaphore.makeUnsafe(1);

  const service: KvBackendService = {
    get: (key) => Effect.sync(() => store.get(key)),

    set: (key, value) => Effect.sync(() => store.set(key, value)),

    delete: (key) => Effect.sync(() => store.delete(key)),

    getRange: (options) => Stream.fromIterable(store.getRange(options)),

    transact: <A, E>(fn: (tx: KvTransaction) => Effect.Effect<A, E>) => {
      // For in-memory backend, all operations are synchronous and single-threaded.
      // No mutex needed — just buffer writes and commit on success.
      return transactionMutex.withPermit(
        Effect.gen(function* () {
          const writeBuffer = new Map<string, Uint8Array | null>();

          const tx: KvTransaction = {
            get: (key) =>
              Effect.sync(() => {
                const ks = keyToString(key);
                if (writeBuffer.has(ks)) {
                  return writeBuffer.get(ks) ?? null;
                }
                return store.get(key);
              }),
            set: (key, value) =>
              Effect.sync(() => {
                writeBuffer.set(keyToString(key), value);
              }),
            delete: (key) =>
              Effect.sync(() => {
                writeBuffer.set(keyToString(key), null);
              }),
            getRange: (options) => {
              const start = keyToString(options.start);
              const end = keyToString(options.end);
              const visible = new Map(
                store
                  .getRange({ start: options.start, end: options.end })
                  .map(([key, value]) => [keyToString(key), value]),
              );
              for (const [key, value] of writeBuffer) {
                if (key < start || key >= end) continue;
                if (value === null) visible.delete(key);
                else visible.set(key, value);
              }
              const keys = [...visible.keys()].sort();
              if (options.reverse) keys.reverse();
              const selected = options.limit === undefined ? keys : keys.slice(0, options.limit);
              return Stream.fromIterable(
                selected.map((key) => [stringToKey(key), visible.get(key)!] as const),
              );
            },
          };

          const result = yield* fn(tx);

          // Commit: apply buffered writes on success.
          // If fn fails, the yield* above propagates the error and we never reach here.
          store.applyWriteBuffer(writeBuffer);
          return result;
        }),
      ) as Effect.Effect<A, E>;
    },

    setAll: (entries) =>
      Effect.sync(() => {
        if (entries.length === 0) return;
        for (const [key, value] of entries) {
          store.setDirect(keyToString(key), value);
        }
        store.invalidateCache();
      }),

    getMany: (keys) => Effect.sync(() => keys.map((key) => [key, store.get(key)] as const)),

    clear: () => Effect.sync(() => store.clear()),

    // ─── Synchronous fast path ─────────────────────────────────────────
    getSync: (key) => store.get(key),
    getRangeSync: (options) => store.getRange(options),

    // ─── Bulk insert with pre-built latin1 string keys ─────────────────
    setAllStr: (entries) => {
      if (entries.length === 0) return;
      for (let i = 0; i < entries.length; i++) {
        store.setDirect(entries[i]![0], entries[i]![1]);
      }
      store.invalidateCache();
    },
  };

  return service;
};

/** Layer that provides an in-memory KV backend. */
export const InMemoryKvBackendLive: Layer.Layer<KvBackend> = Layer.succeed(
  KvBackend,
  makeInMemoryKvBackend(),
);

/** Create a fresh in-memory KV backend (useful for testing). */
export const makeTestKvBackend = (): KvBackendService => makeInMemoryKvBackend();
