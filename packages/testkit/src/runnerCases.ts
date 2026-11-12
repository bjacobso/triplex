/** Durable runner corpus. The caller supplies a fresh persistent Triples layer and TestClock. */
import { Clock, Deferred, Effect, Fiber, Layer, Option, type Scope } from "effect";
import { TestClock } from "effect/testing";
import {
  EntityId,
  Triples,
  string,
  type TransactOp,
  type TriplesService,
} from "@triplex-internal/core";
import * as Derivation from "@triplex-internal/core/derivation";
import * as Runner from "@triplex-internal/core/runner";
import { DatabaseScope } from "@triplex-internal/core/runtime";
import { Attribute, EntityType, ConfigStore } from "@triplex-internal/core/config";
import * as Database from "@triplex-internal/core/database";
import { Outbox, ConsumerCheckpoint } from "@triplex-internal/core/operational";

const check = (condition: unknown, message: string) =>
  condition ? Effect.void : Effect.fail(new Error(message));
const equal = (a: unknown, b: unknown, message: string) =>
  check(
    JSON.stringify(a) === JSON.stringify(b),
    `${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`,
  );
const op = (
  id: string,
  value = id,
  attribute = ":runner-test/value",
): Extract<TransactOp, { op: "assert" }> => ({
  op: "assert",
  entityId: EntityId.make(id),
  attribute,
  value: string(value),
  validFrom: 0,
});
const definition = (name = "test", pin = "test", attribute = ":runner-test/value") =>
  Derivation.make({
    name,
    configSnapshot: pin,
    identity: ["?e"],
    query: { find: ["?e", "?v"], where: [["?e", attribute, "?v"]] },
  });
const options = (id = "test") => ({
  scope: DatabaseScope.test(`runner-corpus:${id}`),
  id,
  idleCheckMs: 1,
  retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1, random: () => 1 },
});
/**
 * Wait until the runner status satisfies `predicate`. Backend I/O is awaited in real time
 * (bounded at 30 s). The injected clock moves only when the runner is provably waiting on
 * it: to reach a scheduled retry, or by one idle-check tick when commits it has not scanned
 * (or a due deadline) sit unchanged across several real-time waits. Slow backends therefore
 * cannot drift the clock past the valid-time boundaries a case asserts on.
 */
export const settleRunner = <E>(
  h: Runner.Handle<E>,
  predicate: (s: Runner.RunnerStatus) => boolean,
): Effect.Effect<void, Runner.RunnerError | E, Triples> =>
  Effect.gen(function* () {
    const t = yield* Triples;
    const live = TestClock.withLive(Clock.currentTimeMillis);
    const deadline = (yield* live) + 30_000;
    let previous = "";
    let unchanged = 0;
    while ((yield* live) < deadline) {
      const status = yield* h.status;
      if (predicate(status)) return;
      yield* Effect.raceFirst(Effect.yieldNow, h.await);
      const fingerprint = JSON.stringify(status);
      unchanged = fingerprint === previous ? unchanged + 1 : 0;
      previous = fingerprint;
      const now = yield* Clock.currentTimeMillis;
      const retryAt = status.registrations
        .map((r) => (r.pending && !r.pending.paused ? r.pending.retryAt : null))
        .filter((at): at is number => at !== null && at > now);
      if (retryAt.length > 0 && unchanged >= 5) {
        yield* TestClock.setTime(Math.min(...retryAt));
        continue;
      }
      const head = yield* t
        .currentPosition()
        .pipe(
          Effect.mapError(
            (error) => new Runner.RunnerError({ code: "Store", message: error.message }),
          ),
        );
      const due = status.registrations.some(
        (r) => r.nextDeadline !== null && r.nextDeadline <= now,
      );
      if ((head > status.scannedPosition || due) && unchanged >= 5) {
        yield* TestClock.adjust(1);
        unchanged = 0;
        continue;
      }
      yield* TestClock.withLive(Effect.sleep(1));
    }
    return yield* Effect.fail(
      new Runner.RunnerError({ code: "Store", message: "Runner did not settle" }),
    );
  });
const caught = <E>(h: Runner.Handle<E>, position: number) =>
  Effect.gen(function* () {
    yield* settleRunner(
      h,
      (s) =>
        s.deliveredPosition >= position &&
        s.registrations.every((r) => r.deliveredPosition >= position && r.pending === null),
    );
    const t = yield* Triples;
    const persisted = yield* ConsumerCheckpoint.get(t, (yield* h.status).consumer);
    yield* check(
      (persisted?.position ?? 0) >= position,
      "committed consumer checkpoint covers acknowledged effects",
    );
  });
const launch = (d: Derivation.Definition, deliveries: Runner.Delivery[], id = "test") =>
  Runner.start(
    [
      {
        key: "work",
        definition: d,
        onDiff: (b) =>
          Effect.sync(() => {
            deliveries.push(b);
          }),
      },
    ],
    options(id),
  );
const effects = {
  "1 bootstrap, exact same-millisecond cuts, stable identities and all diff variants": Effect.gen(
    function* () {
      const t = yield* Triples;
      yield* TestClock.setTime(10);
      const d = yield* definition();
      const batches: Runner.Delivery[] = [];
      const h = yield* launch(d, batches);
      yield* caught(h, 0);
      const first = yield* t.transact([op("a", "one")]);
      const second = yield* t.transact([
        { op: "retract", id: first.triples[0]!.id },
        op("a", "two"),
      ]);
      const third = yield* t.transact([{ op: "retract", id: second.triples[0]!.id }]);
      yield* caught(h, third.position);
      yield* equal(
        batches.map((b) => b.position),
        [first.position, second.position, third.position],
        "every exact source cut",
      );
      yield* equal(
        batches.map((b) => [b.diff.added.length, b.diff.changed.length, b.diff.removed.length]),
        [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        "diff variants",
      );
      yield* equal(
        batches[0]!.diff.added[0]!.id,
        batches[1]!.diff.changed[0]!.after.id,
        "logical candidate survives revision",
      );
      const before = batches.length;
      const irrelevant = yield* t.transact([op("b", "other", ":other/value")]);
      yield* caught(h, irrelevant.position);
      yield* equal(batches.length, before, "unchanged callback omitted");
      yield* h.stop;
      const nonempty: Runner.Delivery[] = [];
      yield* t.transact([op("nonempty")]);
      const h2 = yield* launch(d, nonempty, "nonempty");
      yield* settleRunner(h2, () => nonempty.length === 1);
      yield* equal(nonempty[0]!.reason, "initial", "nonempty bootstrap");
    },
  ),
  "2 crash at durable protocol boundaries preserves the pinned payload": Effect.gen(function* () {
    const t = yield* Triples;
    yield* TestClock.setTime(10);
    yield* t.transact([op("a")]);
    const d = yield* definition();
    for (const boundary of [
      "prepared",
      "materialized",
      "ready",
      "handler",
      "success",
      "head",
      "checkpoint",
    ] as const) {
      const hit = Deferred.makeUnsafe<void>();
      let armed = true;
      const intercepted: TriplesService = {
        ...t,
        transact: (ops, meta) => {
          const body = ops.find(
            (o) => o.op === "assert" && o.attribute === ":runner/body" && o.value.type === "string",
          );
          const value =
            body?.op === "assert" && body.value.type === "string"
              ? (JSON.parse(body.value.value) as {
                  pending?: { phase: string; attempt: number };
                  runId?: string;
                  completed?: number;
                })
              : undefined;
          const at =
            boundary === "prepared"
              ? value?.pending?.phase === "prepared"
              : boundary === "materialized"
                ? meta?.actor === "triplex/derivation-materializer"
                : boundary === "ready"
                  ? value?.pending?.phase === "ready" && value.pending.attempt === 0
                  : boundary === "success"
                    ? ops.some((o) => o.op === "acknowledge-entry")
                    : boundary === "head"
                      ? value?.pending === null && !!value.runId
                      : boundary === "checkpoint"
                        ? ops.some(
                            (o) =>
                              o.op === "assert" &&
                              o.attribute === ":triplex/consumer-checkpoint-position",
                          )
                        : false;
          if (armed && at) {
            armed = false;
            return (boundary === "success" ? Effect.void : t.transact(ops, meta)).pipe(
              Effect.andThen(Deferred.succeed(hit, undefined)),
              Effect.andThen(Effect.never),
            );
          }
          return t.transact(ops, meta);
        },
      };
      const observed: Runner.Delivery[] = [];
      const registration = {
        key: "work",
        definition: d,
        onDiff: (b: Runner.Delivery) =>
          Effect.gen(function* () {
            observed.push(b);
            if (armed && boundary === "handler") {
              armed = false;
              yield* Deferred.succeed(hit, undefined);
              yield* Effect.never;
            }
          }),
      };
      const id = `crash-${boundary}`;
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Runner.start([registration], options(id));
            yield* Effect.never;
          }).pipe(Effect.provideService(Triples, intercepted)),
        ),
      );
      yield* Deferred.await(hit);
      yield* Fiber.interrupt(fiber);
      const recovered: Runner.Delivery[] = [];
      const h = yield* launch(d, recovered, id);
      yield* caught(h, 1);
      if (observed.length && recovered.length) {
        yield* equal(observed[0]!.batchId, recovered[0]!.batchId, "stable retry batch");
        yield* equal(
          observed[0]!.commandId("added", observed[0]!.diff.added[0]!.id),
          recovered[0]!.commandId("added", recovered[0]!.diff.added[0]!.id),
          "stable host command",
        );
      }
      yield* check(observed.length + recovered.length >= 1, "no lost delivery");
      yield* h.stop;
    }
  }),
  "3 partial Database.command effects and application outbox intents deduplicate on redelivery":
    Effect.gen(function* () {
      const t = yield* Triples;
      yield* TestClock.setTime(10);
      yield* t.transact([op("a"), op("b")]);
      const d = yield* definition();
      let attempts = 0;
      const Outcome = EntityType.make("RunnerTestOutcome", {
        status: Attribute.text(":effect/status").required(),
      });
      const config = yield* ConfigStore.ConfigStore;
      yield* config.commit({ objects: yield* Outcome.nodes, ref: "live", label: "runner-effects" });
      yield* Effect.gen(function* () {
        const db = yield* Database.Database;
        const h = yield* Runner.start(
          [
            {
              key: "work",
              definition: d,
              onDiff: (b) =>
                Effect.gen(function* () {
                  attempts++;
                  for (const [i, c] of b.diff.added.entries()) {
                    const commandId = b.commandId("added", c.id);
                    yield* db.command({ actor: "test/handler", commandId }, (tx) =>
                      Effect.gen(function* () {
                        yield* tx.create(
                          Outcome,
                          EntityId.make(`effect:${c.id}`),
                          { status: "open" },
                          { validFrom: 0 },
                        );
                        yield* tx.outbox.append({
                          scope: EntityId.make("application"),
                          idempotencyKey: commandId,
                          payload: { candidate: c.id },
                        });
                      }),
                    );
                    if (attempts === 1 && i === 0) return yield* Effect.fail("partial");
                  }
                }),
            },
          ],
          options(),
        );
        yield* caught(h, 1);
        yield* equal(attempts, 2, "whole batch retry");
        yield* equal(
          (yield* t.match({ attribute: ":effect/status" })).length,
          2,
          "no duplicate occurrences",
        );
        const entries = (yield* Outbox.pending(t, { scope: EntityId.make("application") })).entries;
        yield* equal(entries.length, 2, "deduplicated intents");
        const entry = entries[0]!;
        const conflict = yield* Effect.result(
          t.transact([
            Outbox.append({
              scope: entry.scope,
              idempotencyKey: entry.idempotencyKey,
              payload: { different: true },
            }),
          ]),
        );
        yield* check(conflict._tag === "Failure", "payload conflict rejected");
      }).pipe(Effect.provide(Database.layer({ schema: { types: [Outcome] } })));
    }).pipe(Effect.provide(ConfigStore.layer)),
  "4 manual materialization cannot replace acknowledged reconciliation base": Effect.gen(
    function* () {
      const t = yield* Triples;
      yield* TestClock.setTime(10);
      const source = yield* t.transact([op("a")]);
      const d = yield* definition();
      const batches: Runner.Delivery[] = [];
      const h = yield* launch(d, batches);
      yield* caught(h, source.position);
      yield* h.stop;
      const removed = yield* t.transact([{ op: "retract", id: source.triples[0]!.id }]);
      yield* Derivation.Materialization.materialize(t, d, {
        basis: { recordedPosition: removed.position, validAt: 10 },
      });
      const restarted = yield* launch(d, batches);
      yield* caught(restarted, removed.position);
      yield* equal(batches.length, 2, "pending removal delivered");
      yield* equal(batches[1]!.diff.removed.length, 1, "old explanation retained");
    },
  ),
  "5 poison pauses durably, other registrations progress, retry resumes identical batch":
    Effect.gen(function* () {
      const t = yield* Triples;
      yield* TestClock.setTime(10);
      const tx = yield* t.transact([op("a")]);
      const d = yield* definition();
      const ids: string[] = [];
      const healthy: Runner.Delivery[] = [];
      const reg = {
        key: "bad",
        definition: d,
        onDiff: (b: Runner.Delivery) => {
          ids.push(b.batchId);
          return Effect.fail("poison");
        },
      };
      const h = yield* Runner.start(
        [
          reg,
          {
            key: "healthy",
            definition: d,
            onDiff: (b) =>
              Effect.sync(() => {
                healthy.push(b);
              }),
          },
        ],
        options(),
      );
      yield* settleRunner(
        h,
        (s) => s.registrations[0]!.pending?.paused === true && s.registrations[1]!.pending === null,
      );
      yield* check(
        (yield* h.status).deliveredPosition < tx.position,
        "poison blocks shared checkpoint",
      );
      yield* equal(ids.length, 2, "bounded attempts");
      yield* h.stop;
      const restarted = yield* Runner.start(
        [
          {
            ...reg,
            onDiff: (b: Runner.Delivery) =>
              Effect.sync(() => {
                ids.push(b.batchId);
              }),
          },
          { key: "healthy", definition: d, onDiff: () => Effect.void },
        ],
        options(),
      );
      yield* check(
        (yield* restarted.status).registrations[0]!.pending?.paused,
        "restart honors poison",
      );
      yield* restarted.retryPaused("bad");
      yield* caught(restarted, tx.position);
      yield* check(
        ids.every((id) => id === ids[0]),
        "retry identity unchanged",
      );
      yield* equal(healthy.length, 1, "healthy registration progressed");
    }),
  "6 negation, future starts and empty-run expiry produce open satisfied reopened": Effect.gen(
    function* () {
      const t = yield* Triples;
      yield* TestClock.setTime(110);
      yield* t.transact([op("worker")]);
      const d = yield* Derivation.make({
        name: "safety",
        configSnapshot: "test",
        identity: ["?e"],
        query: {
          find: ["?e"],
          where: [
            ["?e", ":runner-test/value", "?v"],
            ["not", ["?e", ":test/trained", "yes"]],
          ],
        },
      });
      const batches: Runner.Delivery[] = [];
      const h = yield* launch(d, batches);
      yield* settleRunner(h, () => batches.length === 1);
      yield* t.transact([
        { ...op("worker", "yes", ":test/trained"), validFrom: 120, validTo: 200 },
      ]);
      yield* TestClock.setTime(150);
      yield* settleRunner(h, () => batches.length === 2);
      yield* equal(batches[1]!.basis.validAt, 120, "future start evaluated at exact boundary");
      // The empty run schedules expiry once it is acknowledged.
      yield* settleRunner(h, (s) => s.registrations[0]!.nextDeadline === 200);
      yield* TestClock.setTime(200);
      yield* settleRunner(h, () => batches.length === 3);
      yield* equal(
        batches.map((b) => [b.diff.added.length, b.diff.removed.length]),
        [
          [1, 0],
          [0, 1],
          [1, 0],
        ],
        "open satisfied reopened",
      );
      yield* check(
        batches[0]!.batchId !== batches[2]!.batchId,
        "reopened occurrence gets new identity",
      );
    },
  ),
  "7 offline replay preserves intermediate boundaries and monotonic frontier on rollback":
    Effect.gen(function* () {
      const t = yield* Triples;
      yield* TestClock.setTime(10);
      yield* t.transact([
        { ...op("a"), validFrom: 20, validTo: 30 },
        { ...op("b"), validFrom: 40, validTo: 50 },
      ]);
      const d = yield* definition();
      const batches: Runner.Delivery[] = [];
      const h = yield* launch(d, batches);
      yield* caught(h, 1);
      yield* h.stop;
      yield* TestClock.setTime(60);
      const recovered = yield* launch(d, batches);
      yield* settleRunner(recovered, () => batches.length === 4);
      yield* equal(
        batches.map((b) => b.basis.validAt),
        [20, 30, 40, 50],
        "every offline boundary",
      );
      yield* TestClock.setTime(15);
      const tx = yield* t.transact([op("c")]);
      yield* caught(recovered, tx.position);
      yield* check(
        batches[batches.length - 1]!.basis.validAt >= 50,
        "rollback never rewinds frontier",
      );
    }),
  "7b commit-at-boundary wins the tie, corrected deadlines and retractions cancel timers":
    Effect.gen(function* () {
      const t = yield* Triples;
      yield* TestClock.setTime(10);
      const initial = yield* t.transact([
        op("worker"),
        { ...op("worker", "yes", ":test/trained"), validTo: 20 },
      ]);
      const evidence = initial.triples.find((row) => row.attribute === ":test/trained")!;
      const d = yield* Derivation.make({
        name: "tie",
        configSnapshot: "test",
        identity: ["?e"],
        query: {
          find: ["?e"],
          where: [
            ["?e", ":runner-test/value", "?v"],
            ["not", ["?e", ":test/trained", "yes"]],
          ],
        },
      });
      const batches: Runner.Delivery[] = [];
      const h = yield* launch(d, batches);
      yield* caught(h, initial.position);
      yield* h.stop;
      yield* TestClock.setTime(20);
      const replaced = yield* t.transact([
        { op: "retract", id: evidence.id },
        { ...op("worker", "yes", ":test/trained"), validFrom: 20, validTo: 40 },
      ]);
      const recovered = yield* launch(d, batches);
      yield* caught(recovered, replaced.position);
      yield* equal(batches.length, 0, "replacement at expiry prevents transient reopen");
      yield* equal(
        (yield* recovered.status).registrations[0]!.nextDeadline,
        40,
        "corrected deadline installed",
      );
      const corrected = yield* t.transact([
        { op: "retract", id: replaced.triples[0]!.id },
        { ...op("worker", "yes", ":test/trained"), validFrom: 20, validTo: 30 },
      ]);
      yield* caught(recovered, corrected.position);
      yield* equal(
        (yield* recovered.status).registrations[0]!.nextDeadline,
        30,
        "earlier deadline re-arms minimum timer",
      );
      const retracted = yield* t.transact([{ op: "retract", id: corrected.triples[0]!.id }]);
      yield* caught(recovered, retracted.position);
      yield* equal(
        (yield* recovered.status).registrations[0]!.nextDeadline,
        null,
        "retracted schedule cancelled",
      );
      yield* equal(batches.length, 1, "retraction opens once");
    }),
  "1b duplicate proofs merge provenance and unchanged revisions suppress callbacks": Effect.gen(
    function* () {
      const t = yield* Triples;
      yield* TestClock.setTime(10);
      yield* t.transact([op("a"), op("a")]);
      const d = yield* definition();
      const batches: Runner.Delivery[] = [];
      const h = yield* launch(d, batches);
      yield* caught(h, 1);
      yield* equal(batches[0]!.diff.added.length, 1, "proofs deduplicate candidate");
      yield* equal(batches[0]!.diff.added[0]!.sources.length, 2, "proof sources merged");
      const unrelated = yield* t.transact([op("other", "no", ":other/value")]);
      yield* caught(h, unrelated.position);
      yield* equal(batches.length, 1, "unchanged callback suppressed");
    },
  ),
  "9b missing journal envelopes and infrastructure write rejection are supervised": Effect.gen(
    function* () {
      const t = yield* Triples;
      yield* TestClock.setTime(10);
      const d = yield* definition();
      const batches: Runner.Delivery[] = [];
      let hide = false;
      const wrapped: TriplesService = {
        ...t,
        transactions: (request) =>
          t
            .transactions(request)
            .pipe(Effect.map((page) => (hide ? { ...page, transactions: [] } : page))),
      };
      const h = yield* launch(d, batches).pipe(Effect.provideService(Triples, wrapped));
      yield* settleRunner(h, (s) => s.registrations[0]!.acknowledgedRun !== null);
      hide = true;
      yield* t.transact([op("missing")]);
      yield* TestClock.adjust(1);
      const failure = yield* Effect.result(h.await);
      yield* check(
        failure._tag === "Failure" && failure.failure.code === "CorruptState",
        "missing retained envelope fails instead of skipping",
      );
      yield* h.stop;
    },
  ),
  "8 lost hints, unfiltered paged coverage and maintenance tails": Effect.gen(function* () {
    const t = yield* Triples;
    yield* TestClock.setTime(10);
    const d = yield* definition();
    const batches: Runner.Delivery[] = [];
    const h = yield* launch(d, batches);
    yield* caught(h, 0);
    // GitHub's Node 22 runner exceeds the 5 s default for this paged journal case.
    for (let i = 0; i < 1005; i++)
      yield* t.transact([], { actor: "triplex/derivation-materializer" });
    const source = yield* t.transact([op("outside:projected-prefix")]);
    yield* caught(h, source.position);
    yield* check(
      batches.some((b) => b.position === source.position),
      "global feed discovers external write",
    );
    const pos = yield* t.currentPosition();
    yield* TestClock.adjust(10);
    yield* Effect.yieldNow;
    const idle = yield* t.currentPosition();
    yield* TestClock.adjust(10);
    yield* Effect.yieldNow;
    yield* check(
      (yield* t.currentPosition()) <= idle + 1 && idle >= pos,
      "maintenance does not recurse forever",
    );
  }),
  "9 deployment, drain before removal, generation and malformed control rejection": Effect.gen(
    function* () {
      const t = yield* Triples;
      yield* TestClock.setTime(10);
      yield* t.transact([op("a")]);
      const d = yield* definition();
      const h = yield* Runner.start(
        [{ key: "work", definition: d, onDiff: () => Effect.fail("poison") }],
        options(),
      );
      yield* settleRunner(h, (s) => !!s.registrations[0]!.pending?.paused);
      yield* h.stop;
      const missing = yield* Effect.result(Runner.start([], options()));
      yield* check(
        missing._tag === "Failure" && missing.failure.code === "MissingDefinition",
        "cannot remove unfinished registration",
      );
      const next = yield* definition("test", "release-2");
      const noOld = yield* Effect.result(launch(next, []));
      yield* check(
        noOld._tag === "Failure" && noOld.failure.code === "MissingDefinition",
        "old prepared definition required",
      );
      const batches: Runner.Delivery[] = [];
      const recovered = yield* Runner.start(
        [
          {
            key: "work",
            definition: next,
            onDiff: (b) =>
              Effect.sync(() => {
                batches.push(b);
              }),
          },
        ],
        { ...options(), recoveryDefinitions: [d] },
      );
      yield* recovered.retryPaused("work");
      yield* settleRunner(
        recovered,
        (s) => s.registrations[0]!.pending === null && batches.length >= 2,
      );
      yield* equal(batches[0]!.configSnapshot, "test", "old batch completed first");
      yield* equal(batches[1]!.reason, "definition", "new release diff");
      yield* recovered.stop;
      const generation = DatabaseScope.make({
        env: "test",
        tenant: "test",
        database: "runner-corpus:test",
        generation: 1,
      });
      const wrong = yield* Effect.result(Runner.start([], { ...options(), scope: generation }));
      yield* check(
        wrong._tag === "Failure" && wrong.failure.code === "GenerationChanged",
        "generation mismatch",
      );
      const rows = yield* t.match({ attribute: ":runner/hash" });
      const row = rows[0]!;
      yield* t.transact([
        { op: "retract", id: row.id },
        {
          op: "assert",
          entityId: row.entityId,
          entityType: Option.getOrUndefined(row.entityType),
          attribute: row.attribute,
          value: string("corrupt"),
          validFrom: 0,
        },
      ]);
      const corrupt = yield* Effect.result(launch(next, []));
      yield* check(
        corrupt._tag === "Failure" && corrupt.failure.code === "CorruptState",
        "corrupt hash rejected",
      );
    },
  ),
  "10b overlapping control writer fails CAS and retained ready work recovers": Effect.gen(
    function* () {
      const t = yield* Triples;
      yield* TestClock.setTime(10);
      yield* t.transact([op("a")]);
      const d = yield* definition();
      let competing = true;
      const wrapped: TriplesService = {
        ...t,
        transact: (ops, meta) =>
          Effect.gen(function* () {
            if (competing && ops.some((o) => o.op === "append-entry")) {
              competing = false;
              yield* t.transact(ops, { ...meta, commandId: "simulated-overlapping-owner" });
            }
            return yield* t.transact(ops, meta);
          }),
      };
      const batches: Runner.Delivery[] = [];
      const h = yield* launch(d, batches).pipe(Effect.provideService(Triples, wrapped));
      const failed = yield* Effect.result(h.await);
      yield* check(
        failed._tag === "Failure" && failed.failure.code === "Store",
        "stale control CAS fails supervision",
      );
      yield* equal(batches.length, 0, "conflict cannot acknowledge handler work");
      yield* h.stop;
      const recovered = yield* launch(d, batches);
      yield* caught(recovered, 1);
      yield* equal(batches.length, 1, "retained ready work survives stale writer");
    },
  ),
  "9c host validator rejection leaves the prepared basis unacknowledged": Effect.gen(function* () {
    const t = yield* Triples;
    yield* TestClock.setTime(10);
    yield* t.transact([op("a")]);
    const d = yield* definition();
    const wrapped: TriplesService = {
      ...t,
      transact: (ops, meta) =>
        t.transact(
          ops,
          ops.some((o) => o.op === "append-entry")
            ? {
                ...meta,
                validate: [
                  {
                    name: "host-policy",
                    validate: () =>
                      Effect.succeed([
                        {
                          code: "runner-denied",
                          message: "Infrastructure writes require host authorization",
                        },
                      ]),
                  },
                ],
              }
            : meta,
        ),
    };
    const batches: Runner.Delivery[] = [];
    const h = yield* launch(d, batches).pipe(Effect.provideService(Triples, wrapped));
    const failed = yield* Effect.result(h.await);
    yield* check(
      failed._tag === "Failure" && failed.failure.code === "Store",
      "validator rejection is supervised",
    );
    yield* equal(batches.length, 0, "rejection cannot acknowledge or invoke handler");
    yield* h.stop;
    const recovered = yield* launch(d, batches);
    yield* caught(recovered, 1);
    yield* equal(batches.length, 1, "authorized recovery retains prepared work");
  }),
  "10 ownership, ordered callbacks, payload backpressure and isolated worlds": Effect.gen(
    function* () {
      const t = yield* Triples;
      yield* TestClock.setTime(10);
      yield* t.transact([op("a"), op("b")]);
      const d = yield* definition();
      const h = yield* Runner.start([{ key: "work", definition: d, onDiff: () => Effect.void }], {
        ...options(),
        maxCandidates: 1,
      });
      yield* settleRunner(h, (s) => !!s.registrations[0]!.pending?.paused);
      const duplicate = yield* Effect.result(launch(d, []));
      yield* check(
        duplicate._tag === "Failure" && duplicate.failure.code === "AlreadyRunning",
        "second local owner rejected",
      );
      yield* h.stop;
      const resumed: Runner.Delivery[] = [];
      const r = yield* launch(d, resumed);
      yield* r.retryPaused("work");
      yield* caught(r, 1);
      yield* equal(resumed[0]!.diff.added.length, 2, "budget pause retains full basis");
      yield* r.stop;
      for (let i = 0; i < 16; i++) {
        const batches: Runner.Delivery[] = [];
        const world = yield* launch(d, batches, `world-${i}`);
        yield* settleRunner(world, () => batches.length === 1);
        yield* world.stop;
        yield* equal(batches[0]!.diff.added.length, 2, "isolated world bootstrap");
      }
    },
  ),
} as const;
export const runnerCases = effects;

/** Compose the corpus with a host-owned store and injected Clock layer. */
export const runnerConformance = <E, R, E2, R2>(fixture: {
  readonly store: Layer.Layer<Triples, E, R>;
  readonly clock: Layer.Layer<TestClock.TestClock, E2, R2>;
  readonly reopen?: () => Layer.Layer<Triples, E, R>;
}) =>
  Object.fromEntries([
    ...Object.entries(effects).map(([name, program]) => [
      name,
      program.pipe(Effect.scoped, Effect.provide(fixture.store), Effect.provide(fixture.clock)),
    ]),
    ...(fixture.reopen
      ? [
          [
            "physical store restart",
            runnerPersistenceCase(fixture.reopen).pipe(Effect.provide(fixture.clock)),
          ],
        ]
      : []),
  ]) as Record<string, Effect.Effect<void, unknown, Exclude<R | R2, Scope.Scope>>>;

/** Close/reopen the host's store between phases; KV fixtures retain their backend handle. */
export const runnerPersistenceCase = <E, R>(open: () => Layer.Layer<Triples, E, R>) =>
  Effect.gen(function* () {
    const d = yield* definition();
    const batches: Runner.Delivery[] = [];
    yield* TestClock.setTime(10);
    yield* Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.transact([{ ...op("persisted"), validFrom: 20, validTo: 30 }]);
      const h = yield* launch(d, batches, "persistent");
      yield* settleRunner(h, (s) => s.registrations[0]!.acknowledgedRun !== null);
      yield* h.stop;
    }).pipe(Effect.provide(open()), Effect.scoped);
    yield* TestClock.setTime(40);
    yield* Effect.gen(function* () {
      const h = yield* launch(d, batches, "persistent");
      yield* settleRunner(h, () => batches.length === 2);
      yield* equal(
        batches.map((b) => [b.basis.validAt, b.diff.added.length, b.diff.removed.length]),
        [
          [20, 1, 0],
          [30, 0, 1],
        ],
        "closed store reopens with retained schedule and head",
      );
      yield* h.stop;
    }).pipe(Effect.provide(open()), Effect.scoped);
  });

/** Sixteen independent persistent-store fixtures, each with its own runner scope and effects. */
export const runnerWorldsCase = <E, R>(open: (world: number) => Layer.Layer<Triples, E, R>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(10);
    const batches = yield* Effect.all(
      Array.from({ length: 16 }, (_, world) =>
        Effect.gen(function* () {
          const t = yield* Triples;
          const id = `world:${world}`;
          yield* t.transact([op(id)]);
          const d = yield* definition();
          const deliveries: Runner.Delivery[] = [];
          const h = yield* Runner.start(
            [
              {
                key: "work",
                definition: d,
                onDiff: (batch) =>
                  Effect.gen(function* () {
                    yield* t.transact([op(`effect:${world}`, id, ":world/delivered")], {
                      commandId: batch.commandId("added", batch.diff.added[0]!.id),
                    });
                    deliveries.push(batch);
                  }),
              },
            ],
            options(`isolated-${world}`),
          );
          yield* settleRunner(
            h,
            (s) => deliveries.length === 1 && s.registrations[0]!.pending === null,
          );
          yield* equal(
            deliveries[0]!.diff.added[0]!.result["?e"],
            id,
            "candidate belongs to its own world",
          );
          yield* equal(
            (yield* t.match({ attribute: ":world/delivered" })).length,
            1,
            "committed effect isolated to one world",
          );
          yield* h.stop;
          return deliveries[0]!.batchId;
        }).pipe(Effect.provide(open(world)), Effect.scoped),
      ),
      { concurrency: 4 },
    );
    yield* equal(new Set(batches).size, 16, "world generation participates in batch identity");
  });
