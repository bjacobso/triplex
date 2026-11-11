/** Browser-safe, journal-driven complete query observations. */
import { Clock, Context, Deferred, Effect, Layer, Semaphore, Stream } from "effect";
import {
  Triples,
  type QueryResponse,
  type PagedQueryResponse,
  type TransactionRecord,
} from "../store/Triples.js";
import type { DatalogQuery, WrappedQuery } from "../datalog/types.js";
import { validateDatalogQuery, validateWrappedQuery } from "../datalog/validation.js";
import { extractDependencies } from "../subscriptions/extract-dependencies.js";
import { encodeOrThrow, type CanonicalValue } from "../content/CanonicalJson.js";
import { hash } from "../content/ContentId.js";
import { type DatabaseScope, validateDatabaseScope } from "../runtime/DatabaseScope.js";
import {
  WatchOptionsError,
  WatchResumeError,
  WatchResultTooLarge,
  type ReadError,
  type DatalogQueryError,
  type PaginationCursorError,
} from "../errors/index.js";
export { WatchOptionsError, WatchResumeError, WatchResultTooLarge } from "../errors/index.js";

export interface WatchOptions {
  readonly validTime?: { readonly mode: "now" } | { readonly mode: "fixed"; readonly at: number };
  readonly resume?: string;
  readonly coalesceMs?: number;
  readonly maxRows?: number;
}
export interface WatchSnapshot {
  readonly version: 1;
  readonly watchId: string;
  readonly eventId: string;
  readonly position: number;
  readonly validAt: number | null;
  readonly reason: "initial" | "resume" | "commit" | "time" | "coalesced";
  readonly coveredAfter: number | null;
  readonly result: QueryResponse | PagedQueryResponse;
  readonly nextTemporalBoundary: number | null;
  readonly resume: string;
}
export type WatchError =
  | WatchOptionsError
  | WatchResumeError
  | WatchResultTooLarge
  | ReadError
  | DatalogQueryError
  | PaginationCursorError;
export interface LiveQueryOptions {
  /** Server-resolved identity. Persist the generation across restarts; change it after restore. */
  readonly scope: DatabaseScope;
  readonly idleCheckMs?: number;
  readonly evaluationConcurrency?: number;
}
export interface WatchMetrics {
  readonly scannedHead: number;
  readonly deliveredPosition: number;
  readonly evaluationDurationMs: number;
  readonly pendingSubscribers: number;
  readonly timerLatenessMs: number;
}
export interface LiveQueryService {
  readonly watch: (
    query: DatalogQuery | WrappedQuery,
    options?: WatchOptions,
  ) => Stream.Stream<WatchSnapshot, WatchError>;
  readonly metrics: Effect.Effect<WatchMetrics>;
}
const canonical = (value: unknown) => encodeOrThrow(value as CanonicalValue);
const digest = (domain: string, value: unknown) =>
  hash(`triplex/live-query/${domain}`, canonical(value));
const optionError = (message: string) => new WatchOptionsError({ message });
const resumeError = (message: string) => new WatchResumeError({ message });
const integer = (n: number, min: number, max: number) =>
  Number.isInteger(n) && n >= min && n <= max;
interface Token {
  readonly version: 1;
  readonly watchId: string;
  readonly position: number;
  readonly validAt: number | null;
  readonly eventId: string;
}
interface Registration {
  deadline: number | null;
  waiting: boolean;
  rollback: boolean;
  readonly followsClock: boolean;
  pulse: Deferred.Deferred<void>;
}

/** Install once per scoped database runtime. Each pull owns its delivery position. */
export class LiveQuery extends Context.Service<LiveQuery, LiveQueryService>()("triplex/LiveQuery") {
  static layer(options: LiveQueryOptions): Layer.Layer<LiveQuery, WatchOptionsError, Triples> {
    return Layer.effect(
      LiveQuery,
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => validateDatabaseScope(options.scope),
          catch: () => optionError("A valid database generation scope is required"),
        });
        const idle = options.idleCheckMs ?? 1000;
        const concurrency = options.evaluationConcurrency ?? 4;
        if (!integer(idle, 1, 1000) || !integer(concurrency, 1, 1024))
          return yield* optionError(
            "idleCheckMs must be 1..1000; evaluationConcurrency must be 1..1024",
          );
        const triples = yield* Triples;
        const permits = yield* Semaphore.make(concurrency);
        const registrations = new Set<Registration>();
        const byAttribute = new Map<string, Set<Registration>>();
        const wildcard = new Set<Registration>();
        let changed = Deferred.makeUnsafe<void>();
        let scannedHead = 0;
        let coordinatorInitialized = false;
        let deliveredPosition = 0;
        let evaluationDurationMs = 0;
        let timerLatenessMs = 0;
        let failure: ReadError | undefined;
        // Only the most recent bounded journal page is retained. Slow readers replay storage.
        let cache: { after: number; rows: readonly TransactionRecord[] } | undefined;
        const wake = Effect.sync(() => {
          Deferred.doneUnsafe(changed, Effect.void);
        });
        const notify = (registration: Registration) => {
          const previous = registration.pulse;
          registration.pulse = Deferred.makeUnsafe<void>();
          Deferred.doneUnsafe(previous, Effect.void);
        };
        const coordinator = Effect.gen(function* () {
          let previousNow = yield* Clock.currentTimeMillis;
          while (true) {
            const signal = changed;
            if (![...registrations].some((r) => r.waiting)) {
              yield* Deferred.await(signal);
              changed = Deferred.makeUnsafe<void>();
              continue;
            }
            const now = yield* Clock.currentTimeMillis;
            const affected = new Set<Registration>();
            const invalidateAll = () => {
              for (const r of registrations) affected.add(r);
            };
            const read = yield* Effect.result(
              Effect.gen(function* () {
                const head = yield* triples.currentPosition();
                while (scannedHead < head) {
                  const page = yield* triples.transactions({ after: scannedHead, limit: 1000 });
                  cache = { after: scannedHead, rows: page.transactions };
                  const rows = page.transactions.filter((tx) => tx.position <= head);
                  if (rows.length === 0) {
                    scannedHead = head;
                    invalidateAll();
                    break;
                  }
                  for (const tx of rows) {
                    if (tx.position > scannedHead + 1) invalidateAll();
                    scannedHead = tx.position;
                    for (const r of wildcard) affected.add(r);
                    if (!Array.isArray(tx.changes)) {
                      invalidateAll();
                      continue;
                    }
                    for (const change of tx.changes) {
                      if (
                        !change ||
                        typeof change.attribute !== "string" ||
                        change.value === undefined
                      ) {
                        invalidateAll();
                        break;
                      }
                      for (const r of byAttribute.get(change.attribute) ?? []) affected.add(r);
                    }
                  }
                }
              }),
            );
            failure = read._tag === "Failure" ? read.failure : undefined;
            if (failure) invalidateAll();
            for (const r of registrations) {
              if (now < previousNow && r.followsClock) {
                r.rollback = true;
                affected.add(r);
              }
              if (r.deadline !== null && r.deadline <= now) affected.add(r);
            }
            for (const r of affected) notify(r);
            const deadlines = [...registrations].flatMap((r) =>
              !r.waiting || r.deadline === null ? [] : [r.deadline],
            );
            const deadline = deadlines.length ? Math.min(...deadlines) : Infinity;
            // A due deadline is owned by the next pull. Do not spin while its consumer is blocked.
            const delay = deadline > now ? Math.min(idle, deadline - now) : idle;
            previousNow = now;
            yield* Effect.raceFirst(Effect.sleep(delay), Deferred.await(signal));
            if (changed === signal) changed = Deferred.makeUnsafe<void>();
          }
        });
        yield* Effect.forkScoped(coordinator);
        return {
          metrics: Effect.sync(() => ({
            scannedHead,
            deliveredPosition,
            evaluationDurationMs,
            pendingSubscribers: registrations.size,
            timerLatenessMs,
          })),
          watch: (input, supplied = {}) =>
            Stream.fromPull(
              Effect.gen(function* () {
                const watchOptions = yield* Effect.try({
                  try: () => {
                    if (
                      supplied === null ||
                      typeof supplied !== "object" ||
                      Array.isArray(supplied)
                    )
                      throw optionError("Options must be an object");
                    const copy = JSON.parse(canonical(supplied)) as WatchOptions;
                    if (
                      (copy.validTime !== undefined &&
                        (copy.validTime === null || typeof copy.validTime !== "object")) ||
                      (copy.resume !== undefined && typeof copy.resume !== "string") ||
                      (copy.coalesceMs !== undefined && typeof copy.coalesceMs !== "number") ||
                      (copy.maxRows !== undefined && typeof copy.maxRows !== "number")
                    )
                      throw optionError("Malformed watch options");
                    return copy;
                  },
                  catch: () => optionError("Malformed watch options"),
                });
                // Clone before validation so callers cannot mutate a running watch or its identity.
                const cloned = yield* Effect.try({
                  try: () => {
                    const value: unknown = JSON.parse(canonical(input));
                    if (value === null || typeof value !== "object" || Array.isArray(value))
                      throw optionError("Query must be an object");
                    return value as DatalogQuery | WrappedQuery;
                  },
                  catch: () => optionError("Query must be canonical JSON"),
                });
                const wrapped = "inner" in cloned;
                const raw = wrapped ? cloned.inner : cloned;
                const query = wrapped
                  ? yield* validateWrappedQuery(cloned)
                  : yield* validateDatalogQuery(cloned);
                const coalesceMs = watchOptions.coalesceMs ?? 0;
                const maxRows = watchOptions.maxRows ?? 10_000;
                const temporal = watchOptions.validTime ?? { mode: "now" as const };
                if (!integer(coalesceMs, 0, 1000) || !integer(maxRows, 1, 100_000))
                  return yield* optionError(
                    "coalesceMs must be 0..1000; maxRows must be 1..100000",
                  );
                if (temporal.mode !== "now" && temporal.mode !== "fixed")
                  return yield* optionError("Unknown valid-time mode");
                if (temporal.mode === "fixed" && (!Number.isFinite(temporal.at) || temporal.at < 0))
                  return yield* optionError(
                    "Fixed valid time must be a nonnegative finite timestamp",
                  );
                if (raw.validTime === "all" && watchOptions.validTime !== undefined)
                  return yield* optionError("All-valid-time queries cannot have a point option");
                for (const object of [cloned, raw]) {
                  if (
                    "recordedAt" in object ||
                    "recordedPosition" in object ||
                    "basis" in object ||
                    "validAt" in object
                  )
                    return yield* optionError("Watch inputs cannot pin a temporal basis");
                }
                if (wrapped && cloned.cursor !== undefined)
                  return yield* optionError("Continuation cursors cannot define moving windows");
                const watchId = digest("watch", [
                  options.scope,
                  query,
                  temporal,
                  coalesceMs,
                  maxRows,
                ]);
                const eventId = (position: number, validAt: number | null) =>
                  digest("event", [1, watchId, position, validAt]);
                let token: Token | undefined;
                if (watchOptions.resume !== undefined) {
                  token = yield* Effect.try({
                    try: () => {
                      const value = JSON.parse(watchOptions.resume!) as Token;
                      if (
                        value.version !== 1 ||
                        value.watchId !== watchId ||
                        !Number.isSafeInteger(value.position) ||
                        value.position < 0 ||
                        (value.validAt !== null &&
                          (!Number.isFinite(value.validAt) || value.validAt < 0)) ||
                        (raw.validTime === "all") !== (value.validAt === null) ||
                        (temporal.mode === "fixed" && value.validAt !== temporal.at) ||
                        value.eventId !== eventId(value.position, value.validAt)
                      )
                        throw resumeError("Invalid resume identity or basis");
                      return value;
                    },
                    catch: () => resumeError("Malformed, changed or incompatible resume token"),
                  });
                }
                const deps = extractDependencies(raw);
                const metadata = [...deps.attributes].some((a) => a.startsWith(":_tx/"));
                const relevant = (tx: TransactionRecord) =>
                  metadata ||
                  deps.hasDynamicAttributes ||
                  !Array.isArray(tx.changes) ||
                  tx.changes.some(
                    (c) =>
                      !c ||
                      typeof c.attribute !== "string" ||
                      c.value === undefined ||
                      deps.attributes.has(c.attribute),
                  );
                const registration: Registration = {
                  deadline: null,
                  waiting: false,
                  rollback: false,
                  followsClock: raw.validTime !== "all" && temporal.mode === "now",
                  pulse: Deferred.makeUnsafe<void>(),
                };
                yield* Effect.acquireRelease(
                  Effect.sync(() => {
                    registrations.add(registration);
                    if (deps.hasDynamicAttributes || metadata) wildcard.add(registration);
                    for (const attribute of deps.attributes) {
                      const bucket = byAttribute.get(attribute) ?? new Set<Registration>();
                      bucket.add(registration);
                      byAttribute.set(attribute, bucket);
                    }
                    return registration;
                  }).pipe(Effect.tap(() => wake)),
                  (r) =>
                    Effect.sync(() => {
                      registrations.delete(r);
                      wildcard.delete(r);
                      for (const attribute of deps.attributes) {
                        const bucket = byAttribute.get(attribute);
                        bucket?.delete(r);
                        if (bucket?.size === 0) byAttribute.delete(attribute);
                      }
                    }).pipe(Effect.andThen(wake)),
                );
                // Registration precedes capture. A write racing either step is included or replayed.
                const head = yield* triples.currentPosition();
                if (!coordinatorInitialized) {
                  scannedHead = head;
                  coordinatorInitialized = true;
                }
                if (token && token.position > head)
                  return yield* resumeError("Resume token is ahead of the committed head");
                let scanned = token?.position ?? head;
                let emitted: number | null = null;
                let initialized = false;
                let offline = token !== undefined;
                let lastTime: number | null = null;
                const validNow = Effect.map(Clock.currentTimeMillis, (now) =>
                  raw.validTime === "all" ? null : temporal.mode === "fixed" ? temporal.at : now,
                );
                const evaluate = (
                  position: number,
                  requestedValidAt: number | null | undefined,
                  reason: WatchSnapshot["reason"],
                ) =>
                  permits.withPermits(1)(
                    Effect.gen(function* () {
                      const start = yield* Clock.currentTimeMillis;
                      const validAt =
                        requestedValidAt === undefined ? yield* validNow : requestedValidAt;
                      const basis = {
                        recordedPosition: position,
                        ...(validAt === null ? {} : { validAt }),
                      };
                      const result = wrapped
                        ? yield* triples.queryPage(query as WrappedQuery, { basis })
                        : yield* triples.queryAll(query as DatalogQuery, { basis });
                      if (!wrapped && result.results.length > maxRows)
                        return yield* new WatchResultTooLarge({
                          message: `Complete result exceeds maxRows (${maxRows})`,
                          maxRows,
                          rows: result.results.length,
                        });
                      const state =
                        validAt !== null && temporal.mode === "now"
                          ? yield* deps.hasDynamicAttributes
                              ? triples.dependencyStateAll(basis)
                              : triples.dependencyState([...deps.attributes], basis)
                          : undefined;
                      const deadline = state?.nextTemporalBoundary ?? null;
                      const id = eventId(position, validAt);
                      const snapshot: WatchSnapshot = {
                        version: 1,
                        watchId,
                        eventId: id,
                        position,
                        validAt,
                        reason,
                        coveredAfter: emitted,
                        result,
                        nextTemporalBoundary: deadline,
                        resume: canonical({ version: 1, watchId, eventId: id, position, validAt }),
                      };
                      timerLatenessMs =
                        reason === "time" && registration.deadline !== null
                          ? Math.max(0, start - registration.deadline)
                          : 0;
                      evaluationDurationMs = (yield* Clock.currentTimeMillis) - start;
                      registration.deadline = deadline;
                      emitted = position;
                      deliveredPosition = position;
                      lastTime = validAt;
                      registration.rollback = false;
                      yield* wake;
                      return snapshot;
                    }),
                  );
                const pull: Effect.Effect<readonly [WatchSnapshot], WatchError> = Effect.gen(
                  function* () {
                    if (!initialized) {
                      const snapshot = yield* evaluate(
                        scanned,
                        token ? token.validAt : undefined,
                        token ? "resume" : "initial",
                      );
                      initialized = true;
                      return [snapshot] as const;
                    }
                    while (true) {
                      const signal = registration.pulse;
                      if (failure) return yield* failure;
                      let target = yield* triples.currentPosition();
                      let invalidated = false;
                      if (coalesceMs > 0 && target > scanned) {
                        const now = yield* Clock.currentTimeMillis;
                        const delay =
                          registration.deadline === null
                            ? coalesceMs
                            : Math.max(0, Math.min(coalesceMs, registration.deadline - now));
                        yield* Effect.sleep(delay);
                        target = yield* triples.currentPosition();
                      }
                      while (scanned < target) {
                        const rows =
                          cache &&
                          cache.after <= scanned &&
                          (cache.rows.at(-1)?.position ?? 0) > scanned
                            ? cache.rows.filter((t) => t.position > scanned)
                            : (yield* triples.transactions({ after: scanned, limit: 1000 }))
                                .transactions;
                        const tx = rows.find((t) => t.position <= target);
                        if (!tx) {
                          scanned = target;
                          invalidated = true;
                        } else {
                          const gap = tx.position > scanned + 1;
                          // A maintenance cut is independently observable before the next commit.
                          scanned = gap ? tx.position - 1 : tx.position;
                          invalidated ||= gap || relevant(tx);
                        }
                        if (invalidated && coalesceMs === 0)
                          return [yield* evaluate(scanned, undefined, "commit")] as const;
                      }
                      if (invalidated)
                        return [yield* evaluate(target, undefined, "coalesced")] as const;
                      const now = yield* validNow;
                      if (
                        offline ||
                        registration.rollback ||
                        (now !== null &&
                          temporal.mode === "now" &&
                          ((registration.deadline !== null && now >= registration.deadline) ||
                            (lastTime !== null && now < lastTime)))
                      ) {
                        offline = false;
                        return [yield* evaluate(target, undefined, "time")] as const;
                      }
                      yield* Deferred.await(signal);
                    }
                  },
                );
                return Effect.sync(() => {
                  registration.waiting = true;
                }).pipe(
                  Effect.andThen(wake),
                  Effect.andThen(pull),
                  Effect.ensuring(
                    Effect.sync(() => {
                      registration.waiting = false;
                    }).pipe(Effect.andThen(wake)),
                  ),
                );
              }),
            ).pipe(Stream.scoped),
        } satisfies LiveQueryService;
      }),
    );
  }
}
