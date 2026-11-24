/**
 * Test-only Effect Worker + Effect Durable Object that runs Triplex's shared
 * Triples conformance suite against `durableObjectKvLayer` on real workerd
 * Durable Object SQLite.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";

export class ConformanceSession extends Cloudflare.Workers.DurableObject<ConformanceSession>()(
  "ConformanceSession",
  Effect.gen(function* () {
    const state = yield* Cloudflare.Workers.DurableObjectState;

    return Effect.gen(function* () {
      const [
        { makeTriplesConformanceSuite },
        { Capabilities, DatabaseScope, Runtime },
        { durableObjectKvLayer },
      ] = yield* Effect.promise(() =>
        Promise.all([
          import("@triplex-build/triplex-testkit"),
          import("@triplex-build/triplex/runtime"),
          import("../src/kv.ts"),
        ]),
      );

      return {
        run: () =>
          Effect.gen(function* () {
            const runtime = Runtime.fromKv({
              name: "do-kv",
              backend: durableObjectKvLayer(state.raw.storage),
            });
            yield* makeTriplesConformanceSuite().pipe(
              Effect.provide(
                runtime.layer({
                  scope: DatabaseScope.test("conformance"),
                  capabilities: Capabilities.none,
                }),
              ),
              Effect.scoped,
            ) as Effect.Effect<void, unknown, never>;
            return "ok" as const;
          }).pipe(Effect.orDie),
      };
    });
  }),
) {}

export const conformanceWorker = Effect.gen(function* () {
  const objects = yield* ConformanceSession;

  return {
    fetch: Effect.gen(function* () {
      const result = yield* objects.getByName("conformance").run().pipe(Effect.orDie);
      return HttpServerResponse.text(result);
    }),
  };
});

export default Cloudflare.Workers.Worker(
  "Conformance",
  { main: import.meta.url },
  conformanceWorker,
);
