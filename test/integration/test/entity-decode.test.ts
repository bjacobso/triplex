import { expect, it } from "vitest";
import { Effect } from "effect";
import { EntityId, Triples } from "@triplex-build/triplex";
import { Attribute, EntityType } from "@triplex-build/triplex/config";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";

it("decodes SQLite entity reads and uses source facts for typed temporal replacement", async () => {
  const Worker = EntityType.make("Worker", {
    name: Attribute.text(":worker/name").required(),
    roles: Attribute.enumOf(":worker/role", ["reviewer", "writer"]).many(),
    joined: Attribute.instant(":worker/joined"),
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Triples;
      const id = EntityId.make("worker:maria");
      yield* db.transact(
        Worker.assert(
          id,
          {
            name: "Maria",
            roles: ["reviewer", "writer"],
            joined: new Date(1000),
          },
          { validFrom: 0 },
        ),
      );
      const first = yield* Worker.decode(yield* db.match({ entityId: id }, { validAt: 10 }), {
        withFacts: true,
      });
      expect(first.values).toEqual({ name: "Maria", roles: ["reviewer", "writer"], joined: 1000 });
      const change = Worker.replace(first.facts.name[0]!, { name: "M" }, 20);
      yield* db.transact(change.ops, change);
      expect(yield* Worker.decode(yield* db.match({ entityId: id }, { validAt: 10 }))).toEqual(
        first.values,
      );
      expect(yield* Worker.decode(yield* db.entity(id))).toEqual({ ...first.values, name: "M" });
    }).pipe(Effect.provide(SqliteTriples.layerMemory)),
  );
});
