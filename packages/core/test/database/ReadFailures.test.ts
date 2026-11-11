import { Effect, Layer, Option } from "effect";
import { expect, it, vi } from "vitest";
import * as Database from "../../src/database/index.js";
import * as Attribute from "../../src/config/Attribute.js";
import * as EntityType from "../../src/config/EntityType.js";
import * as ConfigStore from "../../src/config/ConfigStore.js";
import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import { EntityId, TripleId } from "../../src/Branded.js";
import { Triples } from "../../src/store/Triples.js";
import { diagnose } from "../../src/errors/diagnostic.js";
import { Sensitive, ValueCodec } from "../../src/sensitive/index.js";

const Item = EntityType.make("Item", { name: Attribute.text(":item/name").required() });
const schema = { types: [Item] };
const id = EntityId.make("item:1");
const base = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));
const publish = Effect.gen(function* () {
  return (yield* (yield* ConfigStore.ConfigStore).commit({
    label: "v1",
    objects: yield* EntityType.nodesOf(Item),
    ref: "live",
  })).snapshot;
});
const client = Database.layer({ schema });

it("checks raw queries against their captured release even if live moves during resolution", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const release = yield* publish;
      const config = yield* ConfigStore.ConfigStore;
      const original = config.resolveRef;
      yield* Effect.gen(function* () {
        const db = yield* Database.Database;
        const resolve = vi.spyOn(config, "resolveRef").mockImplementationOnce(() =>
          Effect.gen(function* () {
            yield* config.commit({ label: "empty", objects: [], ref: "live" });
            return release;
          }),
        );
        expect(
          (yield* db.raw({ find: ["?name"], where: [["?e", Item.name.key, "?name"]] })).results,
        ).toEqual([]);
        expect(resolve).toHaveBeenCalledTimes(1);
        resolve.mockRestore();
        expect(yield* original("live")).not.toEqual(release);
      }).pipe(Effect.provide(client));
    }).pipe(Effect.provide(base)),
  );
});

it("normalizes entity and projection decode failures and preserves local causes without diagnostic values", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* publish;
      const triples = yield* Triples;
      yield* triples.transact([
        {
          op: "assert",
          entityId: id,
          entityType: Item.entityType,
          attribute: Item.name.key,
          value: { type: "number", value: 123456789 },
        },
      ]);
      yield* Effect.gen(function* () {
        const db = yield* Database.Database;
        expect(yield* db.get(Item, EntityId.make("missing"))).toBeNull();
        const error = yield* Effect.flip(db.get(Item, id));
        expect(error).toHaveProperty("cause._tag", "EntityDecodeError");
        expect(diagnose(error)).toMatchObject({
          code: "validation.failed",
          path: "entity.values",
          retryable: false,
        });
        expect(JSON.stringify(diagnose(error))).not.toContain("123456789");
        expect(
          diagnose(
            yield* Effect.flip(
              db.command({ actor: "a", commandId: "missing-fact" }, (tx) =>
                tx.fact(Item, TripleId.make("00000000000000000000000000")).pipe(Effect.asVoid),
              ),
            ),
          ).code,
        ).toBe("triple.not-found");
        for (const basis of [
          { recordedAt: NaN },
          { recordedAt: -1 },
          { validAt: Infinity },
          { recordedPosition: 0.5 },
        ])
          expect(diagnose(yield* Effect.flip(db.asOf(basis))).code).toBe("validation.failed");
      }).pipe(Effect.provide(client));
    }).pipe(Effect.provide(base)),
  );
});

it("normalizes a timestamp with bounded journal pages through the captured head and freezes view time", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const release = yield* publish;
      const triples = yield* Triples;
      const one = yield* triples.transact(Item.assert(id, { name: "old" }, { validFrom: 0 }));
      const history = vi.spyOn(triples, "transactions");
      const head = vi.spyOn(triples, "currentPosition");
      yield* Effect.gen(function* () {
        const db = yield* Database.Database;
        const view = yield* db.asOf({ recordedPosition: one.position, validAt: 10 });
        expect(history).not.toHaveBeenCalled();
        expect(head).toHaveBeenCalledTimes(1);
        expect(view.releaseId).toBe(release.id);
        const change = Item.correct(one.triples[0]!, { name: "new" });
        yield* triples.transact(change.ops, change);
        expect((yield* view.get(Item, id))?.values.name).toBe("old");
        const at = yield* db.asOf({ recordedAt: one.instant, validAt: 10 });
        const journal = yield* triples.transactions({ limit: 1000 });
        const expected = Math.max(
          0,
          ...journal.transactions
            .filter((tx) => tx.instant <= one.instant)
            .map((tx) => tx.position),
        );
        expect(at.basis).toEqual({ recordedPosition: expected, validAt: 10 });
        expect(history.mock.calls[0]).toEqual([{ after: 0, limit: 1000 }]);
        expect(Object.isFrozen(view.basis)).toBe(true);
      }).pipe(Effect.provide(client));
    }).pipe(Effect.provide(base)),
  );
});

it("does not cross database scopes, local models, operation kinds or changed queries with a cursor", async () => {
  const first = await Effect.runPromise(
    Effect.gen(function* () {
      yield* publish;
      const triples = yield* Triples;
      yield* triples.transact([
        ...Item.assert(id, { name: "a" }),
        ...Item.assert(EntityId.make("item:2"), { name: "b" }),
      ]);
      return yield* Effect.gen(function* () {
        return yield* (yield* Database.Database).list(Item, { limit: 1 });
      }).pipe(Effect.provide(client));
    }).pipe(
      Effect.provide(
        ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layerWithScope("source"))),
      ),
    ),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* publish;
      yield* Effect.gen(function* () {
        const db = yield* Database.Database;
        expect(
          diagnose(yield* Effect.flip(db.list(Item, { cursor: first.nextCursor! }))).code,
        ).toBe("pagination.invalid-cursor");
      }).pipe(Effect.provide(client));
    }).pipe(
      Effect.provide(
        ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layerWithScope("destination"))),
      ),
    ),
  );
});

it("keeps sealed values opaque and compiles same-transaction sealed past reuse exactly", async () => {
  const Secret = EntityType.make("Secret", {
    text: Attribute.sensitive(Attribute.text(":secret/text")),
  });
  const sensitive = Sensitive.layer({ database: "database-test", attributes: [Secret] }).pipe(
    Layer.provide(ValueCodec.identity),
    Layer.provide(KvTriples.layer),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* ConfigStore.ConfigStore;
      const triples = yield* Triples;
      const release = (yield* config.commit({
        label: "secret",
        objects: yield* EntityType.nodesOf(Secret),
        ref: "live",
      })).snapshot;
      const fact = (yield* triples.transact(
        Secret.assert(id, { text: "private" }, { validFrom: 10 }),
      )).triples[0]!;
      const transact = vi.spyOn(triples, "transact");
      yield* Effect.gen(function* () {
        const db = yield* Database.Database;
        const old = yield* db.asOf({ validAt: 15 });
        expect((yield* old.get(Secret, id))?.values.text).toMatchObject({
          $sealed: { valueType: "string" },
        });
        const expected = Secret.replace(fact, { text: "replacement" }, 20);
        yield* db.command({ actor: "a", commandId: "sealed" }, (tx) =>
          tx.replace(Secret, fact, { text: "replacement" }, 20),
        );
        expect(transact.mock.calls[0]?.[0]).toEqual(expected.ops);
        expect(transact.mock.calls[0]?.[1]?.preconditions).toEqual(expected.preconditions);
        expect(transact.mock.calls[0]?.[1]?.configSnapshot).toBe(release.id);
        const past = yield* triples.entity(id, { validAt: 15 });
        expect(past[0]!.value).toEqual(fact.value);
        const present = yield* triples.entity(id, { validAt: 25 });
        expect(present[0]!.value.type).toBe("sealed");
        expect(Option.isNone(present[0]!.validTo)).toBe(true);
        const bad = yield* Effect.flip(
          db.raw({ find: ["?value"], where: [["?e", Secret.text.key, "?value"]] }),
        );
        expect(diagnose(bad).code).toBe("sensitive.query");
      }).pipe(Effect.provide(Database.layer({ schema: { types: [Secret] } })));
    }).pipe(Effect.provide(ConfigStore.layer.pipe(Layer.provideMerge(sensitive)))),
  );
});

it("captures an exact position between same-millisecond commits and resolves timestamp ties to their greatest position", async () => {
  const { DeterministicTripleStoreRuntimeLive } =
    await import("../../src/store/TripleStoreRuntime.js");
  const { InMemoryKvBackendLive } = await import("../../src/kv/kv/InMemoryKvBackend.js");
  const deterministic = ConfigStore.layer.pipe(
    Layer.provideMerge(
      KvTriples.layerBackend.pipe(
        Layer.provide(InMemoryKvBackendLive),
        Layer.provide(DeterministicTripleStoreRuntimeLive({ now: 1000, idSeed: "database-time" })),
      ),
    ),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* publish;
      const triples = yield* Triples;
      const first = yield* triples.transact(Item.assert(id, { name: "old" }, { validFrom: 0 }));
      yield* Effect.gen(function* () {
        const db = yield* Database.Database;
        const view = yield* db.asOf({ validAt: 10 });
        const change = Item.correct(first.triples[0]!, { name: "new" });
        const second = yield* triples.transact(change.ops, change);
        expect(second.instant).toBe(first.instant);
        expect((yield* view.get(Item, id))?.values.name).toBe("old");
        const then = yield* db.asOf({ recordedAt: 1000, validAt: 10 });
        expect(then.basis).toEqual({ recordedPosition: second.position, validAt: 10 });
        expect((yield* then.get(Item, id))?.values.name).toBe("new");
      }).pipe(Effect.provide(client));
    }).pipe(Effect.provide(deterministic)),
  );
});
