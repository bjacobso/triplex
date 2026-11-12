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
import { Sensitive, ValueCodec, KeyProvider } from "../../src/sensitive/index.js";
import { Inbox, Outbox } from "../../src/operational/index.js";
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
  return (yield* config.commit({
    label: "v1",
    ref: "live",
    objects: yield* EntityType.nodesOf(Person),
  })).snapshot;
});

describe("Database compilation", () => {
  it("compiles receipts, typed history and mailbox reads to public operations", async () => {
    await run(
      Effect.gen(function* () {
        yield* publish;
        const triples = yield* Triples;
        yield* Effect.gen(function* () {
          const db = yield* Database.Database;
          expect(yield* db.receipt("missing")).toBeNull();
          const receipt = yield* db.command({ actor: "a", commandId: "readable" }, (tx) =>
            Effect.gen(function* () {
              yield* tx.put(Person, id, { name: "Ada", tags: ["a", "b"] }, { validFrom: 0 });
              yield* tx.outbox.append({ scope: id, idempotencyKey: "send", payload: { ok: true } });
              yield* tx.inbox.append({ scope: id, idempotencyKey: "receive", payload: null });
            }),
          );
          const lookup = vi.spyOn(triples, "transactionByCommand");
          expect(yield* db.receipt("readable")).toEqual(receipt);
          expect(lookup).toHaveBeenLastCalledWith("readable");
          const history = vi.spyOn(triples, "transactionsForEntity");
          const view = yield* db.asOf({ recordedPosition: receipt.position, validAt: 999 });
          const first = yield* db.history(Person, id, { limit: 1 });
          expect(history).toHaveBeenLastCalledWith(id, { limit: 1 });
          expect(first.transactions[0]).toMatchObject({
            ...receipt,
            typedChanges: expect.arrayContaining([
              {
                alias: "name",
                change: expect.objectContaining({ attribute: ":person/name" }),
                value: "Ada",
              },
            ]),
          });
          const out = db.outbox.id(id, "send");
          expect(out).toBe(Outbox.id(id, "send"));
          expect(db.inbox.id(id, "receive")).toBe(Inbox.id(id, "receive"));
          const get = vi.spyOn(triples, "operationalEntry");
          expect(yield* db.outbox.get(out)).toEqual(yield* Outbox.get(triples, out));
          expect(get).toHaveBeenLastCalledWith(out);
          expect(yield* db.inbox.get(out)).toBeNull();
          const pending = vi.spyOn(triples, "pendingOperationalEntries");
          const pendingOptions = { scope: id, limit: 1 };
          expect(yield* db.outbox.pending(pendingOptions)).toEqual(
            yield* Outbox.pending(triples, pendingOptions),
          );
          expect(pending).toHaveBeenLastCalledWith("outbox", pendingOptions);
          expect((yield* db.inbox.pending()).entries).toHaveLength(1);
          expect(pending).toHaveBeenLastCalledWith("inbox", {});
          const later = yield* db.command({ actor: "b", commandId: "later" }, (tx) =>
            Effect.gen(function* () {
              yield* tx.put(Person, id, { tags: ["c"] });
              yield* tx.outbox.acknowledge(out);
            }),
          );
          expect((yield* db.outbox.pending()).entries).toHaveLength(0);
          expect((yield* db.outbox.get(out))?.acknowledgedPosition).toBe(later.position);
          expect(yield* view.receipt("later")).toBeNull();
          expect(yield* view.receipt("readable")).toEqual(receipt);
          const past = yield* view.history(Person, id, { limit: 1 });
          expect(history).toHaveBeenLastCalledWith(id, {
            limit: 1,
            snapshotPosition: receipt.position,
          });
          expect(past.transactions.map((t) => t.txId)).toEqual([receipt.txId]);
          const newest = yield* db.history(Person, id, { limit: 1 });
          expect(newest.transactions[0]?.txId).toBe(later.txId);
          const older = yield* db.history(Person, id, {
            limit: 1,
            snapshotPosition: newest.snapshotPosition,
            beforePosition: newest.nextBeforePosition!,
          });
          expect(older.transactions[0]?.txId).toBe(receipt.txId);
          expect(
            yield* Effect.flip(view.history(Person, id, { snapshotPosition: later.position })),
          ).toMatchObject({ field: "history.snapshotPosition" });
        }).pipe(Effect.provide(client));
      }),
    );
  });

  it("keeps sealed history and receipts sealed and preserves unrelated changes in the envelope", async () => {
    const Secret = EntityType.make("Secret", {
      text: Attribute.sensitive(Attribute.text(":secret/text")),
    });
    const sensitive = Sensitive.layer({ database: "history", attributes: [Secret] }).pipe(
      Layer.provide(ValueCodec.aesGcm.pipe(Layer.provide(KeyProvider.test({ seed: "history" })))),
      Layer.provide(KvTriples.layer),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ConfigStore.ConfigStore;
        yield* config.commit({
          label: "secret",
          ref: "live",
          objects: [...(yield* Secret.nodes), ...(yield* Person.nodes)],
        });
        const triples = yield* Triples;
        yield* Effect.gen(function* () {
          const db = yield* Database.Database;
          const receipt = yield* db.command({ actor: "a", commandId: "secret" }, (tx) =>
            Effect.gen(function* () {
              yield* tx.put(Secret, id, { text: "PRIVATE" }, { validFrom: 0 });
              yield* tx.put(Person, EntityId.make("person:other"), { name: "Elsewhere" });
            }),
          );
          const history = yield* db.history(Secret, id);
          expect(history.transactions[0]?.changes).toEqual(receipt.changes);
          expect(history.transactions[0]?.typedChanges).toEqual([
            {
              alias: "text",
              change: expect.objectContaining({
                value: expect.objectContaining({
                  type: "sealed",
                  valueType: "string",
                  keyId: expect.any(String),
                  ciphertext: expect.any(String),
                }),
              }),
              value: { $sealed: { valueType: "string", keyId: expect.any(String) } },
            },
          ]);
          expect(JSON.stringify(history)).not.toContain("PRIVATE");
          expect(JSON.stringify(yield* db.receipt("secret"))).not.toContain("PRIVATE");
          const spy = vi.spyOn(triples, "transactionsForEntity");
          spy.mockImplementationOnce(() =>
            Effect.succeed({
              snapshotPosition: receipt.position,
              transactions: [
                {
                  ...receipt,
                  changes: [
                    ...receipt.changes,
                    {
                      ...receipt.changes[0]!,
                      entityId: id,
                      entityType: "Secret",
                      attribute: ":unknown/field",
                    },
                    { ...receipt.changes[0]!, entityId: id, entityType: "Other" },
                  ],
                },
              ],
            }),
          );
          expect((yield* db.history(Secret, id)).transactions[0]?.typedChanges).toHaveLength(1);
          spy.mockImplementationOnce(() =>
            Effect.succeed({
              snapshotPosition: receipt.position,
              transactions: [
                {
                  ...receipt,
                  changes: [
                    {
                      ...receipt.changes.find((c) => c.entityType === "Secret")!,
                      value: { type: "string", value: "PRIVATE" },
                    },
                  ],
                },
              ],
            }),
          );
          expect(yield* Effect.flip(db.history(Secret, id))).toMatchObject({
            field: "history.changes.value",
          });
        }).pipe(Effect.provide(Database.layer({ schema: { types: [Secret, Person] } })));
      }).pipe(Effect.provide(ConfigStore.layer.pipe(Layer.provideMerge(sensitive)))),
    );
  });

  it("tx.get loads two live assertions rather than 1,000 retracted assertions", async () => {
    await run(
      Effect.gen(function* () {
        yield* publish;
        const triples = yield* Triples;
        const input = {
          entityId: id,
          entityType: "Person",
          attribute: ":person/name",
          value: { type: "string" as const, value: "Ada" },
        };
        const history = yield* triples.assertBatch(Array.from({ length: 1000 }, () => input));
        yield* triples.transact(history.map((f) => ({ op: "retract" as const, id: f.id })));
        const live = yield* triples.assertBatch([
          { ...input, validFrom: 0, validTo: 1 },
          { ...input, validFrom: Date.now() + 1000000 },
        ]);
        const historySpy = vi.spyOn(triples, "history");
        const liveSpy = vi.spyOn(triples, "liveFacts");
        const transactSpy = vi.spyOn(triples, "transact");
        yield* Effect.gen(function* () {
          const db = yield* Database.Database;
          yield* db.command({ actor: "reader", commandId: "read-history" }, (tx) =>
            Effect.gen(function* () {
              expect(yield* tx.get(Person, id, { validAt: 2 })).toBeNull();
            }),
          );
        }).pipe(Effect.provide(client));
        expect(historySpy).not.toHaveBeenCalled();
        expect(liveSpy).toHaveBeenCalledExactlyOnceWith(id);
        expect(yield* liveSpy.mock.results[0]!.value).toHaveLength(2);
        expect(transactSpy.mock.calls[0]?.[1]?.preconditions).toEqual([
          {
            _tag: "EntityState",
            entityId: id,
            tripleIds: expect.arrayContaining(live.map((f) => f.id)),
          },
        ]);
      }),
    );
  });

  it("checks the local reference-target closure even when only the referring type is supplied", async () => {
    const Site = EntityType.make("Site", { name: Attribute.text(":site/name").required() });
    const Placement = EntityType.make("Placement", {
      site: Attribute.ref(":placement/site", Site).required(),
    });
    const ChangedSite = EntityType.make("Site", {
      name: Attribute.text(":site/name").required(),
      code: Attribute.text(":site/code").required(),
    });
    await run(
      Effect.gen(function* () {
        const config = yield* ConfigStore.ConfigStore;
        yield* config.commit({
          label: "changed target",
          ref: "live",
          objects: [...(yield* EntityType.nodesOf(ChangedSite)), ...(yield* Placement.nodes)],
        });
        const acquisition = Effect.provide(
          Database.Database,
          Database.layer({ schema: { types: [Placement] } }),
        );
        // The reference was declared against Site, not ChangedSite. Exact closure compatibility must reject this.
        const result = yield* Effect.result(acquisition);
        expect(result._tag).toBe("Failure");
      }),
    );
  });

  it("fails acquisition for a missing ref or incompatible model, allows extra nodes", async () => {
    await run(
      Effect.gen(function* () {
        expect(diagnose(yield* Effect.flip(Effect.provide(Database.Database, client))).code).toBe(
          "validation.failed",
        );
        const config = yield* ConfigStore.ConfigStore;
        yield* config.commit({ label: "empty", ref: "live", objects: [] });
        expect(diagnose(yield* Effect.flip(Effect.provide(Database.Database, client))).code).toBe(
          "validation.failed",
        );
        yield* config.commit({
          label: "extra",
          ref: "live",
          objects: [
            ...(yield* EntityType.nodesOf(Person)),
            yield* Attribute.text(":extra/value").node,
          ],
        });
        yield* Effect.provide(Database.Database, client);
      }),
    );
  });

  it("compiles put/create, entries, get, fact and temporal changes value for value", async () => {
    await run(
      Effect.gen(function* () {
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
          const receipt = yield* db.command(meta, (tx) =>
            Effect.gen(function* () {
              yield* tx.create(Person, id, values, interval);
              expect(yield* tx.get(Person, id, { validAt: 20 })).toBeNull();
              yield* tx.outbox.append({ scope: id, idempotencyKey: "send", payload: { ok: true } });
              yield* tx.inbox.append({ scope: id, idempotencyKey: "receive", payload: null });
            }),
          );
          expect(transact.mock.calls[0]).toStrictEqual([
            [
              ...Person.assert(id, values, interval),
              {
                op: "append-entry",
                kind: "outbox",
                scope: id,
                idempotencyKey: "send",
                payload: { ok: true },
              },
              {
                op: "append-entry",
                kind: "inbox",
                scope: id,
                idempotencyKey: "receive",
                payload: null,
              },
            ],
            {
              ...meta,
              ...(yield* GraphConstraint.pinned(release)),
              preconditions: [
                { _tag: "EntityAbsent", entityId: id },
                { _tag: "EntityState", entityId: id, tripleIds: [] },
              ],
            },
          ]);
          expect(receipt).toEqual(yield* triples.transactionByCommand(meta.commandId));
          const history = yield* triples.history(id);
          const facts = history.filter((f) => f.attribute === Person.tags.key);
          const name = history.find((f) => f.attribute === Person.name.key)!;
          const historySpy = vi.spyOn(triples, "history");
          const liveFactsSpy = vi.spyOn(triples, "liveFacts");
          const getSpy = vi.spyOn(triples, "get");
          const assertion = (fact: typeof name) => ({
            op: "assert" as const,
            entityId: id,
            entityType: "Person",
            attribute: fact.attribute,
            value: fact.value,
            validFrom: 10,
            validTo: 100,
          });
          const edits = [
            {
              ops: [
                { op: "retract", id: name.id },
                { ...assertion(name), validTo: 40 },
                { ...assertion(name), validFrom: 40, value: { type: "string", value: "Grace" } },
              ],
              preconditions: [{ _tag: "TripleLive", id: name.id }],
            },
            {
              ops: [
                { op: "retract", id: facts[0]!.id },
                { ...assertion(facts[0]!), validTo: 50 },
              ],
              preconditions: [{ _tag: "TripleLive", id: facts[0]!.id }],
            },
            {
              ops: [
                { op: "retract", id: facts[1]!.id },
                { ...assertion(facts[1]!), value: { type: "string", value: "c" } },
              ],
              preconditions: [{ _tag: "TripleLive", id: facts[1]!.id }],
            },
          ];
          yield* db.command({ actor: "a", commandId: "edit" }, (tx) =>
            Effect.gen(function* () {
              expect(yield* tx.fact(Person, name.id)).toEqual(name);
              yield* tx.get(Person, id, { validAt: 20 });
              yield* tx.get(Person, id, { validAt: 200 });
              yield* tx.replace(Person, name, { name: "Grace" }, 40);
              yield* tx.end(Person, facts[0]!, 50);
              yield* tx.correct(Person, facts[1]!, { tags: "c" });
            }),
          );
          expect(historySpy).not.toHaveBeenCalled();
          expect(liveFactsSpy).toHaveBeenCalledExactlyOnceWith(id);
          expect(getSpy).toHaveBeenCalledWith(name.id);
          expect(transact.mock.calls[1]).toStrictEqual([
            edits.flatMap((e) => e.ops),
            {
              actor: "a",
              commandId: "edit",
              ...(yield* GraphConstraint.pinned(release)),
              preconditions: [
                {
                  _tag: "EntityState",
                  entityId: id,
                  tripleIds: history.filter((f) => Option.isNone(f.retractedAt)).map((f) => f.id),
                },
                ...edits.flatMap((e) => e.preconditions),
              ],
            },
          ]);
          const before = resolve.mock.calls.length;
          const callback = vi.fn(() => Effect.void);
          expect(yield* db.command(meta, callback)).toEqual(receipt);
          expect(callback).not.toHaveBeenCalled();
          expect(resolve.mock.calls.length).toBe(before);
        }).pipe(Effect.provide(client));
      }),
    );
  });

  it("compiles reads and projections and rejects unknown attributes before execution", async () => {
    await run(
      Effect.gen(function* () {
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
          expect(page).toHaveBeenLastCalledWith({ entityType: "Person", limit: 1 });
          const q = { find: ["?n"], where: Person.where("?p", { name: "?n" }) } as const;
          const expected = { find: ["?n"], where: [["?p", ":person/name", "?n"]] };
          expect(
            (yield* db.query(q, { decode: Schema.Struct({ "?n": Schema.String }), pageSize: 2 }))
              .results,
          ).toEqual([{ "?n": "Ada" }]);
          expect(query).toHaveBeenLastCalledWith(expected, { pageSize: 2 });
          yield* db.raw(q, { debug: true });
          expect(query).toHaveBeenLastCalledWith(expected, { debug: true });
          yield* db.rawPage({ inner: q, limit: 2 });
          expect(wrapped).toHaveBeenLastCalledWith({ inner: expected, limit: 2 }, {});
          const calls = query.mock.calls.length;
          expect(
            diagnose(
              yield* Effect.flip(db.raw({ find: ["?n"], where: [["?p", ":person/naem", "?n"]] })),
            ).code,
          ).toBe("schema.unknown-attribute");
          expect(query.mock.calls.length).toBe(calls);
          expect(
            diagnose(
              yield* Effect.flip(db.query(q, { decode: Schema.Struct({ "?n": Schema.Number }) })),
            ).code,
          ).toBe("validation.failed");
          const head = yield* triples.currentPosition();
          const view = yield* db.asOf({ recordedPosition: head, validAt: Date.now() });
          yield* view.get(Person, id);
          expect(entity).toHaveBeenLastCalledWith(id, view.basis);
          expect((yield* db.asOf({ recordedAt: 0, validAt: 20 })).basis).toEqual({
            recordedPosition: 0,
            validAt: 20,
          });
        }).pipe(Effect.provide(client));
      }),
    );
  });
});
