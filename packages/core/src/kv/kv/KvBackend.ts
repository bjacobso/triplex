/**
 * Ordered Key-Value Backend service interface.
 *
 * This is the portable abstraction layer that can be implemented by:
 * - InMemoryKvBackend (sorted map, for dev/test)
 * - FoundationDB (distributed, for production scale)
 * - RocksDB/LMDB (single-node, for embedded production)
 *
 * All keys and values are raw byte arrays (Uint8Array).
 * Keys are stored in lexicographic order, enabling efficient range scans.
 */

import { Context, Effect, Stream } from "effect";
import type { Segment } from "../../segment/Segment.js";

/** A key-value pair from the store. */
export type KvEntry = readonly [key: Uint8Array, value: Uint8Array];

/** Options for range scan operations. */
export interface RangeOptions {
  /** Start key (inclusive). */
  readonly start: Uint8Array;
  /** End key (exclusive). */
  readonly end: Uint8Array;
  /** Maximum number of entries to return. */
  readonly limit?: number;
  /** If true, scan in reverse lexicographic order. */
  readonly reverse?: boolean;
}

/** A snapshot view within a transaction. */
export interface KvTransaction {
  readonly get: (key: Uint8Array) => Effect.Effect<Uint8Array | null>;
  readonly set: (key: Uint8Array, value: Uint8Array) => Effect.Effect<void>;
  readonly delete: (key: Uint8Array) => Effect.Effect<void>;
  readonly getRange: (options: RangeOptions) => Stream.Stream<KvEntry>;
  /**
   * Buffer many writes in one effect. Optional: callers fall back to one
   * `set` per entry.
   */
  readonly setAll?: (
    entries: ReadonlyArray<readonly [Uint8Array, Uint8Array]>,
  ) => Effect.Effect<void>;
  /**
   * Buffer writes keyed by pre-built latin1 strings, synchronously. Only the
   * in-memory backend implements it; see `KvBackendService.setAllStr`.
   */
  readonly setAllStr?: (entries: ReadonlyArray<readonly [string, Uint8Array]>) => void;
}

/** The KV backend service interface. */
export interface KvBackendService {
  /** Get a single value by key. Returns null if not found. */
  readonly get: (key: Uint8Array) => Effect.Effect<Uint8Array | null>;

  /** Set a key-value pair. Overwrites any existing value. */
  readonly set: (key: Uint8Array, value: Uint8Array) => Effect.Effect<void>;

  /** Delete a key. No-op if the key doesn't exist. */
  readonly delete: (key: Uint8Array) => Effect.Effect<void>;

  /**
   * Scan a range of keys in lexicographic order.
   * Returns a Stream of [key, value] pairs from start (inclusive) to end (exclusive).
   */
  readonly getRange: (options: RangeOptions) => Stream.Stream<KvEntry>;

  /**
   * Execute a function within a transaction.
   * All reads and writes within the transaction are atomic.
   * For in-memory: buffered writes, committed on success, discarded on error.
   * For FoundationDB: optimistic concurrency with 5s limit.
   */
  readonly transact: <A, E>(fn: (tx: KvTransaction) => Effect.Effect<A, E>) => Effect.Effect<A, E>;

  /**
   * Set multiple key-value pairs in a single operation.
   * More efficient than individual set() calls for bulk loading.
   * Implementations should apply all entries atomically where possible.
   */
  readonly setAll: (
    entries: ReadonlyArray<readonly [Uint8Array, Uint8Array]>,
  ) => Effect.Effect<void>;

  /**
   * Get multiple values by key in a single operation.
   * More efficient than individual get() calls for batch lookups.
   * Returns an array of [key, value|null] pairs in the same order as the input keys.
   */
  readonly getMany: (
    keys: ReadonlyArray<Uint8Array>,
  ) => Effect.Effect<ReadonlyArray<readonly [Uint8Array, Uint8Array | null]>>;

  /** Clear all data from the store. */
  readonly clear: () => Effect.Effect<void>;

  // ─── Synchronous fast path (optional, in-memory only) ──────────────────
  // These bypass Effect/Stream overhead for hot-path operations.
  // Only implemented by InMemoryKvBackend; other backends return undefined.

  /** Synchronous get. Returns null if not found or not supported. */
  readonly getSync?: (key: Uint8Array) => Uint8Array | null;

  /** Synchronous range scan. Returns entries directly as an array. */
  readonly getRangeSync?: (options: RangeOptions) => KvEntry[];

  /**
   * Bulk set with pre-built latin1 string keys.
   * Skips the Uint8Array→string conversion in setAll, eliminating ~5 string
   * allocations per triple during bulk insertion. Only implemented by InMemoryKvBackend.
   */
  readonly setAllStr?: (entries: ReadonlyArray<readonly [string, Uint8Array]>) => void;

  /**
   * Immutable segment bodies by content ID. Optional; only the in-memory
   * backend stores them today. A body is content-addressed and invisible until
   * a transaction writes an attachment record naming it, so storing one
   * outside a transaction is safe, like writing a git object before the
   * commit that references it.
   */
  readonly segments?: SegmentStore;
}

export interface SegmentStore {
  readonly put: (segment: Segment) => void;
  readonly get: (id: string) => Segment | undefined;
}

/** Effect service tag for dependency injection. */
export class KvBackend extends Context.Service<KvBackend, KvBackendService>()("KvBackend") {}
