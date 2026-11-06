/**
 * Tests for the vendor risk review brief (see REPORT.md for the brief text and outcome table).
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { KvTriples, Triples } from "@triplex-build/triplex";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";
import { K, Review, Vendor, DAY } from "../src/model.js";
import {
  activateVendor,
  activeVendorsOutOfCompliance,
  exceptionsExpiringViaMatch,
  exceptionsExpiringWithin,
  reviewStateAt,
  vendorsNeedingReview,
} from "../src/queries.js";
import { AppLayer, D, TODAY, command, exception, id, seed, vendor } from "../src/seed.js";

const run = <A, E>(eff: Effect.Effect<A, E, any>, base: Layer.Layer<Triples, any> = KvTriples.layer) =>
  Effect.runPromise(eff.pipe(Effect.provide(AppLayer(base as Layer.Layer<Triples>))) as Effect.Effect<A, E>);
const sleep = (ms: number) => Effect.promise(() => new Promise((r) => setTimeout(r, ms)));
const summary = (fs: ReadonlyArray<{ name: string; reasons: string[] }>) =>
  Object.fromEntries(fs.map((f) => [f.name, [...f.reasons].sort()]));

describe("brief queries", () => {
  it("Q1: vendors that need a review now", async () => {
    const out = await run(Effect.gen(function* () {
      yield* seed;
      return yield* vendorsNeedingReview({ validAt: TODAY });
    }));
    expect(summary(out)).toEqual({
      "beta-analytics": ["missing-dpa"],
      "eta-billing": ["no-soc2-or-ciso-exception"], // exception approved by procurement, not the CISO
      "gamma-mail": ["no-current-review"], // review from 2025-09-01 expired 2026-09-01
      "zeta-support": ["no-current-review", "no-soc2-or-ciso-exception"],
    });
  });

  it("Q2: active vendors with incomplete or expired review, as of a date", async () => {
    const [today, dec2] = await run(Effect.gen(function* () {
      yield* seed;
      return [
        yield* activeVendorsOutOfCompliance({ validAt: TODAY }),
        // delta-hosting's CISO exception (2026-06-01 + 6 months) has lapsed by 2026-12-02
        yield* activeVendorsOutOfCompliance({ validAt: D("2026-12-02") }),
      ] as const;
    }));
    expect(summary(today)).toEqual({ "beta-analytics": ["missing-dpa"], "gamma-mail": ["no-current-review"] });
    expect(summary(dec2)).toEqual({
      "beta-analytics": ["missing-dpa"],
      "delta-hosting": ["no-soc2-or-ciso-exception"],
      "gamma-mail": ["no-current-review"],
    });
  });

  it("Q3: exceptions expiring within 30 days (two-basis Datalog and match/validTo agree)", async () => {
    const [viaQuery, viaMatch] = await run(Effect.gen(function* () {
      yield* seed;
      return [yield* exceptionsExpiringWithin(TODAY, 30), yield* exceptionsExpiringViaMatch(TODAY, 30)] as const;
    }));
    expect(viaQuery).toEqual([
      { exception: "exception:delta-soc2", vendor: "delta-hosting" },
      { exception: "exception:iota-soc2", vendor: "iota-chat" },
    ]);
    expect(viaMatch).toEqual([
      { exception: "exception:delta-soc2", validTo: D("2026-12-01") },
      { exception: "exception:iota-soc2", validTo: D("2026-11-20") },
    ]);
  });

  it("Q4: review state on a past date, and who asserted it (valid-time travel + provenance)", async () => {
    const [past, now] = await run(Effect.gen(function* () {
      yield* seed;
      return [
        yield* reviewStateAt("gamma-mail", { validAt: D("2026-06-01") }),
        yield* reviewStateAt("gamma-mail", { validAt: TODAY }),
      ] as const;
    }));
    expect(past).toEqual({
      complete: true,
      reasons: [],
      assertedBy: [{ "?r": "review:gamma-2025", "?actor": "user:sam", "?command": "review:complete:gamma-2025" }],
    });
    expect(now.complete).toBe(false);
    expect(now.reasons).toEqual(["no-current-review"]);
    expect(now.assertedBy).toEqual([]); // the review fact is no longer valid, so no provenance row either
  });

  it("Q4b: recorded-time travel across a correction, with who corrected it", async () => {
    const out = await run(Effect.gen(function* () {
      const rel = yield* seed;
      const triples = yield* Triples;
      yield* sleep(5); // see 'same-millisecond' trap below
      const beforeCorrection = Date.now();
      yield* sleep(5);
      // Security finds beta's questionnaire was not actually complete: retract the assertion.
      const [fact] = yield* triples.match({ entityId: id("review:beta-2026"), attribute: K.questionnaire }, { validAt: TODAY });
      yield* command(rel, "user:lee", "review:reopen:beta-2026", [{ op: "retract", id: fact!.id }]);
      const thenBelieved = yield* reviewStateAt("beta-analytics", { validAt: TODAY, recordedAt: beforeCorrection });
      const nowBelieved = yield* reviewStateAt("beta-analytics", { validAt: TODAY });
      const timeline = yield* triples.transactionsForEntity(id("review:beta-2026"), { limit: 10 });
      return { thenBelieved, nowBelieved, actors: timeline.transactions.map((t) => [t.actor, t.commandId]) };
    }));
    expect(out.thenBelieved.reasons).toEqual(["missing-dpa"]);
    expect(out.thenBelieved.assertedBy.map((r) => r["?actor"])).toEqual(["user:sam"]);
    expect(out.nowBelieved.reasons.sort()).toEqual(["missing-dpa", "no-current-review"]);
    expect(out.actors).toEqual([
      ["user:lee", "review:reopen:beta-2026"],
      ["user:sam", "review:complete:beta-2026"],
    ]);
  });
});

describe("enforcement", () => {
  it("built-in constraint: an exception without a reason is rejected (required)", async () => {
    const r = await run(Effect.gen(function* () {
      const rel = yield* seed;
      return yield* Effect.result(exception(rel, "theta", "zeta-support", "cora", TODAY));
    }));
    expect(r._tag).toBe("Failure");
    expect(String((r as any).failure?._tag)).toBe("ConstraintViolationError");
  });

  it("host guard blocks activation while review is incomplete; allows it when complete", async () => {
    const out = await run(Effect.gen(function* () {
      const rel = yield* seed;
      const blocked = yield* Effect.result(
        activateVendor(id("vendor:zeta-support"), "zeta-support", { actor: "user:pat", commandId: "activate:zeta", validAt: TODAY }),
      );
      const ok = yield* activateVendor(id("vendor:iota-chat"), "iota-chat", { actor: "user:pat", commandId: "activate:iota", validAt: TODAY, enforce: rel.enforce });
      const active = yield* activeVendorsOutOfCompliance({ validAt: TODAY });
      return { blocked, ok, active };
    }));
    expect(out.blocked._tag).toBe("Failure");
    expect((out.blocked as any).failure).toMatchObject({ _tag: "ActivationBlocked", reasons: ["no-current-review", "no-soc2-or-ciso-exception"] });
    expect(out.ok.position).toBeGreaterThan(0);
    expect(summary(out.active)).not.toHaveProperty("iota-chat");
  });

  it("GAP: a direct write bypasses the guard; only the detection query catches it", async () => {
    const out = await run(Effect.gen(function* () {
      const rel = yield* seed;
      const triples = yield* Triples;
      const [status] = yield* triples.match({ entityId: id("vendor:zeta-support"), attribute: K.status });
      const zeta = { op: "assert", entityId: id("vendor:zeta-support"), entityType: "Vendor" } as const;
      // A well-formed (constraint-valid) activation that simply skips the host guard.
      yield* command(rel, "user:rogue", "activate:zeta:direct", [
        { op: "retract", id: status!.id },
        { ...zeta, ...Vendor.attributes.status.assertion("prospect"), validFrom: D("2025-01-01"), validTo: TODAY },
        { ...zeta, ...Vendor.attributes.status.assertion("active"), validFrom: TODAY },
      ]);
      return yield* activeVendorsOutOfCompliance({ validAt: TODAY });
    }));
    expect(summary(out)["zeta-support"]).toEqual(["no-current-review", "no-soc2-or-ciso-exception"]);
  });

  it("GAP: time alone makes a compliant active vendor non-compliant; no write ever happens", async () => {
    const out = await run(Effect.gen(function* () {
      yield* seed;
      return yield* activeVendorsOutOfCompliance({ validAt: D("2027-03-02") }); // acme review expired 2027-03-01
    }));
    // acme review expired 2027-03-01 and its SOC 2 report expired 2027-01-01
    expect(summary(out)).toHaveProperty("acme-crm", ["no-current-review", "no-soc2-or-ciso-exception"]);
  });
});

describe("silent traps (probes)", () => {
  it("joining :_tx/actor in a past-validAt query silently returns [] (journal facts are valid from commit time)", async () => {
    const [past, current] = await run(Effect.gen(function* () {
      yield* seed;
      const t = yield* Triples;
      const q = {
        find: ["?actor"],
        where: [["?r", K.questionnaire, true, "?tx"], ["?r", K.reviewVendor, "vendor:gamma-mail"], ["?tx", ":_tx/actor", "?actor"]],
      };
      return [
        (yield* t.queryAll(q as never, { basis: { validAt: D("2026-06-01") } })).results,
        (yield* t.queryAll({ ...q, where: [["?r", K.reviewVendor, "?v"], ["?v", K.vendorName, "acme-crm"], ["?r", K.questionnaire, true, "?tx"], ["?tx", ":_tx/actor", "?actor"]] } as never)).results,
      ] as const;
    }));
    expect(past).toEqual([]); // the review WAS valid on 2026-06-01, but the provenance join drops it
    expect(current).toEqual([{ "?actor": "user:sam" }]);
  });

  it("a typo'd attribute returns [] instead of an error", async () => {
    const r = await run(Effect.gen(function* () {
      yield* seed;
      return yield* (yield* Triples).queryAll({ find: ["?v"], where: [["?v", ":vendor/staus", "active"]] });
    }));
    expect(r.results).toEqual([]);
  });

  // Fixed after the trial: AssertionOptions now carries validTo, so a non-literal options object keeps it.
  it("Attribute.assertion() keeps validTo when the options object is not a literal", async () => {
    const f = await run(Effect.gen(function* () {
      const rel = yield* seed;
      const triples = yield* Triples;
      const opts = { validFrom: D("2026-01-01"), validTo: D("2026-02-01") };
      void rel;
      yield* triples.transact([
        { op: "assert", entityId: id("review:trap"), entityType: "Review", ...Review.attributes.vendor.assertion(id("vendor:zeta-support"), opts) },
        { op: "assert", entityId: id("review:trap"), entityType: "Review", ...Review.attributes.questionnaireComplete.assertion(true, opts) },
      ], { actor: "user:sam", commandId: "trap:validTo" });
      return yield* triples.match({ entityId: id("review:trap"), attribute: K.questionnaire }, { validAt: TODAY });
    }));
    expect(f).toHaveLength(0); // expired at the intended validTo (the trial saw it still visible)
  });

  it("missing value is not false: without enforce, a vendor with no customer-data flag is invisible to Q1", async () => {
    const out = await run(Effect.gen(function* () {
      yield* seed;
      const triples = yield* Triples;
      yield* triples.transact(
        [{ op: "assert", entityId: id("vendor:kappa"), entityType: "Vendor", ...Vendor.attributes.name.assertion("kappa") }],
        { actor: "user:pat", commandId: "kappa" }, // no `enforce` -> required attributes not checked
      );
      return yield* vendorsNeedingReview({ validAt: TODAY });
    }));
    expect(summary(out)).not.toHaveProperty("kappa");
  });

  it("cardinality: a second status assertion without a retract — enforced vs not", async () => {
    const out = await run(Effect.gen(function* () {
      const rel = yield* seed;
      const triples = yield* Triples;
      const second = { op: "assert", entityId: id("vendor:gamma-mail"), entityType: "Vendor", ...Vendor.attributes.status.assertion("offboarded") };
      const enforced = yield* Effect.result(command(rel, "user:pat", "offboard:gamma:enforced", [second]));
      yield* triples.transact([second as never], { actor: "user:pat", commandId: "offboard:gamma:raw" });
      const statuses = yield* triples.match({ entityId: id("vendor:gamma-mail"), attribute: K.status });
      return { enforcedTag: enforced._tag, statuses: statuses.map((s) => String((s.value as { value: unknown }).value)).sort() };
    }));
    expect(out.enforcedTag).toBe("Failure");
    expect(out.statuses).toEqual(["active", "offboarded"]); // unenforced write: vendor is both
  });

  it("same-millisecond commits: recordedAt = receipt.instant may include later commits", async () => {
    const out = await run(Effect.gen(function* () {
      const rel = yield* seed;
      const a = yield* vendor(rel, "ms-a", true, false, "prospect", TODAY);
      const b = yield* vendor(rel, "ms-b", true, false, "prospect", TODAY);
      const seen = yield* vendorsNeedingReview({ validAt: TODAY, recordedAt: a.instant });
      return { same: a.instant === b.instant, seesB: seen.some((f) => f.name === "ms-b") };
    }));
    // Not asserted strictly (timing-dependent); recorded for the report.
    console.log("same-ms probe:", out);
    if (out.same) expect(out.seesB).toBe(true);
  });

  it("duplicate commandId fails instead of re-applying", async () => {
    const r = await run(Effect.gen(function* () {
      const rel = yield* seed;
      return yield* Effect.result(vendor(rel, "acme-crm", true, true, "active", TODAY));
    }));
    expect((r as any).failure?._tag).toBe("CommandAlreadyCommittedError");
  });
});

describe("SQLite parity", () => {
  it("Q1/Q2/Q3 give the same answers on SqliteTriples", async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* seed;
        return {
          q1: summary(yield* vendorsNeedingReview({ validAt: TODAY })),
          q2: summary(yield* activeVendorsOutOfCompliance({ validAt: TODAY })),
          q3: (yield* exceptionsExpiringWithin(TODAY, 30)).map((e) => e.exception),
        };
      }),
      SqliteTriples.layer({ filename: ":memory:" }) as never,
    );
    expect(out.q1).toEqual({
      "beta-analytics": ["missing-dpa"],
      "eta-billing": ["no-soc2-or-ciso-exception"],
      "gamma-mail": ["no-current-review"],
      "zeta-support": ["no-current-review", "no-soc2-or-ciso-exception"],
    });
    expect(Object.keys(out.q2)).toEqual(["beta-analytics", "gamma-mail"]);
    expect(out.q3).toEqual(["exception:delta-soc2", "exception:iota-soc2"]);
    void DAY;
  });
});
