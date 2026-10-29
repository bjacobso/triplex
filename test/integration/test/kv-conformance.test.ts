import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { KvTriples } from "@triplex-build/triplex";
import { makeTriplesConformanceSuite } from "@triplex-build/triplex-testkit";

describe("in-memory KV Triples conformance", () => {
  // The whole corpus runs serially in one test; it has outgrown Vitest's 5s default under load.
  it(
    "matches the shared temporal, pagination, and query contract",
    { timeout: 30_000 },
    async () => {
      await expect(
        Effect.runPromise(
          makeTriplesConformanceSuite().pipe(
            Effect.provide(KvTriples.layerWithScope("conformance")),
            Effect.scoped,
          ) as Effect.Effect<void, unknown, never>,
        ),
      ).resolves.toBeUndefined();
    },
  );
});
