import { expect, it } from "vitest";
import { Clock, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { KvTriples, Triples, EntityId, string } from "../../src/index.js";
import { DatabaseScope } from "../../src/runtime/index.js";
import { LiveQuery } from "../../src/live/index.js";

it("emits an empty initial snapshot and replays every relevant commit at its exact cut", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const t = yield* Triples;
        const live = yield* LiveQuery;
        let count = 0;
        const seen = yield* live
          .watch({ find: ["?v"], where: [["?e", ":watch/value", "?v"]] })
          .pipe(
            Stream.tap(() =>
              Effect.gen(function* () {
                if (count++ === 0) {
                  yield* t.assert({
                    entityId: EntityId.make("watch:a"),
                    attribute: ":watch/value",
                    value: string("a"),
                    validFrom: 0,
                  });
                  yield* t.assert({
                    entityId: EntityId.make("watch:b"),
                    attribute: ":watch/value",
                    value: string("b"),
                    validFrom: 0,
                  });
                }
              }),
            ),
            Stream.take(3),
            Stream.runCollect,
          );
        expect(seen.map((s) => s.position)).toEqual([0, 1, 2]);
        expect(seen.map((s) => s.result.results.length)).toEqual([0, 1, 2]);
        expect(seen.map((s) => s.coveredAfter)).toEqual([null, 0, 1]);
      }),
    ).pipe(
      Effect.provide(LiveQuery.layer({ scope: DatabaseScope.test("live") })),
      Effect.provide(KvTriples.layer),
    ),
  );
});

it.each([
  { at: 20, rows: 1, boundary: 30 },
  { at: 40, rows: 0, boundary: null },
  { at: 5, rows: 0, boundary: 20 },
])(
  "observes time $at after an asynchronous coordinator head read",
  async ({ at, rows, boundary }) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const base = yield* Triples;
        const readers = new Set([yield* Effect.fiberId]);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const delayed = Layer.succeed(Triples, {
          ...base,
          currentPosition: () =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              if (!readers.has(yield* Effect.fiberId) && now === 11) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return yield* base.currentPosition();
            }),
        });
        yield* Effect.gen(function* () {
          yield* TestClock.setTime(10);
          yield* base.transact([
            {
              op: "assert",
              entityId: EntityId.make("watch:a"),
              attribute: ":watch/value",
              value: string("a"),
              validFrom: 20,
              validTo: 30,
            },
          ]);
          const live = yield* LiveQuery;
          const pull = yield* Stream.toPull(
            live.watch({
              find: ["?v"],
              where: [["?e", ":watch/value", "?v"]],
            }),
          );
          expect((yield* pull)[0].nextTemporalBoundary).toBe(20);
          const pending = yield* Effect.forkChild(
            Effect.gen(function* () {
              readers.add(yield* Effect.fiberId);
              return yield* pull;
            }),
          );
          // Let the pull suspend, then stop the coordinator inside its next head read.
          yield* TestClock.setTime(11);
          yield* Deferred.await(entered);
          yield* TestClock.setTime(at);
          yield* Deferred.succeed(release, undefined);
          // No further clock advancement: elapsed deadlines and rollback must wake now.
          const snapshot = (yield* TestClock.withLive(
            Fiber.join(pending).pipe(Effect.timeout("1 second")),
          ))[0];
          expect([
            snapshot.validAt,
            snapshot.result.results.length,
            snapshot.nextTemporalBoundary,
            snapshot.reason,
          ]).toEqual([at, rows, boundary, "time"]);
        }).pipe(
          Effect.provide(
            LiveQuery.layer({ scope: DatabaseScope.test("late-head"), idleCheckMs: 1 }),
          ),
          Effect.provide(delayed),
          Effect.scoped,
        );
      }).pipe(Effect.provide(KvTriples.layer), Effect.provide(TestClock.layer())),
    );
  },
);
