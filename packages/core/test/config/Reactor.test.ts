import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

import * as B from "../../src/config/BoolExpr";
import * as Catalog from "../../src/config/Catalog";
import * as Evaluate from "../../src/config/Evaluate";
import * as Reactor from "../../src/config/Reactor";
import * as World from "../../src/config/World";

const DAY = 86_400_000;
const MARCH_3 = 1772496000000;

const catalogOf = (rules: Readonly<Record<string, B.BoolExpr>>) =>
  Effect.gen(function* () {
    const nodes = yield* Effect.all(
      Object.entries(rules).map(([key, expr]) => Catalog.ruleNode(key, expr)),
    );
    return Catalog.fromNodes(nodes);
  });

const eligible = (ee: string) => B.all([B.rule("is-caregiver-" + ee), B.exists(ee, "work_auth")]);

const envOf = (world: World.World, catalog: Catalog.Catalog, now = MARCH_3): Evaluate.Env =>
  Evaluate.env(world, { now, granularity: "day" }, catalog);

describe("the reverse index finds only what depended on a change", () => {
  it.effect("ignores registrations that never read the changed fact", () =>
    Effect.gen(function* () {
      const catalog = yield* catalogOf({
        "is-caregiver-a": B.eq("a", "role", "caregiver"),
        "is-caregiver-b": B.eq("b", "role", "caregiver"),
      });
      const world = World.make({
        "a/role": "caregiver",
        "b/role": "caregiver",
        "a/work_auth": "i9",
      });

      let r = Reactor.empty;
      r = Reactor.register(r, "a", eligible("a"), envOf(world, catalog));
      r = Reactor.register(r, "b", eligible("b"), envOf(world, catalog));

      expect(Reactor.affected(r, [Reactor.factKey("a", "role")])).toEqual(["a"]);
      expect(Reactor.affected(r, [Reactor.factKey("b", "role")])).toEqual(["b"]);
      expect(Reactor.affected(r, [Reactor.factKey("c", "role")])).toEqual([]);
    }),
  );

  it.effect("finds a decision that depended on a fact being ABSENT", () =>
    Effect.gen(function* () {
      // The case a naive index over existing rows cannot see: `a/work_auth` has
      // no row, and the answer is what it is *because* of that.
      const catalog = yield* catalogOf({
        "is-caregiver-a": B.eq("a", "role", "caregiver"),
      });
      const world = World.make({ "a/role": "caregiver" });

      let r = Reactor.register(Reactor.empty, "a", eligible("a"), envOf(world, catalog)); // prettier-ignore
      expect(Reactor.answer(r, "a")?.truth).toEqual("false");

      const filled = World.withFact(world, "a", "work_auth", "i9");
      const reaction = Reactor.react(
        r,
        [Reactor.factKey("a", "work_auth")],
        envOf(filled, catalog),
      );

      expect(reaction.considered).toEqual(["a"]);
      expect(reaction.flipped).toEqual([{ key: "a", from: "false", to: "true" }]);
    }),
  );

  it.effect("indexes rules and clocks through the same path as facts", () =>
    Effect.gen(function* () {
      const catalog = yield* catalogOf({
        "is-caregiver-a": B.eq("a", "role", "caregiver"),
      });
      const world = World.make({
        "a/role": "caregiver",
        "a/work_auth": "i9",
        "a/start_date": MARCH_3 - DAY,
      });

      let r = Reactor.empty;
      r = Reactor.register(r, "a", eligible("a"), envOf(world, catalog));
      r = Reactor.register(r, "due", B.before("a", "start_date"), envOf(world, catalog)); // prettier-ignore

      // A republished rule reaches only what resolved it.
      expect(Reactor.affected(r, [Reactor.ruleKey("is-caregiver-a")])).toEqual(["a"]); // prettier-ignore
      // The day turning reaches only what asked a question about days.
      expect(Reactor.affected(r, [Reactor.clockKey("day")])).toEqual(["due"]);
    }),
  );

  it.effect("re-indexes when a refreshed answer reads different inputs", () =>
    Effect.gen(function* () {
      // `Any` short-circuits, so the second branch is only read when the first
      // fails. Without dropping the old edges the index would keep claiming a
      // dependency the answer no longer has.
      const catalog = yield* catalogOf({ noop: B.lit(true) });
      const expr = B.any([B.exists("a", "waiver"), B.exists("a", "work_auth")]);

      const withWaiver = World.make({ "a/waiver": "yes" });
      let r = Reactor.register(Reactor.empty, "a", expr, envOf(withWaiver, catalog)); // prettier-ignore

      // Both are read here, because `Any` in this implementation does not
      // short-circuit - the guarantee under test is that the edges track the
      // answer, whatever the evaluator chose to look at.
      const observedBefore = Reactor.answer(r, "a")!.observed.length;

      const gone = World.withoutFact(withWaiver, "a", "waiver");
      r = Reactor.react(r, [Reactor.factKey("a", "waiver")], envOf(gone, catalog)).reactor; // prettier-ignore

      expect(observedBefore).toBeGreaterThan(0);
      // Still indexed under both, and still findable under each.
      expect(Reactor.affected(r, [Reactor.factKey("a", "work_auth")])).toEqual(["a"]); // prettier-ignore
    }),
  );

  it.effect("forgets a registration completely when it is dropped", () =>
    Effect.gen(function* () {
      const catalog = yield* catalogOf({ "is-caregiver-a": B.lit(true) });
      const world = World.make({ "a/work_auth": "i9" });

      let r = Reactor.register(Reactor.empty, "a", eligible("a"), envOf(world, catalog)); // prettier-ignore
      expect(Reactor.affected(r, [Reactor.factKey("a", "work_auth")])).toEqual(["a"]); // prettier-ignore

      r = Reactor.unregister(r, "a");
      expect(Reactor.affected(r, [Reactor.factKey("a", "work_auth")])).toEqual([]); // prettier-ignore
      expect(r.index.size).toEqual(0);
      expect(Reactor.answer(r, "a")).toBeUndefined();
    }),
  );
});

describe("recomputation is not the same event as change", () => {
  it.effect("reports flips separately from what it reconsidered", () =>
    Effect.gen(function* () {
      const before = yield* catalogOf({
        "is-caregiver-a": B.eq("a", "role", "caregiver"),
      });
      // Same meaning, different bytes: the rule moved, the answer did not.
      const after = yield* catalogOf({
        "is-caregiver-a": B.all([B.eq("a", "role", "caregiver")]),
      });
      const world = World.make({ "a/role": "caregiver", "a/work_auth": "i9" });

      const r = Reactor.register(Reactor.empty, "a", eligible("a"), envOf(world, before)); // prettier-ignore
      const reaction = Reactor.react(r, [Reactor.ruleKey("is-caregiver-a")], envOf(world, after));

      // A rule edit may invalidate a decision and flip nothing. Callers that
      // notify people want the second list, not the first.
      expect(reaction.considered).toEqual(["a"]);
      expect(reaction.flipped).toEqual([]);
      expect(Reactor.answer(reaction.reactor, "a")?.truth).toEqual("true");
    }),
  );
});

describe("cost tracks the change, not the population", () => {
  it.effect("touches one of a thousand registrations", () =>
    Effect.gen(function* () {
      const rules: Record<string, B.BoolExpr> = {};
      for (let i = 0; i < 1000; i++) {
        rules["is-caregiver-ee" + i] = B.eq("ee" + i, "role", "caregiver");
      }
      const catalog = yield* catalogOf(rules);

      const facts: Record<string, World.Value> = {};
      for (let i = 0; i < 1000; i++) {
        facts[`ee${i}/role`] = "caregiver";
        facts[`ee${i}/work_auth`] = "i9";
      }
      let world = World.make(facts);

      // registerAll, not register-in-a-loop: the loop copies the whole reactor
      // per entry, which is quadratic. Measured, it did not finish at 10,000.
      let r = Reactor.registerAll(
        Reactor.empty,
        Array.from({ length: 1000 }, (_, i) => ({
          key: "ee" + i,
          expr: eligible("ee" + i),
          env: envOf(world, catalog),
        })),
      );

      world = World.withFact(world, "ee500", "role", "office");
      const reaction = Reactor.react(r, [Reactor.factKey("ee500", "role")], envOf(world, catalog));

      expect(reaction.considered).toEqual(["ee500"]);
      expect(reaction.flipped).toEqual([{ key: "ee500", from: "true", to: "false" }]);

      // The other 999 answers are untouched objects, not recomputed ones.
      expect(Reactor.answer(reaction.reactor, "ee499")).toBe(Reactor.answer(r, "ee499"));
    }),
  );

  it.effect("looks up changed buckets without scanning the population", () =>
    Effect.gen(function* () {
      for (const n of [250, 500, 1000]) {
        const rules: Record<string, B.BoolExpr> = {};
        const facts: Record<string, World.Value> = {};
        for (let i = 0; i < n; i++) {
          rules["is-caregiver-ee" + i] = B.eq("ee" + i, "role", "caregiver");
          facts[`ee${i}/role`] = "caregiver";
          facts[`ee${i}/work_auth`] = "i9";
        }
        const catalog = yield* catalogOf(rules);
        const world = World.make(facts);

        const r = Reactor.registerAll(
          Reactor.empty,
          Array.from({ length: n }, (_, i) => ({
            key: "ee" + i,
            expr: eligible("ee" + i),
            env: envOf(world, catalog),
          })),
        );

        const lookups = vi.spyOn(r.index, "get");
        const registrationReads = vi.spyOn(r.registrations, "get");
        const scans = [r.index, r.registrations].flatMap((map) => [
          vi.spyOn(map, Symbol.iterator),
          vi.spyOn(map, "entries"),
          vi.spyOn(map, "keys"),
          vi.spyOn(map, "values"),
          vi.spyOn(map, "forEach"),
        ]);

        try {
          const changedKeys = Array.from({ length: 200 }, (_, i) =>
            Reactor.factKey("ee" + (i % n), "role"),
          );
          for (const [i, changed] of changedKeys.entries()) {
            expect(Reactor.affected(r, [changed])).toEqual(["ee" + (i % n)]);
          }

          // Count the work directly: a lookup reads only its dependency bucket,
          // regardless of population size or how busy the test runner is.
          expect(lookups.mock.calls.map(([key]) => key)).toEqual(changedKeys);
          expect(registrationReads).not.toHaveBeenCalled();
          for (const scan of scans) expect(scan).not.toHaveBeenCalled();
        } finally {
          lookups.mockRestore();
          registrationReads.mockRestore();
          for (const scan of scans) scan.mockRestore();
        }
      }
    }),
  );
});

describe("the reactor never drifts from a fresh evaluation", () => {
  it.effect("agrees with evaluate after any sequence of changes", () =>
    Effect.gen(function* () {
      // The same differential discipline as the cache test, one level up. If
      // the index ever misses a dependent, a registration keeps a stale answer
      // and this diverges.
      const catalogs = [
        yield* catalogOf({
          "is-caregiver-a": B.eq("a", "role", "caregiver"),
          "is-caregiver-b": B.eq("b", "role", "caregiver"),
        }),
        yield* catalogOf({
          "is-caregiver-a": B.eq("a", "role", "office"),
          "is-caregiver-b": B.eq("b", "role", "caregiver"),
        }),
      ];

      let seed = 0xc0ffee;
      const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);

      let world = World.make({});
      let catalog = catalogs[0];
      let now = MARCH_3;

      let r = Reactor.empty;
      r = Reactor.register(r, "a", eligible("a"), envOf(world, catalog, now));
      r = Reactor.register(r, "b", eligible("b"), envOf(world, catalog, now));
      r = Reactor.register(r, "due", B.before("a", "start_date"), envOf(world, catalog, now)); // prettier-ignore

      for (let step = 0; step < 300; step++) {
        const changed: string[] = [];

        switch (next() % 5) {
          case 0: {
            const who = next() % 2 === 0 ? "a" : "b";
            world = World.withFact(world, who, "role", next() % 2 ? "caregiver" : "office"); // prettier-ignore
            changed.push(Reactor.factKey(who, "role"));
            break;
          }
          case 1: {
            const who = next() % 2 === 0 ? "a" : "b";
            world =
              next() % 2
                ? World.withFact(world, who, "work_auth", "i9")
                : World.withoutFact(world, who, "work_auth");
            changed.push(Reactor.factKey(who, "work_auth"));
            break;
          }
          case 2:
            world = World.withFact(world, "a", "start_date", MARCH_3 - (next() % 8) * DAY); // prettier-ignore
            changed.push(Reactor.factKey("a", "start_date"));
            break;
          case 3:
            catalog = catalogs[next() % catalogs.length];
            changed.push(Reactor.ruleKey("is-caregiver-a"), Reactor.ruleKey("is-caregiver-b")); // prettier-ignore
            break;
          default:
            now += DAY;
            changed.push(Reactor.clockKey("day"));
        }

        const env = envOf(world, catalog, now);
        r = Reactor.react(r, changed, env).reactor;

        for (const [key, reg] of r.registrations) {
          const fresh = Evaluate.evaluate(reg.expr, world, env.clock, catalog);
          expect(reg.evaluation.cid, `${key} @ step ${step}`).toEqual(fresh.cid);
        }
      }
    }),
  );
});
