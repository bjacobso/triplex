import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";
import { makeTriplesConformanceSuite } from "@triplex-build/triplex-testkit";

describe("SQLite Triples conformance", () => {
  it("matches the shared KV/SQL contract", async () => {
    await expect(
      Effect.runPromise(
        makeTriplesConformanceSuite().pipe(
          Effect.provide(SqliteTriples.layerMemory),
          Effect.scoped,
        ) as Effect.Effect<void, unknown, never>,
      ),
    ).resolves.toBeUndefined();
  });
});
