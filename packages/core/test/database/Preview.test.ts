import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import * as Database from "../../src/database/index.js";
import * as Attribute from "../../src/config/Attribute.js";
import * as EntityType from "../../src/config/EntityType.js";
import * as ConfigStore from "../../src/config/ConfigStore.js";
import * as Derivation from "../../src/derivation/Derivation.js";
import { Sensitive, ValueCodec, KeyProvider } from "../../src/sensitive/index.js";
import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import { EntityId } from "../../src/Branded.js";
import { Triples } from "../../src/store/Triples.js";

const Person = EntityType.make("Person", {
  name: Attribute.text(":person/name").required(),
  tag: Attribute.text(":person/tag").many(),
});
const id = EntityId.make("person:preview");
const base = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));
const setup = Effect.gen(function* () {
  const config = yield* ConfigStore.ConfigStore;
  return (yield* config.commit({ label: "v1", ref: "live", objects: yield* Person.nodes }))
    .snapshot;
});
const withClient = <E>(body: Effect.Effect<void, E, Database.Database | Triples>) =>
  Effect.gen(function* () {
    yield* setup;
    yield* body.pipe(Effect.provide(Database.layer({ schema: { types: [Person] } })));
  });

// Commit-only identifiers and timestamps are deliberately absent from semantic comparisons.
const semantic = (
  changes: readonly {
    readonly op: string;
    readonly entityId: string;
    readonly attribute: string;
    readonly value?: unknown;
    readonly validFrom?: number;
    readonly validTo?: number;
  }[],
) =>
  changes
    .map(({ op, entityId, attribute, value, validFrom, validTo }) => ({
      op,
      entityId,
      attribute,
      value,
      validFrom,
      validTo,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe("Database preview", () => {
  it("compiles the same operations and guards, reports changes, and leaves no receipt until commit", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup;
        const triples = yield* Triples;
        const transact = vi.spyOn(triples, "transact");
        yield* Effect.gen(function* () {
          const db = yield* Database.Database;
          const meta = { actor: "reviewer", commandId: "preview:create" };
          const build = (tx: Database.Command) =>
            tx.create(Person, id, { name: "Ada" }, { validFrom: 10 });
          const preview = yield* db.preview(meta, build);
          expect(preview.operations).toEqual({
            ops: Person.assert(id, { name: "Ada" }, { validFrom: 10 }),
            preconditions: [{ _tag: "EntityAbsent", entityId: id }],
          });
          expect(preview.violations).toEqual([]);
          expect(transact).not.toHaveBeenCalled();
          expect(yield* triples.transactionByCommand(meta.commandId)).toBeNull();
          const receipt = yield* db.command(meta, build);
          expect(transact.mock.calls[0]![0]).toEqual(preview.operations.ops);
          expect(transact.mock.calls[0]![1]?.preconditions).toEqual(
            preview.operations.preconditions,
          );
          expect(receipt.configSnapshot).toBe(preview.release);
          expect(semantic(receipt.changes)).toEqual(semantic(preview.changes));
          const callback = vi.fn(() => Effect.void);
          const retry = yield* db.preview(meta, callback);
          expect(retry.commandAlreadyCommitted).toEqual(receipt);
          expect(callback).not.toHaveBeenCalled();
          const name = (yield* triples.history(id)).find((f) => f.attribute === Person.name.key)!;
          const edit = (tx: Database.Command) => tx.correct(Person, name, { name: "Grace" });
          const correction = yield* db.preview({ actor: "a", commandId: "correction" }, edit);
          const committed = yield* db.command({ actor: "a", commandId: "correction" }, edit);
          expect(semantic(committed.changes)).toEqual(semantic(correction.changes));
        }).pipe(Effect.provide(Database.layer({ schema: { types: [Person] } })));
      }).pipe(Effect.provide(base)),
    );
  });

  it("returns an unpinned primitive receipt without inventing a release", async () => {
    await Effect.runPromise(
      withClient(
        Effect.gen(function* () {
          const triples = yield* Triples;
          const db = yield* Database.Database;
          yield* triples.transact([], { actor: "primitive", commandId: "primitive" });
          const preview = yield* db.preview({ actor: "a", commandId: "primitive" }, () =>
            Effect.die("must not run"),
          );
          expect(preview.commandAlreadyCommitted?.actor).toBe("primitive");
          expect(preview.release).toBeNull();
        }),
      ).pipe(Effect.provide(base)),
    );
  });

  it("returns required violations at their valid-time boundary while command rejects", async () => {
    await Effect.runPromise(
      withClient(
        Effect.gen(function* () {
          const db = yield* Database.Database;
          const meta = { actor: "a", commandId: "invalid" };
          const build = (tx: Database.Command) =>
            tx.put(Person, id, { tag: ["x"] }, { validFrom: 123 });
          const preview = yield* db.preview(meta, build);
          expect(preview.violations).toContainEqual(
            expect.objectContaining({
              code: "required",
              subject: id,
              validAt: 123,
              constraintKey: "Person::person/name:required",
            }),
          );
          expect((yield* Effect.flip(db.command(meta, build)))._tag).toBe(
            "ConstraintViolationError",
          );
        }),
      ).pipe(Effect.provide(base)),
    );
  });

  it("reconciles added, changed and removed derivation candidates without persisting them", async () => {
    await Effect.runPromise(
      withClient(
        Effect.gen(function* () {
          const db = yield* Database.Database;
          const definition = yield* Derivation.make({
            name: "names",
            configSnapshot: "preview",
            query: { find: ["?p", "?n"], where: [["?p", ":person/name", "?n"]] },
            identity: ["?p"],
            output: ["?p", "?n"],
          });
          const preview = yield* db.preview(
            { actor: "a", commandId: "derive" },
            (tx) => tx.put(Person, id, { name: "Ada" }, { validFrom: 0 }),
            { derivations: [definition] },
          );
          expect(preview.derivations[0]?.added).toHaveLength(1);
          expect(yield* db.get(Person, id)).toBeNull();
          yield* db.command({ actor: "a", commandId: "seed" }, (tx) =>
            tx.put(Person, id, { name: "Ada" }, { validFrom: 0 }),
          );
          const triples = yield* Triples;
          const name = (yield* triples.history(id)).find((f) => f.attribute === Person.name.key)!;
          const changed = yield* db.preview(
            { actor: "a", commandId: "change" },
            (tx) => tx.correct(Person, name, { name: "Grace" }),
            { derivations: [definition] },
          );
          expect(changed.derivations[0]?.changed).toHaveLength(1);
          const removed = yield* db.preview(
            { actor: "a", commandId: "remove" },
            (tx) => tx.retract(Person, name),
            { derivations: [definition] },
          );
          expect(removed.derivations[0]?.removed).toHaveLength(1);
        }),
      ).pipe(Effect.provide(base)),
    );
  });

  it("keeps sensitive values sealed throughout preview JSON", async () => {
    const Secret = EntityType.make("Secret", {
      value: Attribute.use(Attribute.sensitive(Attribute.text(":secret/value")), {
        required: true,
      }),
    });
    const sensitive = Sensitive.layer({ database: "preview", attributes: [Secret] }).pipe(
      Layer.provide(ValueCodec.aesGcm.pipe(Layer.provide(KeyProvider.test({ seed: "preview" })))),
      Layer.provide(KvTriples.layer),
    );
    const store = ConfigStore.layer.pipe(Layer.provideMerge(sensitive));
    await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ConfigStore.ConfigStore;
        yield* config.commit({ label: "secret", ref: "live", objects: yield* Secret.nodes });
        yield* Effect.gen(function* () {
          const db = yield* Database.Database;
          const preview = yield* db.preview({ actor: "a", commandId: "secret" }, (tx) =>
            tx.put(Secret, id, { value: "DO-NOT-EXPOSE" }),
          );
          expect(JSON.stringify(preview)).not.toContain("DO-NOT-EXPOSE");
          expect(preview.operations.ops[0]).toMatchObject({ value: { type: "sealed" } });
          expect(preview.changes[0]?.value?.type).toBe("sealed");
          const definition = yield* Derivation.make({
            name: "secrets",
            configSnapshot: "preview",
            query: { find: ["?p"], where: [["?p", ":secret/value", "?v"]] },
            identity: ["?p"],
          });
          const derived = yield* db.preview(
            { actor: "a", commandId: "secret:derived" },
            (tx) => tx.put(Secret, id, { value: "DO-NOT-EXPOSE" }),
            { derivations: [definition] },
          );
          expect(JSON.stringify(derived)).not.toContain("DO-NOT-EXPOSE");
          expect(derived.derivations[0]?.added).toHaveLength(1);
        }).pipe(Effect.provide(Database.layer({ schema: { types: [Secret] } })));
      }).pipe(Effect.provide(store)),
    );
  });
});
