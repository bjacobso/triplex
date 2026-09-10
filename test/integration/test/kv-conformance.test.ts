import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { KvTriples } from "@triplex-build/triplex";
import { makeTriplesConformanceSuite } from "@triplex-build/triplex-testkit";

describe("in-memory KV Triples conformance", () => {
  it("matches the shared temporal, pagination, and query contract", async () => {
    await expect(
      Effect.runPromise(
        makeTriplesConformanceSuite().pipe(
          Effect.provide(KvTriples.layerWithScope("conformance")),
          Effect.scoped,
        ) as Effect.Effect<void, unknown, never>,
      ),
    ).resolves.toBeUndefined();
  });
});
