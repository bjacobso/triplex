/**
 * FoundationDB-backed subscription invalidation.
 *
 * FDB watches are key-level invalidation signals, not durable event delivery.
 * This service writes coarse dependency watch keys for ChangeEvents and lets
 * subscribers watch dependency keys to know when to rerun their query.
 */

import { Context, Effect, Layer } from "effect";
import {
  ChangeEmitter,
  type ChangeEmitterService,
  type ChangeEvent,
} from "@triplex-build/triplex/internal";
import { extractEntityType, type QueryDependencies } from "@triplex-build/triplex/subscriptions";
import type FdbDatabase from "foundationdb/dist/lib/database.js";
import type FdbTransaction from "foundationdb/dist/lib/transaction.js";
import type { Watch } from "foundationdb/dist/lib/transaction.js";
import type { NativeValue } from "foundationdb/dist/lib/native.js";
import {
  assertFdbSubspaceConfigured,
  classifyFdbError,
  type FdbKvBackendConfig,
  type FdbKvBackendError,
} from "./FdbKvBackend.js";

// ─── Types ─────────────────────────────────────────────────────────────────

type FdbDb = FdbDatabase<NativeValue, Buffer, NativeValue, Buffer>;
type FdbTx = FdbTransaction<NativeValue, Buffer, NativeValue, Buffer>;

export interface FdbSubscriptionWatchOptions {
  /**
   * Coalesce multiple watch firings into one callback.
   *
   * Defaults to 50ms.
   */
  readonly debounceMs?: number;

  /**
   * Delay before re-arming a watch after a watch error.
   *
   * Defaults to 250ms.
   */
  readonly retryDelayMs?: number;
}

export interface FdbSubscriptionHandle {
  readonly close: () => Effect.Effect<void>;
}

export interface FdbSubscriptionService {
  /**
   * Signal a committed storage change by bumping dependency watch keys.
   */
  readonly signal: (event: ChangeEvent) => Effect.Effect<void, FdbKvBackendError>;

  /**
   * Watch the FDB keys corresponding to statically extracted query dependencies.
   */
  readonly watchDependencies: (
    dependencies: QueryDependencies,
    onInvalidate: () => Effect.Effect<void>,
    options?: FdbSubscriptionWatchOptions,
  ) => Effect.Effect<FdbSubscriptionHandle, FdbKvBackendError>;

  /**
   * Watch explicit dependency keys.
   */
  readonly watchKeys: (
    keys: ReadonlyArray<Uint8Array>,
    onInvalidate: () => Effect.Effect<void>,
    options?: FdbSubscriptionWatchOptions,
  ) => Effect.Effect<FdbSubscriptionHandle, FdbKvBackendError>;
}

export class FdbSubscriptions extends Context.Service<FdbSubscriptions, FdbSubscriptionService>()(
  "FdbSubscriptions",
) {}

// ─── Watch Key Encoding ────────────────────────────────────────────────────

const WATCH_PREFIX = Buffer.from("__oo_subscriptions__/", "utf8");
const WATCH_GLOBAL = Buffer.concat([WATCH_PREFIX, Buffer.from("global", "utf8")]);

const textKey = (kind: string, value: string): Buffer =>
  Buffer.concat([
    WATCH_PREFIX,
    Buffer.from(kind, "utf8"),
    Buffer.from("/", "utf8"),
    Buffer.from(value, "utf8"),
  ]);

const toBuffer = (u: Uint8Array): Buffer =>
  Buffer.isBuffer(u) ? u : Buffer.from(u.buffer, u.byteOffset, u.byteLength);

const dedupeBuffers = (keys: ReadonlyArray<Buffer>): Buffer[] => {
  const seen = new Set<string>();
  const result: Buffer[] = [];
  for (const key of keys) {
    const hex = key.toString("hex");
    if (!seen.has(hex)) {
      seen.add(hex);
      result.push(key);
    }
  }
  return result;
};

export const fdbSubscriptionGlobalKey = (): Uint8Array => WATCH_GLOBAL;

export const fdbSubscriptionAttributeKey = (attribute: string): Uint8Array =>
  textKey("attr", attribute);

export const fdbSubscriptionEntityKey = (entityId: string): Uint8Array =>
  textKey("entity", entityId);

export const fdbSubscriptionEntityTypeKey = (entityType: string): Uint8Array =>
  textKey("type", entityType);

export const fdbSubscriptionKeysForEvent = (event: ChangeEvent): ReadonlyArray<Uint8Array> => {
  const keys: Buffer[] = [WATCH_GLOBAL];
  for (const change of event.changes) {
    keys.push(toBuffer(fdbSubscriptionAttributeKey(change.attribute)));
    keys.push(toBuffer(fdbSubscriptionEntityKey(change.entityId)));

    const entityType = extractEntityType(change.attribute);
    if (entityType !== null) {
      keys.push(toBuffer(fdbSubscriptionEntityTypeKey(entityType)));
    }
  }
  return dedupeBuffers(keys);
};

export const fdbSubscriptionKeysForDependencies = (
  dependencies: QueryDependencies,
): ReadonlyArray<Uint8Array> => {
  const keys: Buffer[] = [];

  if (dependencies.hasDynamicAttributes) {
    keys.push(WATCH_GLOBAL);
  }

  for (const attribute of dependencies.attributes) {
    keys.push(toBuffer(fdbSubscriptionAttributeKey(attribute)));
  }
  for (const entityType of dependencies.entityTypes) {
    keys.push(toBuffer(fdbSubscriptionEntityTypeKey(entityType)));
  }
  for (const entityId of dependencies.boundEntityIds) {
    keys.push(toBuffer(fdbSubscriptionEntityKey(entityId)));
  }

  if (keys.length === 0) {
    keys.push(WATCH_GLOBAL);
  }

  return dedupeBuffers(keys);
};

// ─── Service Factory ───────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const makeMarkerFactory = () => {
  let counter = 0;
  return (event: ChangeEvent): Buffer => {
    counter++;
    return Buffer.from(`${event.timestamp}:${event.txId}:${counter}`, "utf8");
  };
};

export const makeFdbSubscriptionService = (
  config: FdbKvBackendConfig = {},
): Effect.Effect<FdbSubscriptionService> =>
  Effect.gen(function* () {
    assertFdbSubspaceConfigured(config, "subscriptions.open");

    const fdb = yield* Effect.tryPromise({
      try: () => import("foundationdb"),
      catch: (error) => new Error(`Failed to load foundationdb module: ${String(error)}`),
    }).pipe(Effect.orDie);

    fdb.setAPIVersion(config.apiVersion ?? 720);

    const rawDb = fdb.open(config.clusterFile);
    const db = (config.subspace ? rawDb.at(config.subspace) : rawDb) as FdbDb;
    const transactionTimeoutMs = config.transactionTimeoutMs ?? 4_500;
    const nextMarker = makeMarkerFactory();

    const runTransaction = <A>(
      label: string,
      body: (tx: FdbTx) => Promise<A>,
    ): Effect.Effect<A, FdbKvBackendError> =>
      Effect.tryPromise({
        try: () => db.doTransaction(body, { timeout: transactionTimeoutMs }),
        catch: (e) => classifyFdbError(label, e),
      });

    const getWatch = (key: Buffer): Promise<Watch> =>
      db.doTransaction(
        async (tx) => {
          await tx.get(key);
          return tx.watch(key, { throwAllErrors: true });
        },
        { timeout: transactionTimeoutMs },
      );

    const startWatchLoop = (
      key: Buffer,
      scheduleInvalidate: () => void,
      retryDelayMs: number,
    ): { readonly ready: Promise<void>; readonly close: () => void } => {
      let closed = false;
      let activeWatch: Watch | null = null;
      let resolveReady: (() => void) | null = null;
      let rejectReady: ((error: unknown) => void) | null = null;
      let readySettled = false;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });

      const settleReady = (error?: unknown) => {
        if (readySettled) return;
        readySettled = true;
        if (error === undefined) {
          resolveReady?.();
        } else {
          rejectReady?.(error);
        }
      };

      const loop = async () => {
        while (!closed) {
          try {
            const watch = await getWatch(key);
            activeWatch = watch;
            settleReady();

            await watch.promise;
            activeWatch = null;

            if (!closed) {
              scheduleInvalidate();
            }
          } catch (error) {
            activeWatch = null;
            if (closed) return;

            if (!readySettled) {
              settleReady(error);
              return;
            }

            scheduleInvalidate();
            await sleep(retryDelayMs);
          }
        }
      };

      void loop();

      return {
        ready,
        close: () => {
          closed = true;
          activeWatch?.cancel();
        },
      };
    };

    const watchKeys: FdbSubscriptionService["watchKeys"] = (keys, onInvalidate, options = {}) => {
      const buffers = dedupeBuffers(keys.map(toBuffer));
      const debounceMs = options.debounceMs ?? 50;
      const retryDelayMs = options.retryDelayMs ?? 250;

      return Effect.tryPromise({
        try: async () => {
          let closed = false;
          let debounceTimer: NodeJS.Timeout | null = null;

          const scheduleInvalidate = () => {
            if (closed || debounceTimer !== null) return;
            debounceTimer = setTimeout(() => {
              debounceTimer = null;
              if (!closed) {
                void Effect.runPromise(onInvalidate()).catch(() => undefined);
              }
            }, debounceMs);
          };

          const loops = buffers.map((key) => startWatchLoop(key, scheduleInvalidate, retryDelayMs));
          try {
            await Promise.all(loops.map((loop) => loop.ready));
          } catch (error) {
            closed = true;
            if (debounceTimer !== null) {
              clearTimeout(debounceTimer);
              debounceTimer = null;
            }
            for (const loop of loops) {
              loop.close();
            }
            throw error;
          }

          return {
            close: () =>
              Effect.sync(() => {
                closed = true;
                if (debounceTimer !== null) {
                  clearTimeout(debounceTimer);
                  debounceTimer = null;
                }
                for (const loop of loops) {
                  loop.close();
                }
              }),
          };
        },
        catch: (e) => classifyFdbError("watchKeys", e),
      });
    };

    const service: FdbSubscriptionService = {
      signal: (event) =>
        runTransaction("subscription.signal", async (tx) => {
          const marker = nextMarker(event);
          for (const key of fdbSubscriptionKeysForEvent(event)) {
            tx.set(toBuffer(key), marker);
          }
        }),

      watchDependencies: (dependencies, onInvalidate, options) =>
        watchKeys(fdbSubscriptionKeysForDependencies(dependencies), onInvalidate, options),

      watchKeys,
    };

    return service;
  });

export const makeFdbSubscriptions = (config?: FdbKvBackendConfig): Layer.Layer<FdbSubscriptions> =>
  Layer.effect(FdbSubscriptions, makeFdbSubscriptionService(config));

export const makeFdbChangeEmitterService = (
  config?: FdbKvBackendConfig,
): Effect.Effect<ChangeEmitterService> =>
  makeFdbSubscriptionService(config).pipe(
    Effect.map((subscriptions) => ({
      emit: (event) => subscriptions.signal(event).pipe(Effect.catch(() => Effect.void)),
    })),
  );

export const makeFdbChangeEmitter = (config?: FdbKvBackendConfig): Layer.Layer<ChangeEmitter> =>
  Layer.effect(ChangeEmitter, makeFdbChangeEmitterService(config));
