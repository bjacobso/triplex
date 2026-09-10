/**
 * FoundationDB backend for the KvBackend interface.
 *
 * Implements `KvBackendService` using the `foundationdb` npm package.
 * FoundationDB provides:
 * - Ordered key-value storage (natural fit for hexastore index scans)
 * - ACID transactions with optimistic concurrency (5-second limit)
 * - Distributed, multi-node scalability
 * - Key prefix isolation for multi-tenancy
 *
 * Prerequisites:
 * - FoundationDB server installed and running
 * - `libfdb_c` client library on the system path
 *
 * @example
 * ```typescript
 * // A non-empty subspace is required by default.
 * const layer = makeFdbKvBackend({
 *   subspace: Buffer.from("triplex/tenant-123/"),
 * });
 *
 * // Wire into the KV-backed Triples service
 * const app = KvTriples.layerBackend.pipe(
 *   Layer.provide(layer),
 *   Layer.provide(TripleStoreRuntimeLayer),
 * );
 * ```
 */

import { Effect, Layer, Option, Stream } from "effect";
import {
  KvBackend,
  type KvBackendService,
  type KvEntry,
  type KvTransaction,
  type RangeOptions,
} from "@triplex-build/triplex/internal";

// ─── FDB imports (dynamic to allow graceful failure) ───────────────────────

// We import the types statically for type safety, but the actual module
// is loaded dynamically so the rest of the codebase can compile/run
// without libfdb_c installed.
import type FdbTransaction from "foundationdb/dist/lib/transaction.js";
import type { NativeValue } from "foundationdb/dist/lib/native.js";

// ─── Configuration ─────────────────────────────────────────────────────────

/**
 * Configuration for the FoundationDB KV backend.
 */
export interface FdbKvBackendConfig {
  /**
   * Path to the fdb.cluster file.
   * If omitted, uses the system default (usually /etc/foundationdb/fdb.cluster).
   */
  readonly clusterFile?: string;

  /**
   * Optional key prefix for isolation.
   * All keys are stored under this prefix, enabling multi-tenant or
   * multi-database isolation within a single FDB cluster.
   *
   * @example Buffer.from("ontology/my-database/")
   */
  readonly subspace?: Buffer;

  /**
   * Explicitly permit using the cluster root as the Triplex keyspace.
   *
   * This is unsafe on a shared cluster because `clear()` clears the configured
   * keyspace. Omit this option in normal use and provide a non-empty `subspace`.
   */
  readonly allowUnsafeRootSubspace?: boolean;

  /**
   * FDB API version to use. Defaults to 720 (latest supported by the npm package).
   * Must match or be below the installed FDB server version.
   */
  readonly apiVersion?: number;

  /**
   * Maximum number of key-value entries per FDB range scan page.
   *
   * Defaults to 10,000 so scans do not materialize unbounded result sets
   * in memory.
   */
  readonly rangeScanPageSize?: number;

  /**
   * Maximum number of key-value entries per FDB transaction in `setAll`.
   * Optional secondary cap; byte-size chunking is the primary guard because
   * FDB enforces a 10MB transaction size limit.
   */
  readonly maxTransactionEntries?: number;

  /**
   * Maximum estimated bytes per FDB transaction in `setAll`.
   *
   * Defaults to 8MB, leaving headroom under FDB's 10MB transaction limit for
   * mutation metadata and subspace prefixes.
   */
  readonly maxTransactionBytes?: number;

  /**
   * Maximum value size accepted by the backend.
   *
   * Defaults to FDB's documented 100KB value limit.
   */
  readonly maxValueBytes?: number;

  /**
   * Application-side transaction timeout in milliseconds.
   *
   * Defaults to 4.5s so callers fail before FDB's 5s transaction lifetime.
   */
  readonly transactionTimeoutMs?: number;

  /**
   * Threshold for slow transaction logs.
   *
   * Defaults to 1s. Set to 0 to log every transaction.
   */
  readonly slowTransactionMs?: number;

  /**
   * Optional metrics hook invoked after each FDB transaction attempt cycle.
   */
  readonly onTransactionMetrics?: (metrics: FdbTransactionMetrics) => void;

  /**
   * Log retry attempts for FDB transactions (useful for large stress runs).
   * Logs to stderr with error code and retry count.
   */
  readonly logRetries?: boolean;
}

export interface FdbTransactionMetrics {
  readonly label: string;
  readonly attempts: number;
  readonly retries: number;
  readonly conflicts: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export type FdbKvBackendErrorKind =
  | "retryable"
  | "timeout"
  | "constraint"
  | "permanent"
  | "unknown";

export class FdbKvBackendError extends Error {
  readonly operation: string;
  readonly kind: FdbKvBackendErrorKind;
  readonly retryable: boolean;
  readonly code: number | undefined;
  override readonly cause: unknown;

  constructor(options: {
    readonly operation: string;
    readonly kind: FdbKvBackendErrorKind;
    readonly retryable: boolean;
    readonly code?: number | undefined;
    readonly message: string;
    readonly cause?: unknown;
  }) {
    super(options.message);
    Object.setPrototypeOf(this, FdbKvBackendError.prototype);
    this.name = "FdbKvBackendError";
    this.operation = options.operation;
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.code = options.code;
    this.cause = options.cause;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Convert Uint8Array to Buffer (FDB's native key type). Zero-copy when possible. */
const toBuffer = (u: Uint8Array): Buffer =>
  Buffer.isBuffer(u) ? u : Buffer.from(u.buffer, u.byteOffset, u.byteLength);

/** Convert Buffer to Uint8Array. Zero-copy. */
const toUint8Array = (b: Buffer): Uint8Array =>
  new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

/** The zero byte — used as the start of the entire keyspace. */
const ZERO = Buffer.alloc(1, 0x00);

/** 0xFF byte — used as the end of the entire keyspace. */
const FF = Buffer.alloc(1, 0xff);

// ─── Range scan helper ─────────────────────────────────────────────────────

interface FdbRangeSource {
  getRangeAll(
    start: Buffer,
    end: Buffer,
    options: { readonly limit: number; readonly reverse: boolean },
  ): Promise<ReadonlyArray<readonly [Buffer, Buffer]>>;
}

interface RangeCursor {
  readonly start: Buffer;
  readonly end: Buffer;
  readonly reverse: boolean;
  readonly remaining: number | undefined;
}

type FdbTx = FdbTransaction<NativeValue, Buffer, NativeValue, Buffer>;

type InstrumentableFdbTransaction = Omit<FdbTx, "rawOnError"> & {
  _exec<A>(body: (tx: FdbTx) => Promise<A>): Promise<A>;
  rawOnError(code: number, ...args: Array<unknown>): Promise<void> | void;
};

const DEFAULT_RANGE_SCAN_PAGE_SIZE = 10_000;
const DEFAULT_MAX_TRANSACTION_BYTES = 8_000_000;
const DEFAULT_MAX_VALUE_BYTES = 100_000;
const DEFAULT_TRANSACTION_TIMEOUT_MS = 4_500;
const DEFAULT_SLOW_TRANSACTION_MS = 1_000;
const MUTATION_BYTE_OVERHEAD = 64;
const FDB_TIMED_OUT = 1004;
const FDB_NOT_COMMITTED = 1020;
const FDB_COMMIT_UNKNOWN_RESULT = 1021;
const FDB_TRANSACTION_TIMED_OUT = 1031;

const RETRYABLE_FDB_CODES = new Set([
  1000, // operation_failed
  FDB_TIMED_OUT,
  1007, // transaction_too_old
  1009, // future_version
  FDB_NOT_COMMITTED,
  FDB_COMMIT_UNKNOWN_RESULT,
  1037, // process_behind
  1038, // database_locked
  1039, // cluster_version_changed
  1042, // proxy_memory_limit_exceeded
  1051, // batch_transaction_throttled
  1213, // tag_throttled
  1500, // platform_error
  1510, // io_error
  4000, // unknown_error
  4100, // internal_error
]);

const CONSTRAINT_FDB_CODES = new Set([
  2004, // key_outside_legal_range
  2005, // inverted_range
  2006, // invalid_option_value
  2007, // invalid_option
  2101, // transaction_too_large
  2102, // key_too_large
  2103, // value_too_large
  2109, // too_many_tags
  2110, // tag_too_long
]);

const keyAfter = (key: Buffer): Buffer => Buffer.concat([key, ZERO]);

const getFdbErrorCode = (cause: unknown): number | undefined => {
  const code = (cause as { readonly code?: unknown })?.code;
  return typeof code === "number" ? code : undefined;
};

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const classifyFdbError = (operation: string, cause: unknown): FdbKvBackendError => {
  if (cause instanceof FdbKvBackendError) {
    return cause;
  }

  const code = getFdbErrorCode(cause);
  const message = describeCause(cause);

  if (code === FDB_TIMED_OUT || code === FDB_TRANSACTION_TIMED_OUT) {
    return new FdbKvBackendError({
      operation,
      kind: "timeout",
      retryable: false,
      code,
      message: `FDB ${operation} timed out (code ${code}): ${message}`,
      cause,
    });
  }

  if (code !== undefined && RETRYABLE_FDB_CODES.has(code)) {
    return new FdbKvBackendError({
      operation,
      kind: "retryable",
      retryable: true,
      code,
      message: `FDB ${operation} failed with retryable error ${code}: ${message}`,
      cause,
    });
  }

  if (code !== undefined && CONSTRAINT_FDB_CODES.has(code)) {
    return new FdbKvBackendError({
      operation,
      kind: "constraint",
      retryable: false,
      code,
      message: `FDB ${operation} violated a FoundationDB limit or API constraint (code ${code}): ${message}`,
      cause,
    });
  }

  if (code !== undefined) {
    return new FdbKvBackendError({
      operation,
      kind: "permanent",
      retryable: false,
      code,
      message: `FDB ${operation} failed with non-retryable error ${code}: ${message}`,
      cause,
    });
  }

  return new FdbKvBackendError({
    operation,
    kind: "unknown",
    retryable: false,
    message: `FDB ${operation} failed: ${message}`,
    cause,
  });
};

const makeConstraintError = (operation: string, message: string): FdbKvBackendError =>
  new FdbKvBackendError({
    operation,
    kind: "constraint",
    retryable: false,
    message,
  });

export const assertFdbSubspaceConfigured = (
  config: FdbKvBackendConfig,
  operation: string,
): void => {
  if (
    config.allowUnsafeRootSubspace !== true &&
    (config.subspace === undefined || config.subspace.length === 0)
  ) {
    throw makeConstraintError(
      operation,
      `FDB ${operation} requires a non-empty subspace; set allowUnsafeRootSubspace only for an isolated cluster`,
    );
  }
};

const estimateMutationBytes = (key: Uint8Array, value: Uint8Array, subspaceBytes: number): number =>
  subspaceBytes + key.byteLength + value.byteLength + MUTATION_BYTE_OVERHEAD;

const assertValueWithinLimit = (label: string, value: Uint8Array, maxValueBytes: number): void => {
  if (value.byteLength > maxValueBytes) {
    throw makeConstraintError(
      label,
      `FDB ${label} value is ${value.byteLength} bytes; FoundationDB values must be <= ${maxValueBytes} bytes`,
    );
  }
};

const chunkEntriesByByteSize = (
  entries: ReadonlyArray<readonly [Uint8Array, Uint8Array]>,
  options: {
    readonly maxTransactionBytes: number;
    readonly maxTransactionEntries: number | undefined;
    readonly maxValueBytes: number;
    readonly subspaceBytes: number;
  },
): ReadonlyArray<ReadonlyArray<readonly [Uint8Array, Uint8Array]>> => {
  const chunks: Array<Array<readonly [Uint8Array, Uint8Array]>> = [];
  let current: Array<readonly [Uint8Array, Uint8Array]> = [];
  let currentBytes = 0;

  for (const entry of entries) {
    const [key, value] = entry;
    assertValueWithinLimit("setAll", value, options.maxValueBytes);

    const entryBytes = estimateMutationBytes(key, value, options.subspaceBytes);
    if (entryBytes > options.maxTransactionBytes) {
      throw makeConstraintError(
        "setAll",
        `FDB setAll entry is ${entryBytes} estimated bytes; transaction chunks are capped at ${options.maxTransactionBytes} bytes`,
      );
    }

    const wouldExceedBytes =
      current.length > 0 && currentBytes + entryBytes > options.maxTransactionBytes;
    const wouldExceedEntries =
      options.maxTransactionEntries !== undefined &&
      current.length > 0 &&
      current.length >= options.maxTransactionEntries;

    if (wouldExceedBytes || wouldExceedEntries) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }

    current.push(entry);
    currentBytes += entryBytes;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
};

const makePagedRangeStream = (
  source: FdbRangeSource,
  options: RangeOptions,
  pageSize: number,
  label: string,
): Stream.Stream<KvEntry> => {
  if (options.limit !== undefined && options.limit <= 0) {
    return Stream.empty;
  }

  const scanPageSize = Math.max(1, pageSize);
  const initial: RangeCursor = {
    start: toBuffer(options.start),
    end: toBuffer(options.end),
    reverse: options.reverse ?? false,
    remaining: options.limit,
  };

  return Stream.paginate(initial, (cursor) => {
    const limit =
      cursor.remaining === undefined ? scanPageSize : Math.min(scanPageSize, cursor.remaining);

    return Effect.tryPromise({
      try: () =>
        source.getRangeAll(cursor.start, cursor.end, {
          limit,
          reverse: cursor.reverse,
        }),
      catch: (e) => classifyFdbError(label, e),
    }).pipe(
      Effect.map((pairs) => {
        const entries = pairs.map(([k, v]) => [toUint8Array(k), toUint8Array(v)] as const);
        const remaining =
          cursor.remaining === undefined ? undefined : cursor.remaining - entries.length;
        const hasMorePage = pairs.length === limit && (remaining === undefined || remaining > 0);
        const lastKey = pairs.length > 0 ? pairs[pairs.length - 1]![0] : null;
        const nextCursor =
          hasMorePage && lastKey !== null
            ? Option.some({
                start: cursor.reverse ? cursor.start : keyAfter(lastKey),
                end: cursor.reverse ? lastKey : cursor.end,
                reverse: cursor.reverse,
                remaining,
              })
            : Option.none<RangeCursor>();

        return [entries, nextCursor] as const;
      }),
      Effect.orDie,
    );
  });
};

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Create a FoundationDB KV backend.
 *
 * This function dynamically imports the `foundationdb` module and opens
 * a connection. If a subspace is configured, all operations are scoped
 * to that key prefix.
 *
 * @param config - Optional configuration (cluster file, subspace, API version)
 * @returns An Effect that produces a KvBackendService
 */
export const makeFdbKvBackendService = (
  config: FdbKvBackendConfig = {},
): Effect.Effect<KvBackendService> =>
  Effect.gen(function* () {
    assertFdbSubspaceConfigured(config, "open");

    // Dynamic import so the module compiles without libfdb_c installed
    const fdb = yield* Effect.tryPromise({
      try: () => import("foundationdb"),
      catch: (error) => new Error(`Failed to load foundationdb module: ${String(error)}`),
    }).pipe(Effect.orDie);

    // Set API version (must be called before any other FDB operation)
    fdb.setAPIVersion(config.apiVersion ?? 720);

    // Open database connection
    const rawDb = fdb.open(config.clusterFile);

    // Apply subspace prefix if configured
    const db = config.subspace ? rawDb.at(config.subspace) : rawDb;
    const rangeScanPageSize = config.rangeScanPageSize ?? DEFAULT_RANGE_SCAN_PAGE_SIZE;
    const maxTransactionBytes = config.maxTransactionBytes ?? DEFAULT_MAX_TRANSACTION_BYTES;
    const maxValueBytes = config.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;
    const transactionTimeoutMs = config.transactionTimeoutMs ?? DEFAULT_TRANSACTION_TIMEOUT_MS;
    const slowTransactionMs = config.slowTransactionMs ?? DEFAULT_SLOW_TRANSACTION_MS;
    const subspaceBytes = config.subspace?.byteLength ?? 0;

    const logRetry = (label: string, retry: number, code: number) => {
      if (!config.logRetries) return;
      process.stderr.write(`  [FDB] ${label} retry #${retry} (code ${code})\n`);
    };

    const emitTransactionMetrics = (metrics: FdbTransactionMetrics): void => {
      config.onTransactionMetrics?.(metrics);

      if (metrics.durationMs >= slowTransactionMs) {
        process.stderr.write(
          `  [FDB] ${metrics.label} slow transaction ${metrics.durationMs}ms ` +
            `(attempts=${metrics.attempts}, retries=${metrics.retries}, conflicts=${metrics.conflicts})\n`,
        );
      }
    };

    const withTransactionTimeout = async <A>(
      label: string,
      promise: Promise<A>,
      onTimeout: () => void,
    ): Promise<A> => {
      let timeout: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          onTimeout();
          reject(
            new FdbKvBackendError({
              operation: label,
              kind: "timeout",
              retryable: false,
              message: `FDB ${label} exceeded ${transactionTimeoutMs}ms transaction timeout`,
            }),
          );
        }, transactionTimeoutMs);
      });

      try {
        return await Promise.race([promise, timeoutPromise]);
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      }
    };

    const runTransactionPromise = <A>(
      label: string,
      body: (tx: FdbTx) => Promise<A>,
    ): Promise<A> => {
      const started = Date.now();
      let attempts = 0;
      let retries = 0;
      let conflicts = 0;
      let timedOut = false;

      const tx = db.rawCreateTransaction({
        timeout: transactionTimeoutMs,
      }) as unknown as InstrumentableFdbTransaction;
      const rawOnError = tx.rawOnError.bind(tx);

      tx.rawOnError = ((code: number, ...args: Array<unknown>) => {
        retries++;
        if (code === FDB_NOT_COMMITTED) {
          conflicts++;
        }
        logRetry(label, retries, code);
        return rawOnError(code, ...args);
      }) as InstrumentableFdbTransaction["rawOnError"];

      return withTransactionTimeout(
        label,
        tx._exec(async (attemptTx) => {
          attempts++;
          return body(attemptTx);
        }),
        () => {
          timedOut = true;
          tx.rawCancel();
        },
      ).finally(() => {
        emitTransactionMetrics({
          label,
          attempts,
          retries,
          conflicts,
          durationMs: Date.now() - started,
          timedOut,
        });
      });
    };

    const runTransaction = <A>(label: string, body: (tx: FdbTx) => Promise<A>): Effect.Effect<A> =>
      Effect.tryPromise({
        try: () => runTransactionPromise(label, body),
        catch: (e) => classifyFdbError(label, e),
      }).pipe(Effect.orDie);

    const dbRangeSource: FdbRangeSource = {
      getRangeAll: (start, end, options) =>
        runTransactionPromise("getRange", async (tx) =>
          tx.snapshot().getRangeAll(start, end, options),
        ),
    };

    // ─── Service implementation ────────────────────────────────────────

    const service: KvBackendService = {
      get: (key) =>
        runTransaction("get", async (tx) => tx.snapshot().get(toBuffer(key))).pipe(
          Effect.map((val) => (val === undefined ? null : toUint8Array(val))),
        ),

      set: (key, value) =>
        Effect.sync(() => assertValueWithinLimit("set", value, maxValueBytes)).pipe(
          Effect.flatMap(() =>
            runTransaction("set", async (tx) => {
              tx.set(toBuffer(key), toBuffer(value));
            }),
          ),
        ),

      delete: (key) =>
        runTransaction("delete", async (tx) => {
          tx.clear(toBuffer(key));
        }),

      getRange: (options) =>
        makePagedRangeStream(dbRangeSource, options, rangeScanPageSize, "getRange"),

      transact: <A, E>(fn: (tx: KvTransaction) => Effect.Effect<A, E>) =>
        Effect.callback<A, E>((resume) => {
          runTransactionPromise("transaction", async (fdbTx) => {
            // Wrap the FDB transaction in a KvTransaction interface
            const kvTx: KvTransaction = {
              get: (key) =>
                Effect.tryPromise({
                  try: () => fdbTx.get(toBuffer(key)),
                  catch: (e) => classifyFdbError("tx.get", e),
                }).pipe(
                  Effect.map((val) => (val === undefined ? null : toUint8Array(val))),
                  Effect.orDie,
                ),

              set: (key, value) =>
                Effect.sync(() => {
                  assertValueWithinLimit("tx.set", value, maxValueBytes);
                  fdbTx.set(toBuffer(key), toBuffer(value));
                }),

              delete: (key) =>
                Effect.sync(() => {
                  fdbTx.clear(toBuffer(key));
                }),

              getRange: (rangeOpts) =>
                makePagedRangeStream(fdbTx, rangeOpts, rangeScanPageSize, "tx.getRange"),
            };

            // Execute the user's function within the FDB transaction
            const exit = await Effect.runPromiseExit(fn(kvTx));

            if (exit._tag === "Failure") {
              // Throw to abort the FDB transaction (triggers rollback)
              // We stash the exit so we can resume with it after doTransaction rejects.
              throw { __fdbKvRollback: true, exit };
            }

            return exit.value;
          }).then(
            (value) => resume(Effect.succeed(value as A)),
            (error) => {
              if (
                error !== null &&
                typeof error === "object" &&
                "__fdbKvRollback" in error &&
                error.__fdbKvRollback === true
              ) {
                // User-initiated rollback — resume with the original failure
                resume(Effect.failCause((error as any).exit.cause));
              } else {
                // Unexpected FDB error — die
                resume(Effect.die(classifyFdbError("transaction", error)));
              }
            },
          );
        }) as Effect.Effect<A, E>,

      getMany: (keys) =>
        runTransaction("getMany", async (tx) => {
          // Fire all gets concurrently — FDB client batches them into
          // a single network round trip automatically.
          const bufKeys = keys.map(toBuffer);
          const values = await Promise.all(bufKeys.map((k) => tx.get(k)));
          return keys.map(
            (key, i) => [key, values[i] === undefined ? null : toUint8Array(values[i]!)] as const,
          );
        }),

      setAll: (entries) =>
        Effect.gen(function* () {
          const chunks = yield* Effect.sync(() =>
            chunkEntriesByByteSize(entries, {
              maxTransactionBytes,
              maxTransactionEntries: config.maxTransactionEntries,
              maxValueBytes,
              subspaceBytes,
            }),
          );

          for (const chunk of chunks) {
            yield* runTransaction(chunks.length === 1 ? "setAll" : "setAll-chunk", async (tx) => {
              for (const [key, value] of chunk) {
                tx.set(toBuffer(key), toBuffer(value));
              }
            });
          }
        }),

      clear: () =>
        runTransaction("clear", async (tx) => {
          tx.clearRange(ZERO, FF);
        }),

      // FDB is async-only — no sync fast paths are provided.
      // Optional properties are intentionally omitted (exactOptionalPropertyTypes).
    };

    return service;
  });

// ─── Effect Layer ──────────────────────────────────────────────────────────

/**
 * Create a Layer that provides KvBackend backed by FoundationDB.
 *
 * @param config - Optional FDB configuration
 * @returns Layer providing KvBackend
 *
 * @example
 * ```typescript
 * // With subspace isolation
 * const layer = makeFdbKvBackend({
 *   subspace: Buffer.from("ontology/db1/"),
 * });
 *
 * // Full stack
 * const app = KvTriples.layerBackend.pipe(
 *   Layer.provide(layer),
 *   Layer.provide(TripleStoreRuntimeLayer),
 * );
 * ```
 */
export const makeFdbKvBackend = (config?: FdbKvBackendConfig): Layer.Layer<KvBackend> =>
  Layer.effect(KvBackend, makeFdbKvBackendService(config));

/**
 * Default FDB KV backend layer. Acquisition fails until callers configure a
 * subspace, preventing accidental cluster-root access.
 */
export const FdbKvBackendLive: Layer.Layer<KvBackend> = makeFdbKvBackend();
