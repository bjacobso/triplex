import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import * as Database from "../../src/database/index.js";
import * as Attribute from "../../src/config/Attribute.js";
import * as EntityType from "../../src/config/EntityType.js";
import * as ConfigStore from "../../src/config/ConfigStore.js";
import * as GraphConstraint from "../../src/config/GraphConstraint.js";
import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import { EntityId } from "../../src/Branded.js";
import { Triples } from "../../src/store/Triples.js";
import { diagnose } from "../../src/errors/diagnostic.js";

const Person = EntityType.make("Person", {
  name: Attribute.text(":person/name").required(),
  tags: Attribute.text(":person/tag").many(),
});
const schema = { types: [Person] } as const;
const id = EntityId.make("person:1");
const base = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));
const client = Database.layer({ schema });
const run = (body: Effect.Effect<void, unknown, Triples | ConfigStore.ConfigStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(base)));
const publish = Effect.gen(function* () {
  const config = yield* ConfigStore.ConfigStore;
  return (yield* config.commit({ label: "v1", ref: "live", objects: yield* EntityType.nodesOf(Person) })).snapshot;
});

describe("Database compilation", () => {
  it("checks the local reference-target closure even when only the referring type is supplied", async () => {
    const Site = EntityType.make("Site", { name: Attribute.text(":site/name").required() });
    const Placement = EntityType.make("Placement", { site: Attribute.ref(":placement/site", Site).required() });
    const ChangedSite = EntityType.make("Site", {
      name: Attribute.text(":site/name").required(),
      code: Attribute.text(":site/code").required(),
    });
    await run(Effect.gen(function* () {
      const config = yield* ConfigStore.ConfigStore;
      yield* config.commit({ label: "changed target", ref: "live", objects: yield* EntityType.nodesOf(ChangedSite, Placement) });
      const acquisition = Effect.provide(Database.Database, Database.layer({ schema: { types: [Placement] } }));
      // The reference was declared against Site, not ChangedSite. Exact closure compatibility must reject this.
      const result = yield* Effect.result(acquisition);
      expect(result._tag).toBe("Failure");
    }));
  });

  it("fails acquisition for a missing ref or incompatible model, allows extra nodes", async () => {
    await run(Effect.gen(function* () {
      expect(diagnose(yield* Effect.flip(Effect.provide(Database.Database, client))).code).toBe("validation.failed");
      const config = yield* ConfigStore.ConfigStore;
      yield* config.commit({ label: "empty", ref: "live", objects: [] });
      expect(diagnose(yield* Effect.flip(Effect.provide(Database.Database, client))).code).toBe("validation.failed");
      yield* config.commit({ label: "extra", ref: "live", objects: [...(yield* EntityType.nodesOf(Person)), yield* Attribute.text(":extra/value").node] });
      yield* Effect.provide(Database.Database, client);
    }));
  });

  it("compiles put/create, entries, get, fact and temporal changes value for value", async () => {
    await run(Effect.gen(function* () {
      const release = yield* publish;
      const triples = yield* Triples;
      const config = yield* ConfigStore.ConfigStore;
      const transact = vi.spyOn(triples, "transact");
      const resolve = vi.spyOn(config, "resolveRef");
      yield* Effect.gen(function* () {
        const db = yield* Database.Database;
        expect(resolve).toHaveBeenCalledTimes(1);
        const meta = { actor: "user:a", commandId: "create:1", correlationId: "request:1" };
        const interval = { validFrom: 10, validTo: 100 };
        const values = { name: "Ada", tags: ["a", "b"] };
        const receipt = yield* db.command(meta, (tx) => Effect.gen(function* () {
          yield* tx.create(Person, id, values, interval);
          expect(yield* tx.get(Person, id, { validAt: 20 })).toBeNull();
          yield* tx.outbox.append({ scope: id, idempotencyKey: "send", payload: { ok: true } });
          yield* tx.inbox.append({ scope: id, idempotencyKey: "receive", payload: null });
        }));
        expect(transact.mock.calls[0]).toEqual([
          [...Person.assert(id, values, interval),
            { op: "append-entry", kind: "outbox", scope: id, idempotencyKey: "send", payload: { ok: true } },
            { op: "append-entry", kind: "inbox", scope: id, idempotencyKey: "receive", payload: null }],
          { ...meta, ...(yield* GraphConstraint.pinned(release)), preconditions: [{ _tag: "EntityAbsent", entityId: id }, { _tag: "EntityState", entityId: id, tripleIds: [] }] },
        ]);
        expect(receipt).toEqual(yield* triples.transactionByCommand(meta.commandId));
        const history = yield* triples.history(id);
        const facts = history.filter((f) => f.attribute === Person.tags.key);
        const name = history.find((f) => f.attribute === Person.name.key)!;
        const historySpy = vi.spyOn(triples, "history");
        const getSpy = vi.spyOn(triples, "get");
        const edits = [Person.replace(name, { name: "Grace" }, 40), Person.end(facts[0]!, 50), Person.correct(facts[1]!, { tags: "c" })];
        yield* db.command({ actor: "a", commandId: "edit" }, (tx) => Effect.gen(function* () {
          expect(yield* tx.fact(Person, name.id)).toEqual(name);
          yield* tx.get(Person, id, { validAt: 20 });
          yield* tx.get(Person, id, { validAt: 200 });
          yield* tx.replace(Person, name, { name: "Grace" }, 40);
          yield* tx.end(Person, facts[0]!, 50);
          yield* tx.correct(Person, facts[1]!, { tags: "c" });
        }));
        expect(historySpy).toHaveBeenCalledTimes(1);
        expect(getSpy).toHaveBeenCalledWith(name.id);
        expect(transact.mock.calls[1]).toEqual([edits.flatMap((e) => e.ops), {
          actor: "a", commandId: "edit", ...(yield* GraphConstraint.pinned(release)),
          preconditions: [{ _tag: "EntityState", entityId: id, tripleIds: history.filter((f) => Option.isNone(f.retractedAt)).map((f) => f.id) }, ...edits.flatMap((e) => e.preconditions)],
        }]);
        const before = resolve.mock.calls.length;
        const callback = vi.fn(() => Effect.void);
        expect(yield* db.command(meta, callback)).toEqual(receipt);
        expect(callback).not.toHaveBeenCalled();
        expect(resolve.mock.calls.length).toBe(before);
      }).pipe(Effect.provide(client));
    }));
  });

  it("compiles reads and projections and rejects unknown attributes before execution", async () => {
    await run(Effect.gen(function* () {
      yield* publish;
      const triples = yield* Triples;
      yield* triples.transact(Person.assert(id, { name: "Ada" }));
      const entity = vi.spyOn(triples, "entity");
      const page = vi.spyOn(triples, "entityPage");
      const query = vi.spyOn(triples, "query");
      const wrapped = vi.spyOn(triples, "queryPage");
      yield* Effect.gen(function* () {
        const db = yield* Database.Database;
        expect((yield* db.get(Person, id))?.values.name).toBe("Ada");
        expect(entity).toHaveBeenLastCalledWith(id, undefined);
        expect((yield* db.list(Person, { limit: 1 })).entities).toHaveLength(1);
        expect(page).toHaveBeenLastCalledWith({ entityType: "Person", limit: 1, cursor: undefined, basis: undefined });
        const q = { find: ["?n"], where: Person.where("?p", { name: "?n" }) } as const;
        const expected = { find: ["?n"], where: [["?p", ":person/name", "?n"]] };
        expect((yield* db.query(q, { decode: Schema.Struct({ "?n": Schema.String }), pageSize: 2 })).results).toEqual([{ "?n": "Ada" }]);
        expect(query).toHaveBeenLastCalledWith(expected, { pageSize: 2, cursor: undefined, basis: undefined });
        yield* db.raw(q, { debug: true });
        expect(query).toHaveBeenLastCalledWith(expected, { debug: true, cursor: undefined, basis: undefined });
        yield* db.rawPage({ inner: q, limit: 2 });
        expect(wrapped).toHaveBeenLastCalledWith({ inner: expected, limit: 2, cursor: undefined }, { basis: undefined });
        const calls = query.mock.calls.length;
        expect(diagnose(yield* Effect.flip(db.raw({ find: ["?n"], where: [["?p", ":person/naem", "?n"]] }))).code).toBe("schema.unknown-attribute");
        expect(query.mock.calls.length).toBe(calls);
        expect(diagnose(yield* Effect.flip(db.query(q, { decode: Schema.Struct({ "?n": Schema.Number }) }))).code).toBe("validation.failed");
        const head = yield* triples.currentPosition();
        const view = yield* db.asOf({ recordedPosition: head, validAt: Date.now() });
        yield* view.get(Person, id);
        expect(entity).toHaveBeenLastCalledWith(id, view.basis);
        expect((yield* db.asOf({ recordedAt: 0, validAt: 20 })).basis).toEqual({ recordedPosition: 0, validAt: 20 });
      }).pipe(Effect.provide(client));
    }));
  });
});
