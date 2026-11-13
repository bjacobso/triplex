import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { KeyProvider } from "@triplex-internal/core/sensitive";

import { makeKeyStoreSuite } from "../src/index.js";

describe("key store conformance", () => {
  it("passes on the test key provider", async () => {
    await expect(
      Effect.runPromise(
        makeKeyStoreSuite().pipe(Effect.provide(KeyProvider.test({ seed: "key-store-suite" }))),
      ),
    ).resolves.toBeUndefined();
  });
});
