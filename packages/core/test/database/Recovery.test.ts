import { Effect, Fiber, Layer, Option } from "effect";
import { expect, it, vi } from "vitest";
import * as Database from "../../src/database/index.js";
import * as Attribute from "../../src/config/Attribute.js";
import * as EntityType from "../../src/config/EntityType.js";
import * as ConfigStore from "../../src/config/ConfigStore.js";
import * as GraphConstraint from "../../src/config/GraphConstraint.js";
import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import { EntityId } from "../../src/Branded.js";
import { Triples } from "../../src/store/Triples.js";
import { CommandAlreadyCommittedError, ReadError } from "../../src/errors/index.js";
import { diagnose } from "../../src/errors/diagnostic.js";
import { Inbox, Outbox } from "../../src/operational/index.js";

const Item = EntityType.make("Item", {
  name: Attribute.text(":item/name").required(),
  tags: Attribute.text(":item/tag").many(),
});
const id = EntityId.make("item:1");
const client = Database.layer({ schema: { types: [Item] } });
const run = (body: Effect.Effect<void, unknown, Triples | ConfigStore.ConfigStore>) =>
  Effect.runPromise(
    body.pipe(Effect.provide(ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer)))),
  );
const publish = Effect.gen(function* () {
  const store = yield* ConfigStore.ConfigStore;
  return (yield* store.commit({
    label: "v1",
    objects: yield* EntityType.nodesOf(Item),
    ref: "live",
  })).snapshot;
});

it("recovers a concurrent command claim loser and uncertain receipt responses", async () => {
  await run(
    Effect.gen(function* () {
      yield* publish;
      const triples = yield* Triples;
      yield* Effect.gen(function* () {
        const db = yield* Database.Database;
        const winner = yield* db.command({ actor: "winner", commandId: "race" }, (tx) =>
          tx.put(Item, id, { name: "a" }),
        );
        const lookup = vi
          .spyOn(triples, "transactionByCommand")
          .mockImplementationOnce(() => Effect.succeed(null));
        const transact = vi.spyOn(triples, "transact").mockImplementationOnce(() =>
          Effect.fail(
            new CommandAlreadyCommittedError({
              commandId: "race",
              transactionId: winner.txId,
              message: "already committed",
            }),
          ),
        );
        expect(yield* db.command({ actor: "loser", commandId: "race" }, () => Effect.void)).toEqual(
          winner,
        );
        expect(lookup).toHaveBeenCalledTimes(2);
        transact.mockRestore();
        lookup.mockRestore();
        vi.spyOn(triples, "transaction").mockImplementationOnce(() =>
          Effect.fail(new ReadError({ message: "lost response" })),
        );
        expect(
          diagnose(
            yield* Effect.flip(
              db.command({ actor: "a", commandId: "uncertain" }, (tx) =>
                tx.put(Item, EntityId.make("item:2"), { name: "b" }),
              ),
            ),
          ).code,
        ).toBe("read.failed");
        const callback = vi.fn(() => Effect.void);
        const recovered = yield* db.command({ actor: "a", commandId: "uncertain" }, callback);
        expect(recovered).toEqual(yield* triples.transactionByCommand("uncertain"));
        expect(callback).not.toHaveBeenCalled();
        vi.spyOn(triples, "transaction").mockImplementationOnce(() => Effect.succeed(null));
        expect(
          diagnose(
            yield* Effect.flip(db.command({ actor: "a", commandId: "missing" }, () => Effect.void)),
          ).code,
        ).toBe("read.failed");
      }).pipe(Effect.provide(client));
    }),
  );
});

it("admits commands under one release and checks again on the next call", async () => {
  await run(
    Effect.gen(function* () {
      const release = yield* publish;
      const config = yield* ConfigStore.ConfigStore;
      const triples = yield* Triples;
      const moved = (yield* config.commit({
        label: "changed",
        objects: [
          ...(yield* EntityType.nodesOf(Item)),
          yield* GraphConstraint.required("Item", Item.tags.key).node,
        ],
      })).snapshot;
      const transact = vi.spyOn(triples, "transact");
      yield* Effect.gen(function* () {
        const db = yield* Database.Database;
        const receipt = yield* db.command({ actor: "a", commandId: "admission" }, (tx) =>
          Effect.gen(function* () {
            yield* config.setRef("live", moved.id);
            yield* tx.put(Item, id, { name: "a" });
          }),
        );
        expect(receipt.configSnapshot).toBe(release.id);
        expect(transact.mock.calls.at(-1)?.[1]).toEqual({
          actor: "a",
          commandId: "admission",
          ...(yield* GraphConstraint.pinned(release)),
          preconditions: [],
        });
        expect(
          diagnose(
            yield* Effect.flip(
              db.command({ actor: "a", commandId: "enforced-extra" }, (tx) =>
                tx.put(Item, EntityId.make("item:2"), { name: "b" }),
              ),
            ),
          ).code,
        ).toBe("constraint.violation");
        // A declaration mismatch is different from an extra host constraint.
        const Wrong = EntityType.make("Item", { name: Attribute.number(":item/name").required() });
        yield* config.commit({
          label: "wrong",
          objects: yield* EntityType.nodesOf(Wrong),
          ref: "live",
        });
        expect(diagnose(yield* Effect.flip(db.get(Item, id))).code).toBe("validation.failed");
        expect(
          yield* db.command({ actor: "other", commandId: "admission" }, () =>
            Effect.die("must not run"),
          ),
        ).toEqual(receipt);
      }).pipe(Effect.provide(client));
    }),
  );
});

it("rejects invalid builds, preserves domain errors and invalidates escaped builders", async () => {
  await run(
    Effect.gen(function* () {
      yield* publish;
      const triples = yield* Triples;
      const fact = (yield* triples.transact(
        Item.assert(id, { name: "a" }, { validFrom: 10, validTo: 100 }),
      )).triples[0]!;
      const transact = vi.spyOn(triples, "transact");
      yield* Effect.gen(function* () {
        const db = yield* Database.Database;
        const bad: ReadonlyArray<
          (tx: Database.Command) => Effect.Effect<void, Database.DatabaseError>
        > = [
          (tx) => tx.put(Item, id, {}),
          (tx) => tx.put(Item, id, { name: "a" }, { validFrom: 20, validTo: 10 }),
          (tx) => tx.replace(Item, fact, { name: "b" }, 10),
          (tx) => tx.correct(Item, { ...fact, entityType: Option.some("Other") }, { name: "b" }),
          (tx) =>
            tx.put(EntityType.make("Other", { name: Attribute.text(":other/name") }), id, {
              name: "x",
            }),
          (tx) =>
            Effect.gen(function* () {
              yield* tx.end(Item, fact, 20);
              yield* tx.retract(Item, fact);
            }),
        ];
        for (const [index, build] of bad.entries())
          expect(
            diagnose(
              yield* Effect.flip(db.command({ actor: "a", commandId: `bad:${index}` }, build)),
            ).code,
          ).toBe("validation.failed");
        expect(transact).not.toHaveBeenCalled();
        const domain = { reason: "host business error" };
        expect(
          yield* Effect.flip(
            db.command({ actor: "a", commandId: "domain" }, () => Effect.fail(domain)),
          ),
        ).toBe(domain);
        expect(transact).not.toHaveBeenCalled();
        let escaped: Database.Command | undefined;
        yield* db.command({ actor: "a", commandId: "lifetime" }, (tx) =>
          Effect.sync(() => {
            escaped = tx;
          }),
        );
        expect(diagnose(yield* Effect.flip(escaped!.put(Item, id, { name: "b" }))).path).toBe(
          "command.builder",
        );
        const parallel = yield* Effect.flip(
          db.command({ actor: "a", commandId: "parallel" }, (tx) =>
            Effect.gen(function* () {
              const fiber = yield* tx.put(Item, id, { name: "b" }).pipe(Effect.forkChild);
              yield* Fiber.join(fiber);
            }),
          ),
        );
        expect(diagnose(parallel).path).toBe("command.builder");
        expect(transact).toHaveBeenCalledTimes(1);
      }).pipe(Effect.provide(client));
    }),
  );
});

it("compiles omitted intervals, retracts and both entry acknowledgements exactly", async () => {
  await run(
    Effect.gen(function* () {
      const release = yield* publish;
      const triples = yield* Triples;
      const transact = vi.spyOn(triples, "transact");
      yield* Effect.gen(function* () {
        const db = yield* Database.Database;
        const meta = { actor: "a", commandId: "entries", causationId: "upstream" };
        yield* db.command(meta, (tx) =>
          Effect.gen(function* () {
            yield* tx.put(Item, id, { name: "a", tags: ["one"] });
            yield* tx.inbox.append({ scope: id, idempotencyKey: "in", payload: {} });
            yield* tx.outbox.append({ scope: id, idempotencyKey: "out", payload: {} });
          }),
        );
        expect(transact.mock.calls[0]).toEqual([
          [
            ...Item.assert(id, { name: "a", tags: ["one"] }),
            { op: "append-entry", kind: "inbox", scope: id, idempotencyKey: "in", payload: {} },
            { op: "append-entry", kind: "outbox", scope: id, idempotencyKey: "out", payload: {} },
          ],
          { ...meta, ...(yield* GraphConstraint.pinned(release)), preconditions: [] },
        ]);
        const tag = (yield* triples.history(id)).find((f) => f.attribute === Item.tags.key)!;
        yield* db.command({ actor: "a", commandId: "ack" }, (tx) =>
          Effect.gen(function* () {
            yield* tx.retract(Item, tag);
            yield* tx.inbox.acknowledge(Inbox.id(id, "in"));
            yield* tx.outbox.acknowledge(Outbox.id(id, "out"));
          }),
        );
        expect(transact.mock.calls[1]).toEqual([
          [
            { op: "retract", id: tag.id },
            { op: "acknowledge-entry", kind: "inbox", id: Inbox.id(id, "in") },
            { op: "acknowledge-entry", kind: "outbox", id: Outbox.id(id, "out") },
          ],
          {
            actor: "a",
            commandId: "ack",
            ...(yield* GraphConstraint.pinned(release)),
            preconditions: [{ _tag: "TripleLive", id: tag.id }],
          },
        ]);
      }).pipe(Effect.provide(client));
    }),
  );
});

it("orders lookup, admission, callback, one submit and receipt read, and rejects metadata before IO", async () => {
  await run(
    Effect.gen(function* () {
      yield* publish;
      const triples = yield* Triples;
      const config = yield* ConfigStore.ConfigStore;
      yield* Effect.gen(function* () {
        const db = yield* Database.Database;
        const calls: string[] = [];
        const lookup = triples.transactionByCommand;
        const resolve = config.resolveRef;
        const transact = triples.transact;
        const receipt = triples.transaction;
        vi.spyOn(triples, "transactionByCommand").mockImplementation((id) =>
          Effect.suspend(() => {
            calls.push("lookup");
            return lookup(id);
          }),
        );
        vi.spyOn(config, "resolveRef").mockImplementation((ref) =>
          Effect.suspend(() => {
            calls.push("resolve");
            return resolve(ref);
          }),
        );
        vi.spyOn(triples, "transact").mockImplementation((ops, meta) =>
          Effect.suspend(() => {
            calls.push("transact");
            return transact(ops, meta);
          }),
        );
        vi.spyOn(triples, "transaction").mockImplementation((id) =>
          Effect.suspend(() => {
            calls.push("receipt");
            return receipt(id);
          }),
        );
        for (const meta of [
          { actor: "", commandId: "x" },
          { actor: "a", commandId: "" },
        ])
          expect(diagnose(yield* Effect.flip(db.command(meta, () => Effect.void))).code).toBe(
            "validation.failed",
          );
        expect(calls).toEqual([]);
        yield* db.command({ actor: "a", commandId: "ordered" }, (tx) =>
          Effect.gen(function* () {
            calls.push("build");
            yield* tx.put(Item, id, { name: "a" });
          }),
        );
        expect(calls).toEqual(["lookup", "resolve", "build", "transact", "receipt"]);
        calls.length = 0;
        yield* db.command({ actor: "a", commandId: "ordered" }, () => Effect.die("must not build"));
        expect(calls).toEqual(["lookup"]);
      }).pipe(Effect.provide(client));
    }),
  );
});
