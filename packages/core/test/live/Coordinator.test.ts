import { expect, it } from "vitest";
import { Clock, Context, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { EntityId, KvTriples, Triples, string } from "../../src/index.js";
import type { TriplesService } from "../../src/store/Triples.js";
import { DatabaseScope } from "../../src/runtime/index.js";
import { LiveQuery } from "../../src/live/index.js";
import { ReadError } from "../../src/errors/index.js";
const scope = DatabaseScope.test("coordinator");
const query = { find: ["?v"], where: [["?e", ":coordinator/value", "?v"]] };
const write = (t: TriplesService, value = "a") =>
  t.assert({
    entityId: EntityId.make(`coordinator:${value}`),
    attribute: ":coordinator/value",
    value: string(value),
    validFrom: 0,
  });
const run = (program: Effect.Effect<unknown, unknown, Triples>) =>
  Effect.runPromise(
    program.pipe(Effect.provide(KvTriples.layer), Effect.scoped, Effect.provide(TestClock.layer())),
  );
const service = (t: TriplesService, generation = scope) =>
  Effect.map(
    Layer.build(
      LiveQuery.layer({ scope: generation }).pipe(Layer.provide(Layer.succeed(Triples, t))),
    ),
    (context) => Context.get(context, LiveQuery),
  );

it("discovers a write racing initial query and schedule without emitter hints", () =>
  run(
    Effect.gen(function* () {
      const t = yield* Triples;
      let injected = false;
      const live = yield* service({
        ...t,
        queryAll: (q, o) =>
          t.queryAll(q, o).pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                if (!injected) {
                  injected = true;
                  yield* write(t);
                }
              }),
            ),
          ),
      });
      const pull = yield* Stream.toPull(live.watch(query));
      const initial = (yield* pull)[0],
        committed = (yield* pull)[0];
      expect(initial.position).toBe(0);
      expect(initial.result.results).toEqual([]);
      expect(committed.position).toBe(1);
      expect(committed.result.results).toEqual([{ "?v": "a" }]);
    }),
  ));

it("one shared idle journal read wakes two subscribers and a slow reader catches up independently", () =>
  run(
    Effect.gen(function* () {
      const t = yield* Triples;
      let feeds = 0;
      let evaluations = 0;
      const live = yield* service({
        ...t,
        transactions: (request) =>
          Effect.sync(() => {
            feeds++;
          }).pipe(Effect.andThen(t.transactions(request))),
        queryAll: (q, o) =>
          Effect.sync(() => {
            evaluations++;
          }).pipe(Effect.andThen(t.queryAll(q, o))),
      });
      const slow = yield* Stream.toPull(live.watch(query)),
        fast = yield* Stream.toPull(live.watch(query));
      yield* slow;
      yield* fast;
      const waiting = yield* Effect.forkChild(fast);
      // Let the reader enter idle sleep before simulating a remote commit.
      yield* TestClock.adjust(1);
      yield* write(t);
      yield* TestClock.adjust(1000);
      expect((yield* Fiber.join(waiting))[0].result.results.length).toBe(1);
      expect(feeds).toBe(1);
      yield* write(t, "b");
      yield* write(t, "c");
      expect((yield* fast)[0].position).toBe(2);
      expect((yield* fast)[0].position).toBe(3);
      expect((yield* slow)[0].position).toBe(1);
      expect((yield* slow)[0].position).toBe(2);
      expect((yield* slow)[0].position).toBe(3);
      const before = evaluations;
      yield* TestClock.adjust(5000);
      expect(evaluations).toBe(before);
    }),
  ));

it("query read errors terminate without producing a replacement token", () =>
  run(
    Effect.gen(function* () {
      const t = yield* Triples;
      let fail = false;
      const live = yield* service({
        ...t,
        queryAll: (q, o) =>
          fail ? Effect.fail(new ReadError({ message: "injected" })) : t.queryAll(q, o),
      });
      const pull = yield* Stream.toPull(live.watch(query));
      const initial = (yield* pull)[0];
      yield* write(t);
      fail = true;
      const result = yield* Effect.result(pull);
      expect(result._tag === "Failure" && result.failure._tag).toBe("ReadError");
      fail = false;
      const retry = yield* Stream.toPull(live.watch(query, { resume: initial.resume }));
      expect((yield* retry)[0].eventId).toBe(initial.eventId);
      expect((yield* retry)[0].position).toBe(1);
    }),
  ));

it("resume binds database generation and validates the head even for a self-consistent future token", () =>
  run(
    Effect.gen(function* () {
      const t = yield* Triples;
      const live = yield* service(t);
      const pull = yield* Stream.toPull(live.watch(query));
      const initial = (yield* pull)[0];
      const other = yield* service(
        t,
        DatabaseScope.make({ env: "test", tenant: "test", database: "coordinator", generation: 1 }),
      );
      const result = yield* Effect.result(
        other.watch(query, { resume: initial.resume }).pipe(Stream.runHead),
      );
      expect(result._tag === "Failure" && result.failure._tag).toBe("WatchResumeError");
      // The same query at a head reported by a different runtime must still reject an ahead token.
      const ahead = yield* service({ ...t, currentPosition: () => Effect.succeed(2) });
      const future = (yield* yield* Stream.toPull(ahead.watch(query)))[0];
      const rejected = yield* Effect.result(
        live.watch(query, { resume: future.resume }).pipe(Stream.runHead),
      );
      expect(rejected._tag === "Failure" && rejected.failure._tag).toBe("WatchResumeError");
    }),
  ));

it("re-arms earlier corrections and removed deadlines, and schedules suppressed facts outside a page", () =>
  run(
    Effect.gen(function* () {
      const t = yield* Triples;
      const live = yield* service(t);
      const first = yield* t.assert({
        entityId: EntityId.make("coordinator:a"),
        attribute: ":coordinator/value",
        value: string("a"),
        validFrom: 0,
        validTo: 100,
      });
      yield* t.assert({
        entityId: EntityId.make("coordinator:z"),
        attribute: ":coordinator/value",
        value: string("z"),
        validFrom: 0,
        validTo: 10,
      });
      const pull = yield* Stream.toPull(
        live.watch({
          inner: { ...query, orderBy: [{ variable: "?v", direction: "asc" }] },
          limit: 1,
          includeCount: true,
        }),
      );
      expect((yield* pull)[0].nextTemporalBoundary).toBe(10);
      yield* t.transact([
        { op: "retract", id: first.id },
        {
          op: "assert",
          entityId: first.entityId,
          attribute: first.attribute,
          value: first.value,
          validFrom: 0,
          validTo: 5,
        },
      ]);
      expect((yield* pull)[0].nextTemporalBoundary).toBe(5);
      const pending = yield* Effect.forkChild(pull);
      yield* TestClock.setTime(5);
      const changed = (yield* Fiber.join(pending))[0];
      expect(changed.result.results).toEqual([{ "?v": "z" }]);
      expect(changed.nextTemporalBoundary).toBe(10);
      expect(yield* Clock.currentTimeMillis).toBe(5);
    }),
  ));

it("observes a backward wall-clock jump even when it remains later than the last emission", () =>
  run(
    Effect.gen(function* () {
      const t = yield* Triples;
      const live = yield* service(t);
      const pull = yield* Stream.toPull(live.watch(query));
      expect((yield* pull)[0].validAt).toBe(0);
      const pending = yield* Effect.forkChild(pull);
      yield* TestClock.setTime(2000);
      yield* TestClock.setTime(1500);
      const second = yield* Stream.toPull(live.watch(query));
      yield* second;
      yield* TestClock.adjust(1);
      const backwards = (yield* Fiber.join(pending))[0];
      expect(backwards.reason).toBe("time");
    }),
  ));

it("unknown journal change metadata conservatively invalidates an unrelated attribute", () =>
  run(
    Effect.gen(function* () {
      const t = yield* Triples;
      const live = yield* service({
        ...t,
        transactions: (request) =>
          t.transactions(request).pipe(
            Effect.map((page) => ({
              ...page,
              transactions: page.transactions.map((tx) => ({
                ...tx,
                changes: tx.changes.map(({ value: _value, ...change }) => change),
              })),
            })),
          ),
      });
      const pull = yield* Stream.toPull(live.watch(query));
      yield* pull;
      const tx = yield* t.transact([
        {
          op: "assert",
          entityId: EntityId.make("other"),
          attribute: ":unrelated/value",
          value: string("ignored"),
          validFrom: 0,
        },
      ]);
      const snapshot = (yield* pull)[0];
      expect(snapshot.position).toBe(tx.position);
      expect(snapshot.result.results).toEqual([]);
    }),
  ));

it("bounds concurrent evaluations and resolves now after waiting for a permit", () =>
  run(
    Effect.gen(function* () {
      const t = yield* Triples;
      const gate = yield* Deferred.make<void>();
      let active = 0,
        maximum = 0;
      const instants: number[] = [];
      const decorated: TriplesService = {
        ...t,
        queryAll: (q, o) =>
          Effect.gen(function* () {
            active++;
            maximum = Math.max(maximum, active);
            instants.push(o!.basis!.validAt!);
            if (instants.length === 1) yield* Deferred.await(gate);
            const result = yield* t.queryAll(q, o);
            active--;
            return result;
          }),
      };
      const context = yield* Layer.build(
        LiveQuery.layer({ scope, evaluationConcurrency: 1 }).pipe(
          Layer.provide(Layer.succeed(Triples, decorated)),
        ),
      );
      const live = Context.get(context, LiveQuery);
      const a = yield* Effect.forkChild(live.watch(query).pipe(Stream.runHead));
      const b = yield* Effect.forkChild(live.watch(query).pipe(Stream.runHead));
      const c = yield* Effect.forkChild(live.watch(query).pipe(Stream.runHead));
      yield* TestClock.adjust(10);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(a);
      yield* Fiber.join(b);
      yield* Fiber.join(c);
      expect(maximum).toBe(1);
      expect(instants).toEqual([0, 10, 10]);
      expect((yield* live.metrics).pendingSubscribers).toBe(0);
    }),
  ));

it("fails an unavailable resume basis instead of silently resetting to the current head", () =>
  run(
    Effect.gen(function* () {
      const t = yield* Triples;
      const original = yield* service(t);
      const pull = yield* Stream.toPull(original.watch(query));
      const initial = (yield* pull)[0];
      yield* write(t);
      let attempted: number | undefined;
      const retained = yield* service({
        ...t,
        queryAll: (q, options) => {
          attempted = options?.basis?.recordedPosition;
          return attempted === 0
            ? Effect.fail(new ReadError({ message: "Requested history is unavailable" }))
            : t.queryAll(q, options);
        },
      });
      const result = yield* Effect.result(
        retained.watch(query, { resume: initial.resume }).pipe(Stream.runHead),
      );
      expect(result._tag === "Failure" && result.failure._tag).toBe("ReadError");
      expect(attempted).toBe(0);
      expect((yield* retained.metrics).pendingSubscribers).toBe(0);
    }),
  ));
