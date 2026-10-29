import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { EntityId, Triples } from "@triplex-build/triplex";
import { Segment } from "@triplex-build/triplex/operational";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";

describe("SQLite segment attachments", () => {
  it("fail without committing anything", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const segment = Segment.build([
          { entityId: EntityId.make("e"), attribute: ":a/b", value: { type: "number", value: 1 } },
        ]);
        const error = yield* Segment.attach(triples, segment).pipe(Effect.flip);
        return { error, position: yield* triples.currentPosition() };
      }).pipe(Effect.provide(SqliteTriples.layerMemory), Effect.scoped),
    );
    expect(result.error._tag).toBe("WriteError");
    expect(result.position).toBe(0);
  });
});
