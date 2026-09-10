import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeTriplesConformanceSuite } from "@triplex-build/triplex-testkit";
import { CloudflareTriples, type DOState } from "../src/index.js";

describe("CloudflareTriples in workerd", () => {
  it("matches the shared backend contract using native Durable Object SQLite", async () => {
    const stub = env.TRIPLEX_TEST_OBJECTS.getByName("shared-conformance");

    await expect(
      runInDurableObject(stub, async (_instance, state) => {
        await Effect.runPromise(
          makeTriplesConformanceSuite().pipe(
            Effect.provide(
              CloudflareTriples.layer({
                state: state as unknown as DOState,
                scope: "workerd:tenant-a:default:generation-a",
              }),
            ),
            Effect.scoped,
          ) as Effect.Effect<void, unknown, never>,
        );
      }),
    ).resolves.toBeUndefined();
  });
});
