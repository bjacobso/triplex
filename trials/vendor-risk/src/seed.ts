/**
 * Synthetic data for the vendor risk brief. Business dates live in valid time; recorded time is
 * whatever the runtime clock says when the command commits.
 */
import { Effect, Layer } from "effect";
import { EntityId, KvTriples, Triples } from "@triplex-build/triplex";
import { ConfigStore, GraphConstraint } from "@triplex-build/triplex/config";
import { AllTypes, Evidence, Exception, Person, Review, Vendor, addMonths } from "./model.js";

export const D = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
export const TODAY = D("2026-11-06");
export const KNOWN_SINCE = D("2025-01-01");
export const PEOPLE_SINCE = D("2020-01-01");
export const id = (s: string) => EntityId.make(s);

export const AppLayer = (base: Layer.Layer<Triples> = KvTriples.layer) =>
  ConfigStore.layer.pipe(Layer.provideMerge(base));

export const publishRelease = Effect.gen(function* () {
  const config = yield* ConfigStore.ConfigStore;
  const objects = (yield* Effect.all(AllTypes.map((t) => t.nodes))).flat();
  const release = yield* config.commit({ label: "vendor-risk-2026.1", objects, ref: "live" });
  const enforce = GraphConstraint.enforcement(AllTypes.flatMap((t) => [...t.constraints]));
  return { release, enforce };
});

type Release = Effect.Success<typeof publishRelease>;

// NOTE: AssertionOptions only has `validFrom`; `validTo` passed to `.assertion()` is silently dropped
// when the options object is not a literal. Spread the interval onto the operation instead.
const as = (entityId: EntityId, entityType: string) => ({ op: "assert" as const, entityId, entityType });

export const command = (
  rel: Release,
  actor: string,
  commandId: string,
  ops: ReadonlyArray<Record<string, unknown>>,
) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    return yield* triples.transact(ops as never, {
      actor,
      commandId,
      correlationId: `seed:${commandId}`,
      configSnapshot: rel.release.snapshot.id,
      enforce: rel.enforce,
    });
  });

export const person = (rel: Release, key: string, name: string, role: "ciso" | "security-analyst" | "procurement") =>
  command(rel, "user:admin", `person:create:${key}`, [
    { ...as(id(`person:${key}`), "Person"), ...Person.attributes.name.assertion(name), validFrom: PEOPLE_SINCE },
    { ...as(id(`person:${key}`), "Person"), ...Person.attributes.role.assertion(role), validFrom: PEOPLE_SINCE },
  ]);

export const vendor = (
  rel: Release,
  key: string,
  touches: boolean,
  personal: boolean,
  status: "prospect" | "active",
  since: number,
) =>
  command(rel, "user:procurement-pat", `vendor:create:${key}`, [
    // Every fact must cover the entity's whole valid lifetime (required + ref-target are checked at
    // every valid-time edge), so status is modeled as prospect [KNOWN_SINCE, since) then active [since, ...).
    { ...as(id(`vendor:${key}`), "Vendor"), ...Vendor.attributes.name.assertion(key), validFrom: KNOWN_SINCE },
    { ...as(id(`vendor:${key}`), "Vendor"), ...Vendor.attributes.touchesCustomerData.assertion(touches), validFrom: KNOWN_SINCE },
    { ...as(id(`vendor:${key}`), "Vendor"), ...Vendor.attributes.processesPersonalData.assertion(personal), validFrom: KNOWN_SINCE },
    ...(status === "active"
      ? [
          { ...as(id(`vendor:${key}`), "Vendor"), ...Vendor.attributes.status.assertion("prospect"), validFrom: KNOWN_SINCE, validTo: since },
          { ...as(id(`vendor:${key}`), "Vendor"), ...Vendor.attributes.status.assertion("active"), validFrom: since },
        ]
      : [{ ...as(id(`vendor:${key}`), "Vendor"), ...Vendor.attributes.status.assertion("prospect"), validFrom: KNOWN_SINCE }]),
  ]);

/** Review valid for 12 months from completion (brief: "Reviews expire after 12 months"). */
export const review = (rel: Release, key: string, vendorKey: string, completedAt: number, actor = "user:sam") => {
  const w = { validFrom: completedAt, validTo: addMonths(completedAt, 12) };
  const r = id(`review:${key}`);
  return command(rel, actor, `review:complete:${key}`, [
    { ...as(r, "Review"), ...Review.attributes.vendor.assertion(id(`vendor:${vendorKey}`)), ...w },
    { ...as(r, "Review"), ...Review.attributes.questionnaireComplete.assertion(true), ...w },
    { ...as(r, "Review"), ...Review.attributes.reviewer.assertion(id("person:sam")), ...w },
  ]);
};

export const evidence = (
  rel: Release,
  key: string,
  vendorKey: string,
  kind: "soc2-type2" | "dpa",
  validFrom: number,
  validTo?: number,
) =>
  command(rel, "user:sam", `evidence:file:${key}`, [
    { ...as(id(`evidence:${key}`), "Evidence"), ...Evidence.attributes.vendor.assertion(id(`vendor:${vendorKey}`)), validFrom, validTo },
    { ...as(id(`evidence:${key}`), "Evidence"), ...Evidence.attributes.kind.assertion(kind), validFrom, validTo },
  ]);

/** Exception valid for 6 months (brief: "expire after 6 months"). `reason` may be omitted to test enforcement. */
export const exception = (
  rel: Release,
  key: string,
  vendorKey: string,
  approverKey: string,
  approvedAt: number,
  reason?: string,
) => {
  const w = { validFrom: approvedAt, validTo: addMonths(approvedAt, 6) };
  const e = id(`exception:${key}`);
  return command(rel, `user:${approverKey}`, `exception:approve:${key}`, [
    { ...as(e, "Exception"), ...Exception.attributes.vendor.assertion(id(`vendor:${vendorKey}`)), ...w },
    { ...as(e, "Exception"), ...Exception.attributes.approvedBy.assertion(id(`person:${approverKey}`)), ...w },
    ...(reason === undefined ? [] : [{ ...as(e, "Exception"), ...Exception.attributes.reason.assertion(reason), ...w }]),
  ]);
};

// Required constraints are checked at every valid-time edge of an entity, so every fact of one
// entity must share its interval (found by trial and error; see REPORT.md).

/** The synthetic portfolio. Expected classifications are asserted in the tests. */
export const seed = Effect.gen(function* () {
  const rel = yield* publishRelease;
  yield* person(rel, "cora", "Cora (CISO)", "ciso");
  yield* person(rel, "sam", "Sam (Security analyst)", "security-analyst");
  yield* person(rel, "pat", "Pat (Procurement)", "procurement");

  // acme-crm: high-risk, current review + SOC2 + DPA -> compliant, active.
  yield* vendor(rel, "acme-crm", true, true, "active", D("2026-03-15"));
  yield* review(rel, "acme-2026", "acme-crm", D("2026-03-01"));
  yield* evidence(rel, "acme-soc2", "acme-crm", "soc2-type2", D("2026-01-01"), D("2027-01-01"));
  yield* evidence(rel, "acme-dpa", "acme-crm", "dpa", D("2026-03-01"));

  // beta-analytics: high-risk, review + SOC2 but NO DPA -> incomplete, yet active.
  yield* vendor(rel, "beta-analytics", true, true, "active", D("2026-04-01"));
  yield* review(rel, "beta-2026", "beta-analytics", D("2026-03-20"));
  yield* evidence(rel, "beta-soc2", "beta-analytics", "soc2-type2", D("2026-02-01"), D("2027-02-01"));

  // gamma-mail: not high-risk; review from 2025-09-01 expired 2026-09-01 -> expired, active.
  yield* vendor(rel, "gamma-mail", true, false, "active", D("2025-09-10"));
  yield* review(rel, "gamma-2025", "gamma-mail", D("2025-09-01"));
  yield* evidence(rel, "gamma-soc2", "gamma-mail", "soc2-type2", D("2025-06-01"), D("2027-06-01"));

  // delta-hosting: no SOC2, CISO exception (expires 2026-12-01, inside 30 days) -> compliant, active.
  yield* vendor(rel, "delta-hosting", true, false, "active", D("2026-06-05"));
  yield* review(rel, "delta-2026", "delta-hosting", D("2026-06-01"));
  yield* exception(rel, "delta-soc2", "delta-hosting", "cora", D("2026-06-01"), "SOC 2 audit in progress; bridge letter on file");

  // epsilon-design: does not touch customer data -> no review needed.
  yield* vendor(rel, "epsilon-design", false, false, "active", D("2026-01-01"));

  // zeta-support: touches data, no review at all -> needs review, still a prospect.
  yield* vendor(rel, "zeta-support", true, false, "prospect", D("2026-10-01"));

  // eta-billing: exception approved by procurement (not CISO) -> incomplete, prospect.
  yield* vendor(rel, "eta-billing", true, false, "prospect", D("2026-09-01"));
  yield* review(rel, "eta-2026", "eta-billing", D("2026-09-15"));
  yield* exception(rel, "eta-soc2", "eta-billing", "pat", D("2026-09-15"), "Small vendor, no SOC 2");

  // iota-chat: CISO exception expiring 2026-11-20 and another expiring 2027-04-01.
  yield* vendor(rel, "iota-chat", true, false, "prospect", D("2026-05-20"));
  yield* review(rel, "iota-2026", "iota-chat", D("2026-05-20"));
  yield* exception(rel, "iota-soc2", "iota-chat", "cora", D("2026-05-20"), "Type I only; Type II due Q1");
  return rel;
});
