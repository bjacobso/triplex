import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { KvTriples } from "@triplex-build/triplex";

import {
  makeSealedStorageSuite,
  makeSensitiveConformanceSuite,
  makeTriplesConformanceSuite,
  sensitiveConformanceLayer,
} from "../src/index.js";

describe("sensitive-value conformance on in-memory KV", () => {
  it("passes the sealed-storage engine contract", async () => {
    await expect(
      Effect.runPromise(
        makeSealedStorageSuite().pipe(Effect.provide(Layer.fresh(KvTriples.layer))),
      ),
    ).resolves.toBeUndefined();
  });

  it("passes the sensitive decorator contract", async () => {
    await expect(
      Effect.runPromise(
        makeSensitiveConformanceSuite().pipe(
          Effect.provide(sensitiveConformanceLayer(Layer.fresh(KvTriples.layer))),
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps the full Triples contract through the decorator", { timeout: 30_000 }, async () => {
    await expect(
      Effect.runPromise(
        makeTriplesConformanceSuite().pipe(
          Effect.provide(sensitiveConformanceLayer(Layer.fresh(KvTriples.layer))),
        ),
      ),
    ).resolves.toBeUndefined();
  });
});
