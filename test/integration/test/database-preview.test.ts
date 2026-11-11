import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { EntityId, Triples } from "@triplex-build/triplex";
import { Attribute, ConfigStore, EntityType } from "@triplex-build/triplex/config";
import * as Database from "@triplex-build/triplex/database";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";

it("SQLite previews guarded temporal changes and commits the same semantic change set", async () => {
  const Person = EntityType.make("PreviewPerson", {
    name: Attribute.text(":preview/name").required(),
    tag: Attribute.text(":preview/tag").many(),
  });
  const id = EntityId.make("preview:sqlite");
  const store = ConfigStore.layer.pipe(Layer.provideMerge(SqliteTriples.layerMemory));
  await Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* ConfigStore.ConfigStore;
      yield* config.commit({ label: "preview", ref: "live", objects: yield* Person.nodes });
      yield* Effect.gen(function* () {
        const db = yield* Database.Database;
        const triples = yield* Triples;
        const meta = { actor: "sqlite:reviewer", commandId: "sqlite:preview" };
        const build = (tx: Database.Command) =>
          tx.create(Person, id, { name: "Ada", tag: ["present"] }, { validFrom: 10 });
        const head = yield* triples.currentPosition();
        const preview = yield* db.preview(meta, build);
        expect(yield* triples.currentPosition()).toBe(head);
        expect(yield* db.get(Person, id)).toBeNull();
        expect(preview.violations).toEqual([]);
        const receipt = yield* db.command(meta, build);
        expect(receipt.configSnapshot).toBe(preview.release);
        expect(receipt.changes).toHaveLength(preview.changes.length);
        for (const change of preview.changes) {
          expect(receipt.changes).toContainEqual(expect.objectContaining(change));
        }
        expect(
          (yield* db.preview(meta, () => Effect.die("must not run"))).commandAlreadyCommitted,
        ).toEqual(receipt);
        const fact = (yield* triples.history(id)).find((f) => f.attribute === Person.name.key)!;
        const invalid = (tx: Database.Command) =>
          tx
            .end(Person, fact, 20)
            .pipe(Effect.andThen(tx.put(Person, id, { name: "future" }, { validFrom: 30 })));
        const gap = yield* db.preview({ actor: "a", commandId: "gap" }, invalid);
        expect(gap.violations).toContainEqual(
          expect.objectContaining({ code: "required", validAt: 20 }),
        );
        expect(
          (yield* Effect.flip(db.command({ actor: "a", commandId: "gap" }, invalid)))._tag,
        ).toBe("ConstraintViolationError");
      }).pipe(Effect.provide(Database.layer({ schema: { types: [Person] } })));
    }).pipe(Effect.provide(store)),
  );
});
