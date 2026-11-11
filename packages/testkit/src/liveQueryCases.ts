/** Shared browser-safe live-query corpus. Run against a fresh Triples store. */
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { EntityId, Triples, string, type TransactOp } from "@triplex-build/triplex";
import { LiveQuery, type WatchSnapshot } from "@triplex-build/triplex/live-query";
import { ConsumerCheckpoint, Outbox } from "@triplex-build/triplex/operational";
import type { DatalogQuery } from "@triplex-build/triplex/datalog";
const check = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new Error(message));
const equal = (a: unknown, b: unknown, message: string) =>
  check(
    JSON.stringify(a) === JSON.stringify(b),
    `${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`,
  );
const query: DatalogQuery = {
  find: ["?v"],
  where: [["?e", ":live/value", "?v"]],
  orderBy: [{ variable: "?v", direction: "asc" }],
};
const op = (
  id: string,
  value: string,
  attribute = ":live/value",
): Extract<TransactOp, { op: "assert" }> => ({
  op: "assert",
  entityId: EntityId.make(id),
  attribute,
  value: string(value),
  validFrom: 0,
});
const first = (stream: Stream.Stream<WatchSnapshot, unknown>) => stream.pipe(Stream.runHead);

export const liveQueryCases = {
  "aggregate snapshots, optional projections, interval patterns and wildcard expiry": Effect.gen(
    function* () {
      const t = yield* Triples;
      const live = yield* LiveQuery;
      yield* TestClock.setTime(10);
      const aggregate: DatalogQuery = {
        find: ["?count"],
        where: [["?e", ":live/value", "?v"]],
        aggregate: [["count", "?e", "?count"]],
      };
      const totals = yield* Stream.toPull(live.watch(aggregate));
      yield* totals;
      yield* t.transact([op("a", "a"), { ...op("b", "b"), validFrom: 20, validTo: 30 }]);
      yield* equal((yield* totals)[0].result.results, [{ "?count": 1 }], "aggregate after commit");
      const intervals = yield* Stream.toPull(
        live.watch({
          find: ["?e", "?from", "?to"],
          validTime: "all",
          where: [{ pattern: ["?e", ":live/value", "?v"], valid: { from: "?from", to: "?to" } }],
        }),
      );
      const interval = (yield* intervals)[0];
      yield* equal(interval.result.results.length, 2, "interval patterns");
      yield* check(
        interval.result.results.some((row) => row["?to"] === null),
        "optional unbounded end",
      );
      const dynamic = yield* Stream.toPull(
        live.watch({ find: ["?e", "?a", "?v"], where: [["?e", "?a", "?v"]] }),
      );
      yield* equal((yield* dynamic)[0].nextTemporalBoundary, 20, "wildcard start schedule");
      yield* TestClock.setTime(20);
      yield* check(
        (yield* dynamic)[0].result.results.some(
          (row) => row["?e"] === "b" && row["?a"] === ":live/value",
        ),
        "wildcard start",
      );
      yield* equal((yield* totals)[0].result.results, [{ "?count": 2 }], "aggregate timer");
      yield* TestClock.setTime(30);
      yield* check(
        !(yield* dynamic)[0].result.results.some(
          (row) => row["?e"] === "b" && row["?a"] === ":live/value",
        ),
        "wildcard half-open end",
      );
    },
  ),
  "complete raw results, atomic commits, exact cuts, irrelevant coverage and backpressure":
    Effect.gen(function* () {
      const t = yield* Triples;
      const live = yield* LiveQuery;
      const pull = yield* Stream.toPull(live.watch(query));
      yield* equal((yield* pull)[0].result.results, [], "empty initial");
      const one = yield* t.transact([op("a", "a"), op("b", "b")]);
      yield* t.transact([op("other", "ignored", ":other/value")]);
      const many = yield* t.transact(
        Array.from({ length: 120 }, (_, i) => op(`many:${i}`, `many:${i}`)),
      );
      const a = (yield* pull)[0];
      const b = (yield* pull)[0];
      yield* equal([a.position, b.position], [one.position, many.position], "per-commit cuts");
      yield* equal(
        [a.result.results.length, b.result.results.length],
        [2, 122],
        "complete atomic results",
      );
      yield* equal(b.coveredAfter, one.position, "coverage crosses irrelevant commit");
      const oversized = yield* Effect.result(first(live.watch(query, { maxRows: 100 })));
      yield* check(
        oversized._tag === "Failure" &&
          (oversized.failure as { _tag: string })._tag === "WatchResultTooLarge",
        "typed size failure",
      );
    }),
  "moving wrapper count and cursor parity, including sort changes outside the window": Effect.gen(
    function* () {
      const t = yield* Triples;
      const live = yield* LiveQuery;
      yield* t.transact([op("b", "b"), op("c", "c")]);
      const wrapped = { inner: query, includeCount: true, limit: 1 };
      const pull = yield* Stream.toPull(live.watch(wrapped));
      const initial = (yield* pull)[0];
      yield* equal(
        initial.result,
        yield* t.queryPage(wrapped, {
          basis: { recordedPosition: initial.position, validAt: initial.validAt! },
        }),
        "initial window parity",
      );
      yield* t.transact([op("a", "a")]);
      const next = (yield* pull)[0];
      yield* equal(next.result.results, [{ "?v": "a" }], "outside row enters window");
      yield* equal(
        next.result,
        yield* t.queryPage(wrapped, {
          basis: { recordedPosition: next.position, validAt: next.validAt! },
        }),
        "count cursor exact basis",
      );
    },
  ),
  "resume exact basis, offline expiry, changed parameters, malformed and ahead tokens": Effect.gen(
    function* () {
      const t = yield* Triples;
      const live = yield* LiveQuery;
      yield* TestClock.setTime(10);
      yield* t.transact([{ ...op("a", "a"), validTo: 20 }]);
      const pull = yield* Stream.toPull(live.watch(query));
      const initial = (yield* pull)[0];
      yield* TestClock.setTime(30);
      const replay = yield* Stream.toPull(live.watch(query, { resume: initial.resume }));
      const old = (yield* replay)[0];
      const now = (yield* replay)[0];
      yield* equal(
        [old.eventId, old.validAt, old.result],
        [initial.eventId, initial.validAt, initial.result],
        "exact resume",
      );
      yield* equal(
        [old.reason, now.reason, now.result.results],
        ["resume", "time", []],
        "offline expiry",
      );
      yield* check(
        now.eventId !== old.eventId && now.position === old.position,
        "timer event identity",
      );
      for (const [q, options] of [
        [query, { resume: "{" }],
        [query, { resume: initial.resume, maxRows: 3 }],
        [{ ...query, limit: 2 }, { resume: initial.resume }],
        [query, { resume: JSON.stringify({ ...JSON.parse(initial.resume), version: 2 }) }],
        [
          query,
          {
            resume: JSON.stringify({
              ...JSON.parse(initial.resume),
              position: initial.position + 100,
            }),
          },
        ],
      ] as const) {
        const result = yield* Effect.result(first(live.watch(q, options)));
        yield* check(
          result._tag === "Failure" &&
            (result.failure as { _tag: string })._tag === "WatchResumeError",
          "reject invalid token",
        );
      }
    },
  ),
  "metadata on empty and entry-only commands, trailing unjournaled checkpoint gaps": Effect.gen(
    function* () {
      const t = yield* Triples;
      const live = yield* LiveQuery;
      const pull = yield* Stream.toPull(
        live.watch({ find: ["?tx"], where: [["?tx", ":_tx/position", "?p"]] }),
      );
      yield* pull;
      const empty = yield* t.transact([]);
      yield* equal((yield* pull)[0].position, empty.position, "empty command");
      const entry = yield* t.transact([
        Outbox.append({ scope: EntityId.make("scope"), idempotencyKey: "key", payload: {} }),
      ]);
      yield* equal((yield* pull)[0].position, entry.position, "entry command");
      yield* ConsumerCheckpoint.advance(t, {
        consumer: "live-test",
        expectedPosition: 0,
        nextPosition: entry.position,
      });
      const gap = (yield* pull)[0];
      yield* check(gap.position > entry.position, "trailing gap emits");
      yield* equal(yield* t.currentPosition(), gap.position, "delivery writes no checkpoint");
      const later = yield* t.transact([]);
      yield* pull;
      yield* ConsumerCheckpoint.advance(t, {
        consumer: "live-test",
        expectedPosition: entry.position,
        nextPosition: later.position,
      });
      const middleGap = yield* t.currentPosition();
      const afterGap = yield* t.transact([]);
      yield* equal((yield* pull)[0].position, middleGap, "interior gap has its own cut");
      yield* equal((yield* pull)[0].position, afterGap.position, "commit after interior gap");
    },
  ),
  "worked site safety three commits and negated expiry, fixed corrections and all-time": Effect.gen(
    function* () {
      const t = yield* Triples;
      const live = yield* LiveQuery;
      const march1 = Date.UTC(2026, 2, 1),
        march2 = Date.UTC(2026, 2, 2),
        march3 = Date.UTC(2026, 2, 3),
        march5 = Date.UTC(2026, 2, 5),
        march6 = Date.UTC(2026, 2, 6),
        june1 = Date.UTC(2026, 5, 1);
      yield* TestClock.setTime(march2);
      const open: DatalogQuery = {
        find: ["?worker", "?site"],
        where: [
          ["?placement", ":placement/worker", "?worker"],
          ["?placement", ":placement/site", "?site"],
          ["not", ["?worker", ":worker/trained-for", "?site"]],
        ],
      };
      const pull = yield* Stream.toPull(live.watch(open));
      const initial = (yield* pull)[0];
      const fixed = yield* Stream.toPull(
        live.watch(open, { validTime: { mode: "fixed", at: march3 } }),
      );
      yield* fixed;
      yield* t.transact([
        { ...op("placement:maria", "worker:maria", ":placement/worker"), validFrom: march2 },
        { ...op("placement:maria", "site:harbor", ":placement/site"), validFrom: march2 },
      ]);
      const placed = (yield* pull)[0];
      yield* fixed;
      const training = yield* t.transact([
        {
          ...op("worker:maria", "site:harbor", ":worker/trained-for"),
          validFrom: march1,
          validTo: june1,
        },
      ]);
      const trained = (yield* pull)[0];
      yield* fixed;
      yield* TestClock.setTime(march6);
      yield* t.transact([
        { op: "retract", id: training.triples[0]!.id },
        {
          ...op("worker:maria", "site:harbor", ":worker/trained-for"),
          validFrom: march5,
          validTo: june1,
        },
      ]);
      const corrected = (yield* pull)[0];
      const past = (yield* fixed)[0];
      const all = yield* Stream.toPull(live.watch({ ...open, validTime: "all" }));
      const allFirst = (yield* all)[0];
      yield* equal(
        [allFirst.validAt, allFirst.nextTemporalBoundary, past.nextTemporalBoundary],
        [null, null, null],
        "no point timers",
      );
      yield* equal(past.result.results.length, 1, "fixed correction");
      // Suspend the consumer across the expiry: observation time collapses offline edges.
      yield* TestClock.setTime(june1);
      const expired = (yield* pull)[0];
      yield* equal(
        [initial, placed, trained, corrected, expired].map((s) => s.result.results.length),
        [0, 1, 0, 0, 1],
        "site sequence",
      );
      yield* equal(
        [
          trained.nextTemporalBoundary,
          corrected.nextTemporalBoundary,
          expired.nextTemporalBoundary,
        ],
        [june1, june1, null],
        "negative schedule",
      );
      yield* equal(
        [corrected.position, expired.position, expired.reason],
        [expired.position, expired.position, "time"],
        "expiry no write",
      );
      yield* check(corrected.eventId !== expired.eventId, "different valid instant identity");
    },
  ),
  "future starts, half-open expiry, delayed timer, rollback and cancelled registration cleanup":
    Effect.gen(function* () {
      const t = yield* Triples;
      const live = yield* LiveQuery;
      yield* TestClock.setTime(10);
      yield* t.transact([{ ...op("a", "a"), validFrom: 20, validTo: 30 }]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const pull = yield* Stream.toPull(live.watch(query));
          const initial = (yield* pull)[0];
          yield* equal(initial.nextTemporalBoundary, 20, "future start");
          const pending = yield* Effect.forkChild(pull);
          yield* TestClock.setTime(20);
          const started = (yield* Fiber.join(pending))[0];
          yield* equal(
            [started.validAt, started.result.results.length, started.nextTemporalBoundary],
            [20, 1, 30],
            "half-open start",
          );
          yield* TestClock.setTime(40);
          const expired = (yield* pull)[0];
          yield* equal(
            [expired.validAt, expired.result.results.length],
            [40, 0],
            "late timer actual time",
          );
          yield* TestClock.setTime(25);
          const back = (yield* pull)[0];
          yield* equal(back.result.results.length, 1, "clock rollback");
        }),
      );
      yield* equal((yield* live.metrics).pendingSubscribers, 0, "cleanup");
    }),
  "coalescing assert/retract burst has explicit coverage": Effect.gen(function* () {
    const t = yield* Triples;
    const live = yield* LiveQuery;
    const pull = yield* Stream.toPull(live.watch(query, { coalesceMs: 10 }));
    const start = (yield* pull)[0];
    const tx = yield* t.transact([op("a", "a")]);
    const end = yield* t.transact([{ op: "retract", id: tx.triples[0]!.id }]);
    const waiting = yield* Effect.forkChild(pull);
    yield* TestClock.adjust(10);
    const last = (yield* Fiber.join(waiting))[0];
    yield* equal(
      [last.position, last.coveredAfter, last.reason, last.result.results.length],
      [end.position, start.position, "coalesced", 0],
      "coalesced range",
    );
  }),
  "dynamic mixed namespaces, interval dependencies, disjunction and recursive same-name rules":
    Effect.gen(function* () {
      const t = yield* Triples;
      const live = yield* LiveQuery;
      yield* t.transact([op("anchor", "a")]);
      const dynamic: DatalogQuery = {
        find: ["?e", "?a", "?v"],
        where: [
          ["anchor", ":live/value", "a"],
          ["?e", "?a", "?v"],
        ],
      };
      const pull = yield* Stream.toPull(live.watch(dynamic));
      yield* pull;
      const changed = yield* t.transact([op("external", "b", ":other/value")]);
      const next = (yield* pull)[0];
      yield* equal(next.position, changed.position, "dynamic across namespaces");
      yield* check(
        next.result.results.some((r) => r["?v"] === "b"),
        "dynamic result",
      );
      const recursive: DatalogQuery = {
        find: ["?to"],
        where: [["reach", "anchor", "?to"]],
        rules: [
          { name: "reach", body: [["?from", ":edge/one", "?to"]] },
          { name: "reach", body: [["?from", ":edge/two", "?to"]] },
          {
            name: "reach",
            body: [
              ["?from", ":edge/one", "?mid"],
              ["reach", "?mid", "?to"],
            ],
          },
        ],
      };
      const recurse = yield* Stream.toPull(live.watch(recursive));
      yield* recurse;
      yield* t.transact([op("anchor", "middle", ":edge/one"), op("middle", "last", ":edge/two")]);
      yield* equal((yield* recurse)[0].result.results.length, 2, "recursive rule closure");
      const disjunction: DatalogQuery = {
        find: ["?e"],
        where: [
          ["?e", "?attr", "?v"],
          [
            "or",
            [
              ["?e", ":edge/one", "?v"],
              ["?e", ":edge/two", "?v"],
            ],
          ],
        ],
      };
      const or = yield* Stream.toPull(live.watch(disjunction));
      yield* or;
      yield* t.transact([op("outside", "last", ":edge/two")]);
      yield* equal((yield* or)[0].result.results.length, 3, "disjunction second alternative");
    }),
} as const;
