import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { KvTriples } from "@triplex-internal/core";

import { erasureConformanceLayer, makeErasureSuite, makeRotationSuite } from "../src/index.js";

describe("erasure conformance", () => {
  it("passes on the in-memory KV backend with test keys", async () => {
    await expect(
      Effect.runPromise(
        makeErasureSuite().pipe(
          Effect.andThen(makeRotationSuite()),
          Effect.provide(erasureConformanceLayer(Layer.fresh(KvTriples.layer))),
        ),
      ),
    ).resolves.toBeUndefined();
  });
});
