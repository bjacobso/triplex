import { Effect, Layer, Schema } from "effect";
import { expect, it, vi } from "vitest";
import { EntityId, Triples } from "@triplex-build/triplex";
import { Attribute, ConfigStore, EntityType, GraphConstraint } from "@triplex-build/triplex/config";
import * as Database from "@triplex-build/triplex/database";
import { diagnose } from "@triplex-build/triplex";
import { Inbox, Outbox } from "@triplex-build/triplex/operational";

const Site = EntityType.make("Site", { name: Attribute.text(":site/name").required() });
const Worker = EntityType.make("Worker", {
  name: Attribute.text(":worker/name").required(),
  trainedFor: Attribute.ref(":worker/trained-for", Site).many(),
});
const Placement = EntityType.make("Placement", {
  worker: Attribute.ref(":placement/worker", Worker).required(),
  site: Attribute.ref(":placement/site", Site).required(),
});
const schema = { types: [Placement] };
const maria = EntityId.make("worker:maria");
const harbor = EntityId.make("site:harbor");
const placement = EntityId.make("placement:maria-harbor");
const MAR_2 = Date.UTC(2026, 2, 2);
const meta = {
  actor: "user:dana",
  commandId: `create:${placement}`,
  correlationId: "request:7f3a",
};

// Shared public-service behavior cases; reusable by the PostgreSQL service gate.
export const databaseBehavior = (backend: Layer.Layer<Triples, unknown>) => {
  const store = ConfigStore.layer.pipe(Layer.provideMerge(backend));
  const run = (body: Effect.Effect<void, unknown, Triples | ConfigStore.ConfigStore>) =>
    Effect.runPromise(body.pipe(Effect.provide(store)));
  const publish = Effect.gen(function* () {
    const config = yield* ConfigStore.ConfigStore;
    return (yield* config.commit({
      label: "safety-v1",
      objects: yield* EntityType.nodesOf(Placement),
      ref: "live",
    })).snapshot;
  });
  const client = Database.layer({ schema });

  it("compiles the site-safety command to the existing primitive command and recovers its receipt", async () => {
    await run(
      Effect.gen(function* () {
        const release = yield* publish;
        const triples = yield* Triples;
        yield* triples.transact([
          ...Site.assert(harbor, { name: "Harbor" }, { validFrom: MAR_2 }),
          ...Worker.assert(maria, { name: "Maria" }, { validFrom: MAR_2 }),
        ]);
        const ops = Placement.assert(
          placement,
          { worker: maria, site: harbor },
          { validFrom: MAR_2 },
        );
        const pin = yield* GraphConstraint.pinned(release);
        // Exact command region from docs/snippets/home/site-safety/app.ts.
        const original = yield* triples.transact(ops, { ...meta, ...pin });
        const receipt = yield* triples.transaction(original.txId);
        yield* Effect.gen(function* () {
          const db = yield* Database.Database;
          const build = vi.fn((tx: Database.Command) =>
            tx.put(Placement, placement, { worker: maria, site: harbor }, { validFrom: MAR_2 }),
          );
          expect(yield* db.command(meta, build)).toEqual(receipt);
          expect(build).not.toHaveBeenCalled();
          const query = vi.spyOn(triples, "query");
          const untrained = {
            find: ["?w"],
            where: [
              ...Worker.where("?w", { name: "?name" }),
              Worker.not("?w", { trainedFor: harbor }),
            ],
          } as const;
          expect(
            (yield* db.query(untrained, { decode: Schema.Struct({ "?w": Schema.String }) }))
              .results,
          ).toEqual([{ "?w": maria }]);
          expect(query.mock.calls.at(-1)).toStrictEqual([
            {
              find: ["?w"],
              where: [
                ["?w", ":worker/name", "?name"],
                ["not", ["?w", ":worker/trained-for", { type: "ref", value: harbor }]],
              ],
            },
            {},
          ]);
          yield* db.raw({
            find: ["?p"],
            where: Placement.where("?p", { worker: maria, site: harbor }),
          });
          expect(query.mock.calls.at(-1)).toStrictEqual([
            {
              find: ["?p"],
              where: [
                ["?p", ":placement/worker", { type: "ref", value: maria }],
                ["?p", ":placement/site", { type: "ref", value: harbor }],
              ],
            },
            {},
          ]);
          const nextPlacement = EntityId.make("placement:second");
          const transact = vi.spyOn(triples, "transact");
          const next = yield* db.command({ ...meta, commandId: "second" }, (tx) =>
            tx.put(Placement, nextPlacement, { worker: maria, site: harbor }, { validFrom: MAR_2 }),
          );
          expect(transact.mock.calls[0]).toEqual([
            Placement.assert(nextPlacement, { worker: maria, site: harbor }, { validFrom: MAR_2 }),
            { ...meta, commandId: "second", ...pin, preconditions: [] },
          ]);
          expect(next).toEqual(yield* triples.transactionByCommand("second"));
          expect((yield* db.get(Placement, nextPlacement))?.values).toEqual({
            worker: maria,
            site: harbor,
          });
          expect(
            (yield* triples.entity(placement, { validAt: MAR_2 }))
              .map((f) => ({ attribute: f.attribute, value: f.value, validFrom: f.validFrom }))
              .sort((a, b) => a.attribute.localeCompare(b.attribute)),
          ).toEqual(
            original.triples
              .map((f) => ({ attribute: f.attribute, value: f.value, validFrom: f.validFrom }))
              .sort((a, b) => a.attribute.localeCompare(b.attribute)),
          );
        }).pipe(Effect.provide(client));
      }),
    );
  });

  it("rolls back facts, entries, acknowledgements and receipts on constraint rejection", async () => {
    await run(
      Effect.gen(function* () {
        yield* publish;
        const triples = yield* Triples;
        yield* triples.transact([
          {
            op: "append-entry",
            kind: "inbox",
            scope: placement,
            idempotencyKey: "in",
            payload: {},
          },
        ]);
        const head = yield* triples.currentPosition();
        yield* Effect.gen(function* () {
          const db = yield* Database.Database;
          const error = yield* Effect.flip(
            db.command({ actor: "a", commandId: "invalid" }, (tx) =>
              Effect.gen(function* () {
                yield* tx.put(Placement, placement, { site: harbor }, { validFrom: MAR_2 });
                yield* tx.outbox.append({
                  scope: placement,
                  idempotencyKey: "out",
                  payload: { deliver: true },
                });
                yield* tx.inbox.acknowledge(Inbox.id(placement, "in"));
              }),
            ),
          );
          expect(diagnose(error).code).toBe("constraint.violation");
          expect(yield* triples.history(placement)).toEqual([]);
          expect(yield* triples.operationalEntry(Outbox.id(placement, "out"))).toBeNull();
          expect(
            (yield* triples.operationalEntry(Inbox.id(placement, "in")))?.acknowledgedPosition,
          ).toBeUndefined();
          expect(yield* triples.transactionByCommand("invalid")).toBeNull();
          expect(yield* triples.currentPosition()).toBe(head);
        }).pipe(Effect.provide(client));
      }),
    );
  });

  it("guards complete persisted observations including future facts and insertion-only races", async () => {
    await run(
      Effect.gen(function* () {
        yield* publish;
        const triples = yield* Triples;
        yield* triples.transact([
          ...Site.assert(harbor, { name: "Harbor" }, { validFrom: 0 }),
          ...Worker.assert(maria, { name: "Maria" }, { validFrom: 0 }),
          ...Worker.assert(maria, { trainedFor: [harbor] }, { validFrom: Date.now() + 100000 }),
        ]);
        const history = yield* triples.history(maria);
        const transact = vi.spyOn(triples, "transact");
        yield* Effect.gen(function* () {
          const db = yield* Database.Database;
          yield* db.command({ actor: "a", commandId: "observe" }, (tx) =>
            Effect.gen(function* () {
              const read = yield* tx.get(Worker, maria, { validAt: 10 });
              expect(read?.values.trainedFor).toEqual([]);
              yield* tx.get(Worker, maria, { validAt: Date.now() + 200000 });
            }),
          );
          expect(transact.mock.calls.at(-1)?.[1]?.preconditions).toEqual([
            { _tag: "EntityState", entityId: maria, tripleIds: history.map((f) => f.id) },
          ]);
          const error = yield* Effect.flip(
            db.command({ actor: "a", commandId: "racy" }, (tx) =>
              Effect.gen(function* () {
                yield* tx.get(Worker, maria);
                yield* triples.transact(
                  Worker.assert(maria, { trainedFor: [harbor] }, { validFrom: 10, validTo: 20 }),
                );
                yield* tx.outbox.append({ scope: maria, idempotencyKey: "race", payload: null });
              }),
            ),
          );
          expect(diagnose(error).code).toBe("transaction.conflict.precondition");
          expect(yield* triples.transactionByCommand("racy")).toBeNull();
          expect(yield* triples.operationalEntry(Outbox.id(maria, "race"))).toBeNull();
          const fact = history.find((f) => f.attribute === Worker.name.key)!;
          const change = Worker.correct(fact, { name: "M" });
          yield* triples.transact(change.ops, change);
          expect(
            diagnose(
              yield* Effect.flip(
                db.command({ actor: "a", commandId: "stale" }, (tx) =>
                  tx.correct(Worker, fact, { name: "old" }),
                ),
              ),
            ).code,
          ).toBe("transaction.conflict.precondition");
        }).pipe(Effect.provide(client));
      }),
    );
  });

  it("pins pages and views across writes, corrections and incompatible ref changes", async () => {
    await run(
      Effect.gen(function* () {
        const release = yield* publish;
        const triples = yield* Triples;
        const config = yield* ConfigStore.ConfigStore;
        yield* triples.transact([
          ...Worker.assert(maria, { name: "Maria" }, { validFrom: 0 }),
          ...Worker.assert(EntityId.make("worker:zoe"), { name: "Zoe" }, { validFrom: 0 }),
        ]);
        const entityPage = vi.spyOn(triples, "entityPage");
        yield* Effect.gen(function* () {
          const db = yield* Database.Database;
          const first = yield* db.list(Worker, { limit: 1 });
          const query = { find: ["?name"], where: Worker.where("?w", { name: "?name" }) } as const;
          const projection = Schema.Struct({ "?name": Schema.String });
          const q1 = yield* db.query(query, { decode: projection, pageSize: 1 });
          const r1 = yield* db.raw(query, { pageSize: 1 });
          expect(
            diagnose(
              yield* Effect.flip(
                db.raw({ ...query, find: ["?w", "?name"] }, { cursor: r1.nextCursor! }),
              ),
            ).code,
          ).toBe("pagination.invalid-cursor");
          const w1 = yield* db.rawPage({ inner: query, limit: 1, includeCount: true });
          expect(w1.totalCount).toBe(2);
          const view = yield* db.asOf({ validAt: 10 });
          const wrongBasis = yield* db.asOf({ validAt: 11 });
          const old = yield* view.get(Worker, maria);
          const fact = (yield* triples.history(maria))[0]!;
          const change = Worker.correct(fact, { name: "Changed" });
          yield* triples.transact(change.ops, change);
          expect(yield* view.get(Worker, maria)).toEqual(old);
          const timestamp = yield* db.asOf({ recordedAt: 0, validAt: 10 });
          expect(yield* timestamp.get(Worker, maria)).toBeNull();
          const position = yield* db.asOf({
            recordedPosition: first.snapshot.recordedPosition,
            validAt: 10,
          });
          expect(yield* position.get(Worker, maria)).toEqual(old);
          expect(
            diagnose(yield* Effect.flip(db.asOf({ recordedPosition: Number.MAX_SAFE_INTEGER })))
              .code,
          ).toBe("validation.failed");
          expect(
            diagnose(yield* Effect.flip(db.asOf({ recordedAt: 0, recordedPosition: 0 }))).path,
          ).toBe("basis.recordedAt");
          yield* config.commit({ label: "incompatible", objects: [], ref: "live" });
          const byId = vi.spyOn(config, "snapshotById");
          const second = yield* db.list(Worker, { limit: 1, cursor: first.nextCursor! });
          expect(second.entities.map((e) => e.values.name)).toEqual(["Zoe"]);
          expect(second.snapshot).toEqual(first.snapshot);
          expect(byId).toHaveBeenCalledWith(release.id);
          const inner = JSON.parse(decodeURIComponent(first.nextCursor!)).inner;
          expect(entityPage.mock.calls.at(-1)?.[0].cursor).toBe(inner);
          expect(
            (yield* db.query(query, { decode: projection, cursor: q1.nextCursor!, pageSize: 1 }))
              .results,
          ).toEqual([{ "?name": "Zoe" }]);
          expect((yield* db.raw(query, { cursor: r1.nextCursor!, pageSize: 1 })).results).toEqual([
            { "?name": "Zoe" },
          ]);
          expect(
            (yield* db.rawPage({
              inner: query,
              cursor: w1.nextCursor!,
              limit: 1,
              includeCount: true,
            })).results,
          ).toEqual([{ "?name": "Zoe" }]);
          expect(diagnose(yield* Effect.flip(db.raw(query, { cursor: q1.nextCursor! }))).code).toBe(
            "pagination.invalid-cursor",
          );
          expect(
            diagnose(yield* Effect.flip(view.list(Worker, { cursor: r1.nextCursor! }))).code,
          ).toBe("pagination.invalid-cursor");
          expect(diagnose(yield* Effect.flip(db.list(Worker, { cursor: "broken" }))).code).toBe(
            "pagination.invalid-cursor",
          );
          const altered = JSON.parse(decodeURIComponent(first.nextCursor!));
          altered.model = "different";
          expect(
            diagnose(
              yield* Effect.flip(
                db.list(Worker, { cursor: encodeURIComponent(JSON.stringify(altered)) }),
              ),
            ).code,
          ).toBe("pagination.invalid-cursor");
          expect(
            diagnose(yield* Effect.flip(wrongBasis.list(Worker, { cursor: first.nextCursor! })))
              .code,
          ).toBe("pagination.invalid-cursor");
        }).pipe(Effect.provide(client));
      }),
    );
  });
};
