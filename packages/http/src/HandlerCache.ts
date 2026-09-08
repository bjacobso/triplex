import { Context, Effect, Layer, Semaphore } from "effect";

export interface HandlerCacheService {
  readonly get: <A, E, R>(key: string, build: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly size: Effect.Effect<number>;
}

export class HandlerCache extends Context.Service<HandlerCache, HandlerCacheService>()(
  "triplex-http/HandlerCache",
) {}

export const layer = (capacity = 32): Layer.Layer<HandlerCache> =>
  Layer.effect(
    HandlerCache,
    Effect.gen(function* () {
      if (!Number.isSafeInteger(capacity) || capacity < 1) {
        return yield* Effect.die(
          new TypeError("Handler cache capacity must be a positive integer"),
        );
      }
      const lock = yield* Semaphore.make(1);
      const entries = new Map<string, Effect.Effect<unknown, unknown, unknown>>();
      const get: HandlerCacheService["get"] = (key, build) =>
        lock
          .withPermits(1)(
            Effect.gen(function* () {
              const existing = entries.get(key);
              if (existing !== undefined) {
                entries.delete(key);
                entries.set(key, existing);
                return existing as Effect.Effect<never, never, never>;
              }
              const cached = yield* Effect.cached(build);
              entries.set(key, cached as Effect.Effect<unknown, unknown, unknown>);
              while (entries.size > capacity) entries.delete(entries.keys().next().value!);
              return cached;
            }),
          )
          .pipe(Effect.flatten) as Effect.Effect<never, never, never>;
      return {
        get,
        size: Effect.sync(() => entries.size),
      };
    }),
  );
