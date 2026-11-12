import { expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { Triples } from "@triplex-internal/core";
import { SqliteTriples } from "../src/SqliteTriples.js";

it("exposes only Triples from each SQLite convenience layer", async () => {
  for (const layer of [
    SqliteTriples.layer({ filename: ":memory:" }),
    SqliteTriples.layerMemory,
    SqliteTriples.layerMemoryWithScope("layer-output"),
  ]) {
    const keys = await Effect.runPromise(
      Layer.build(layer).pipe(
        Effect.map((context) =>
          Array.from(context.mapUnsafe.keys()).filter((key) => key !== Layer.CurrentMemoMap.key),
        ),
        Effect.scoped,
      ),
    );
    expect(keys).toEqual([Triples.key]);
  }
});
