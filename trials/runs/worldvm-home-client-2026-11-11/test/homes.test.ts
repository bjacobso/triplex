import { afterEach, describe, expect, test, vi } from "vitest";
import { Effect, Exit, Layer, Schema } from "effect";
import { EntityId, Triples, type TransactionRecord } from "@triplex-build/triplex";
import * as Database from "@triplex-build/triplex/database";
import { Outbox } from "@triplex-build/triplex/operational";
import { Sensitive, ValueCodec } from "@triplex-build/triplex/sensitive";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Home, audit, createHome, fixtures, homeId, keys, keySubject, openWorld, principal, readHome, updateHome, type Backend } from "../src/model.js";

const statusFact = (receipt: TransactionRecord, validAt = 0) => {
  const change = receipt.changes.find(c => c.op === "assert" && c.attribute === ":home/status"
    && (c.validFrom ?? 0) <= validAt && (c.validTo === undefined || validAt < c.validTo));
  if (!change) throw new Error("Missing status assertion");
  return change.tripleId;
};
const failureTag = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  return JSON.stringify(exit);
};
afterEach(() => vi.restoreAllMocks());

for (const backend of ["kv", "sqlite"] as const) describe(backend, () => {
  test("Q1 (BRIEF): own homes, isolated worlds with identical subject IDs, host authorization on reads and commands", async () => {
    const a = openWorld("world:a", backend), b = openWorld("world:b", backend);
    try {
      const pa = principal("world:a"), pb = principal("world:b");
      await a.runPromise(createHome(pa.world, pa, "alice", "create-alice", "a-ready"));
      await a.runPromise(createHome(pa.world, pa, "bob", "create-bob", "b-ready"));
      expect(await b.runPromise(readHome(pb.world, pb, "alice"))).toBeNull();
      await b.runPromise(createHome(pb.world, pb, "alice", "create-alice", "world-b-ready"));
      expect((await a.runPromise(readHome(pa.world, pa, "alice")))?.values.status).toBe("a-ready");
      expect((await a.runPromise(readHome(pa.world, pa, "bob")))?.values.status).toBe("b-ready");
      expect((await b.runPromise(readHome(pb.world, pb, "alice")))?.values.status).toBe("world-b-ready");
      expect(homeId("alice")).not.toBe(homeId("bob"));
      const restricted = { ...pa, subjects: ["alice"] as const };
      expect(failureTag(await a.runPromiseExit(readHome(pa.world, restricted, "bob")))).toContain("HostDenied");
      expect(failureTag(await a.runPromiseExit(createHome(pa.world, restricted, "bob", "denied")))).toContain("HostDenied");
      expect(failureTag(await a.runPromiseExit(readHome(pa.world, pb, "alice")))).toContain("HostDenied");
      expect(failureTag(await a.runPromiseExit(createHome(pa.world, pb, "alice", "wrong-world")))).toContain("HostDenied");
      const list = await a.runPromise(Effect.gen(function* () { return yield* (yield* Database.Database).list(Home); }));
      expect(list.entities.map(e => e.entityId).sort()).toEqual([homeId("alice"), homeId("bob")].sort());
    } finally { await a.dispose(); await b.dispose(); }
  });

  test("Q2 (BRIEF): atomic facts, queryable receipt and attributed intent; callback and commit failures leave none", async () => {
    const world = "world:atomic", r = openWorld(world, backend), p = principal(world);
    try {
      const receipt = await r.runPromise(createHome(world, p, "alice", "success"));
      const together = await r.runPromise(audit("alice", "success"));
      expect(together.home?.values.status).toBe("ready");
      expect(together.receipt).toEqual(receipt);
      expect(receipt).toMatchObject({ actor: p.actor, commandId: "success", correlationId: "request:success" });
      expect(receipt.configSnapshot).toBeTruthy();
      expect(receipt.changes.every(c => c.entityId === homeId("alice"))).toBe(true);
      expect(together.intent).toMatchObject({ txId: receipt.txId, recordedPosition: receipt.position, scope: homeId("alice") });
      expect(together.intent?.acknowledgedPosition).toBeUndefined();
      for (const kind of ["callback", "constraint"] as const) {
        const commandId = `failed-${kind}`;
        const result = await r.runPromiseExit(Effect.gen(function* () {
          const db = yield* Database.Database;
          return yield* db.command({ actor: p.actor, commandId }, tx => Effect.gen(function* () {
            yield* tx.create(Home, homeId("bob"), { subject: fixtures.bob.subject, status: "ready", secret: fixtures.bob.secret, archive: fixtures.bob.archive }, { validFrom: 0 });
            yield* tx.outbox.append({ scope: homeId("bob"), idempotencyKey: `${commandId}:refresh`, payload: { command: "refresh" } });
            if (kind === "callback") yield* Effect.fail("forced-domain-failure");
            else yield* tx.put(Home, homeId("bob"), { status: "contradictory" }, { validFrom: 0 });
          }));
        }));
        expect(failureTag(result)).toContain(kind === "callback" ? "forced-domain-failure" : "ConstraintViolationError");
        expect(await r.runPromise(audit("bob", commandId))).toEqual({ home: null, receipt: null, intent: null });
        const history = await r.runPromise(Effect.gen(function* () { return yield* (yield* Triples).history(homeId("bob")); }));
        expect(history).toEqual([]);
      }
    } finally { await r.dispose(); }
  });

  test("Q3 (BRIEF): duplicate IDs skip changed payload; 16 competing identical submissions have one effect and intent", async () => {
    const world = "world:dedup", r = openWorld(world, backend), p = principal(world);
    try {
      const receipts = await r.runPromise(Effect.all(Array.from({ length: 16 }, () => createHome(world, p, "alice", "same-command")), { concurrency: "unbounded" }));
      expect(new Set(receipts.map(x => x.txId)).size).toBe(1);
      let callbacks = 0;
      const duplicate = await r.runPromise(Effect.gen(function* () {
        const db = yield* Database.Database;
        return yield* db.command({ actor: "different-actor", commandId: "same-command" }, () => Effect.sync(() => { callbacks++; throw new Error("must not run changed payload"); }));
      }));
      expect(callbacks).toBe(0);
      expect(duplicate).toEqual(receipts[0]);
      const state = await r.runPromise(Effect.gen(function* () {
        const triples = yield* Triples;
        return { journal: yield* triples.transactions(), intents: yield* Outbox.pending(triples), facts: yield* triples.history(homeId("alice")) };
      }));
      expect(state.journal.transactions.filter(t => t.commandId === "same-command")).toHaveLength(1);
      expect(state.intents.entries).toHaveLength(1);
      expect(state.facts.filter(f => f.attribute === ":home/status")).toHaveLength(1);
    } finally { await r.dispose(); }
  });

  test("Q3 (BRIEF): synchronized competing updates reject stale observation; reload and same-ID retry commits once", async () => {
    const world = "world:race", r = openWorld(world, backend), p = principal(world);
    try {
      const initial = await r.runPromise(createHome(world, p, "alice", "initial"));
      let arrivals = 0;
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      const gate = Effect.promise(() => { if (++arrivals === 2) release(); return ready; });
      const attempts = await r.runPromise(Effect.all(["runner-a", "runner-b"].map(id => Effect.exit(updateHome(world, p, "alice", id, statusFact(initial), id, gate))), { concurrency: "unbounded" }));
      expect(attempts.filter(Exit.isSuccess)).toHaveLength(1);
      expect(attempts.filter(Exit.isFailure)).toHaveLength(1);
      expect(failureTag(attempts.find(Exit.isFailure)!)).toContain("TransactionConflictError");
      const winner = attempts.find(Exit.isSuccess)!;
      if (!Exit.isSuccess(winner)) throw new Error("no winner");
      const loserId = attempts[0]._tag === "Failure" ? "runner-a" : "runner-b";
      const absent = await r.runPromise(audit("alice", loserId));
      expect(absent.receipt).toBeNull(); expect(absent.intent).toBeNull();
      const retried = await r.runPromise(updateHome(world, p, "alice", loserId, statusFact(winner.value), "reconciled"));
      expect(retried.position).toBeGreaterThan(winner.value.position);
      const duplicate = await r.runPromise(updateHome(world, p, "alice", loserId, statusFact(initial), "must-not-apply"));
      expect(duplicate).toEqual(retried);
      const final = await r.runPromise(audit("alice", loserId));
      expect(final.home?.values.status).toBe("reconciled");
      const pending = await r.runPromise(Effect.gen(function* () { return yield* Outbox.pending(yield* Triples); }));
      expect(pending.entries).toHaveLength(3); // initial, winner, reloaded loser
    } finally { await r.dispose(); }
  });

  test("Q4 (BRIEF): saved exact position excludes same-millisecond updates and later corrections", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const world = "world:replay", r = openWorld(world, backend), p = principal(world);
    try {
      const first = await r.runPromise(createHome(world, p, "alice", "first"));
      const second = await r.runPromise(updateHome(world, p, "alice", "second", statusFact(first), "updated", Effect.void, 10));
      const third = await r.runPromise(updateHome(world, p, "alice", "correction", statusFact(second, 20), "corrected"));
      expect(first.instant).toBe(second.instant);
      expect(second.instant).toBe(third.instant);
      expect(first.position).toBeLessThan(second.position);
      const cuts = await r.runPromise(Effect.gen(function* () {
        const db = yield* Database.Database;
        const old = yield* db.asOf({ recordedPosition: first.position, validAt: 20 });
        const middle = yield* db.asOf({ recordedPosition: second.position, validAt: 20 });
        const current = yield* db.asOf({ recordedPosition: third.position, validAt: 20 });
        const timestamp = yield* db.asOf({ recordedAt: first.instant, validAt: 20 });
        const past = yield* db.asOf({ recordedPosition: third.position, validAt: 5 });
        return { old: yield* old.get(Home, homeId("alice")), middle: yield* middle.get(Home, homeId("alice")),
          current: yield* current.get(Home, homeId("alice")), timestamp: yield* timestamp.get(Home, homeId("alice")), past: yield* past.get(Home, homeId("alice")) };
      }));
      expect(cuts.old?.values.status).toBe("ready");
      expect(cuts.middle?.values.status).toBe("updated");
      expect(cuts.current?.values.status).toBe("corrected");
      expect(cuts.timestamp?.values.status).toBe("corrected"); // timestamp cut cannot distinguish equal instants
      expect(cuts.past?.values.status).toBe("ready");
    } finally { await r.dispose(); }
  });

  test("Q5 (BRIEF): sealed facts and journal, safe ordinary query, explicit open and wrong vault/retention rejection", async () => {
    const world = "world:sealed", r = openWorld(world, backend), p = principal(world);
    try {
      await r.runPromise(createHome(world, p, "alice", "sealed"));
      const data = await r.runPromise(Effect.gen(function* () {
        const db = yield* Database.Database, triples = yield* Triples;
        return { facts: yield* triples.entity(homeId("alice")), journal: yield* triples.transactions(),
          typed: yield* db.get(Home, homeId("alice")), ordinary: yield* db.query({ find: ["?status"], where: Home.where(homeId("alice"), { status: "?status" }) }, { decode: Schema.Struct({ "?status": Schema.String }) }) };
      }));
      for (const secret of [fixtures.alice.secret, fixtures.alice.archive]) expect(JSON.stringify(data)).not.toContain(secret);
      const sealed = data.facts.filter(f => [":home/secret", ":home/archive"].includes(f.attribute));
      expect(sealed).toHaveLength(2);
      expect(sealed.every(f => f.value.type === "sealed")).toBe(true);
      expect(data.ordinary.results).toEqual([{ "?status": "ready" }]);
      const opened = await r.runPromise(Sensitive.open(sealed));
      expect(opened.map(f => f.value)).toEqual(expect.arrayContaining([{ type: "string", value: fixtures.alice.secret }, { type: "string", value: fixtures.alice.archive }]));
      for (const domain of ["other-vault", "other-retention"]) {
        const wrongCodec = ValueCodec.aesGcmWith({ subjectOf: ctx => {
          const tuple = JSON.parse(keySubject(ctx)) as string[];
          tuple[domain === "other-vault" ? 0 : 1] = domain;
          return JSON.stringify(tuple);
        } }).pipe(Layer.provide(keys));
        const openingLayer = Layer.effect(Sensitive.Sensitivity, Effect.gen(function* () {
          return Sensitive.makeSensitivity({ database: world, attributes: Sensitive.attributesOf([Home]), codec: yield* ValueCodec.ValueCodec });
        })).pipe(Layer.provide(wrongCodec));
        const result = await Effect.runPromiseExit(Sensitive.open(sealed).pipe(Effect.provide(openingLayer)));
        expect(failureTag(result)).toContain("SensitiveValueError");
      }
      const forbiddenProjection = await r.runPromiseExit(Effect.gen(function* () {
        return yield* (yield* Database.Database).raw({ find: ["?secret"], where: Home.where("?home", { secret: "?secret" }) });
      }));
      expect(failureTag(forbiddenProjection)).toContain("SensitiveQueryError");
    } finally { await r.dispose(); }
  });

  test("Q6 (BRIEF): new worker discovers pending intents; reads do not claim; acknowledgment remains host-owned", async () => {
    const world = "world:worker", r = openWorld(world, backend), p = principal(world);
    try {
      const receipt = await r.runPromise(createHome(world, p, "alice", "pending"));
      const worker = () => r.runPromise(Effect.gen(function* () { return yield* Outbox.pending(yield* Triples, { scope: homeId("alice") }); }));
      const before = await worker(); // discard worker; next invocation has no local cursor/state
      const after = await worker();
      expect(after).toEqual(before);
      expect(after.entries).toHaveLength(1);
      expect(after.entries[0].txId).toBe(receipt.txId);
      expect(after.entries[0].acknowledgedTxId).toBeUndefined();
      // Synthetic external destination could deduplicate by entry.id; we claim no exactly-once delivery.
      await r.runPromise(Effect.gen(function* () {
        const db = yield* Database.Database;
        yield* db.command({ actor: "worker:synthetic", commandId: "ack-pending" }, tx => tx.outbox.acknowledge(after.entries[0].id));
      }));
      expect((await worker()).entries).toEqual([]);
      const retained = await r.runPromise(Effect.gen(function* () { return yield* Outbox.get(yield* Triples, after.entries[0].id); }));
      expect(retained?.txId).toBe(receipt.txId);
      expect(retained?.acknowledgedTxId).toBeTruthy();
    } finally { await r.dispose(); }
  });
});

test("Q5/Q6 (BRIEF), SQLite: close and reopen database; raw files lack plaintext; fresh process-lifetime worker discovers intent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "triplex-home-trial-"));
  const filename = join(directory, "world.sqlite"), world = "world:durable", p = principal(world);
  let r = openWorld(world, "sqlite", filename);
  try {
    const receipt = await r.runPromise(createHome(world, p, "alice", "durable"));
    await r.dispose();
    for (const file of readdirSync(directory)) {
      const bytes = readFileSync(join(directory, file));
      expect(bytes.includes(Buffer.from(fixtures.alice.secret))).toBe(false);
      expect(bytes.includes(Buffer.from(fixtures.alice.archive))).toBe(false);
    }
    r = openWorld(world, "sqlite", filename);
    const recovered = await r.runPromise(audit("alice", "durable"));
    expect(recovered.receipt).toEqual(receipt);
    expect(recovered.home?.values.status).toBe("ready");
    const pending = await r.runPromise(Effect.gen(function* () { return yield* Outbox.pending(yield* Triples); }));
    expect(pending.entries).toHaveLength(1);
    expect(pending.entries[0].txId).toBe(receipt.txId);
  } finally { await r.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test.skip("Q2/Q3 (BRIEF), PostgreSQL: serializable and ambient host-row rollback UNTESTED — no configured/reachable service", () => {});
