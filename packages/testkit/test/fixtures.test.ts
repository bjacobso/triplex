import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { KvTriples } from "@triplex-build/triplex";

import {
  defineBackendFixture,
  expectBackendCapability,
  makeTriplesConformanceSuite,
  triplesConformanceCases,
} from "../src/index.js";

describe("database-testkit", () => {
  it("defines lightweight backend fixtures", () => {
    const fixture = defineBackendFixture({
      name: "sqlite",
      capabilities: ["transactions", "history"],
    });

    expect(fixture.name).toBe("sqlite");
    expect(expectBackendCapability(fixture, "transactions")).toBe(true);
    expect(expectBackendCapability(fixture, "changefeed")).toBe(false);
  });

  describe("Triples conformance (in-memory KV)", () => {
    it("passes the full conformance suite", async () => {
      await Effect.runPromise(makeTriplesConformanceSuite().pipe(Effect.provide(KvTriples.layer)));
    });

    for (const c of triplesConformanceCases) {
      it(c.name, async () => {
        await Effect.runPromise(c.run.pipe(Effect.provide(KvTriples.layer)));
      });
    }
  });
});
