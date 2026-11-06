/**
 * Vendor risk review — queries and the activation guard.
 * Source: the trial brief. Every rule cites the brief sentence it implements.
 */
import { Data, Effect, Option } from "effect";
import { EntityId, Triples, type TemporalBasis } from "@triplex-build/triplex";
import { K } from "./model.js";

export type Reason = "no-current-review" | "no-soc2-or-ciso-exception" | "missing-dpa";

/**
 * One query per failure reason. `or` branches only accept single clauses (probe: an
 * `["and", ...]` branch fails with "Expected PredicateOp"), so the disjunction lives in host code.
 * Each query is evaluated at ONE temporal basis, so "current"/"expired" falls out of valid time.
 */
const base = (v: string) => [["?v", K.touches, true], ["?v", K.vendorName, v]];
export const reasonQueries = (vendorVar = "?name"): Record<Reason, unknown[]> => ({
  // Brief: "needs a security review ... a completed security questionnaire"; "Reviews expire after 12 months".
  "no-current-review": [
    ...base(vendorVar),
    ["not", ["?r", K.reviewVendor, "?v"], ["?r", K.questionnaire, true]],
  ],
  // Brief: "either a current SOC 2 Type II report or an approved exception";
  // "Exceptions are approved only by the CISO, must give a reason, and expire after 6 months."
  "no-soc2-or-ciso-exception": [
    ...base(vendorVar),
    ["not", ["?s", K.evidenceVendor, "?v"], ["?s", K.evidenceKind, "soc2-type2"]],
    [
      "not",
      ["?e", K.exceptionVendor, "?v"],
      ["?e", K.exceptionApprover, "?p"],
      ["?p", K.personRole, "ciso"],
      ["?e", K.exceptionReason, "?why"],
    ],
  ],
  // Brief: "High-risk vendors (those processing customer personal data) also need a DPA on file."
  "missing-dpa": [
    ...base(vendorVar),
    ["?v", K.personal, true],
    ["not", ["?d", K.evidenceVendor, "?v"], ["?d", K.evidenceKind, "dpa"]],
  ],
});

export interface Finding {
  readonly vendor: string;
  readonly name: string;
  readonly reasons: Reason[];
}

const collect = (extra: unknown[], basis: TemporalBasis) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    const out = new Map<string, Finding>();
    for (const [reason, where] of Object.entries(reasonQueries()) as [Reason, unknown[]][]) {
      // queryAll: trusted batch read (docs/datalog.md); `as never` because the public query type
      // is a deep Schema type and building clauses programmatically widens to unknown[].
      const { results } = yield* triples.queryAll(
        { find: ["?v", "?name"], where: [...where, ...extra] } as never,
        { basis },
      );
      for (const row of results as ReadonlyArray<Record<string, string>>) {
        const f = out.get(row["?v"]!) ?? { vendor: row["?v"]!, name: row["?name"]!, reasons: [] };
        f.reasons.push(reason);
        out.set(f.vendor, f);
      }
    }
    return [...out.values()].sort((a, b) => a.vendor.localeCompare(b.vendor));
  });

/** Q1: which vendors need a review now (at `validAt`). */
export const vendorsNeedingReview = (basis: TemporalBasis) => collect([], basis);

/** Q2: which ACTIVE vendors have an incomplete or expired review as of a date. Also the detection query
 * for the brief's "Procurement must not mark a vendor active while its review is incomplete or expired." */
export const activeVendorsOutOfCompliance = (basis: TemporalBasis) =>
  collect([["?v", K.status, "active"]], basis);

/**
 * Q3: which exceptions expire within 30 days of `at`. Valid-time end (validTo) is assertion
 * metadata, not a queryable value, so: visible at `at` AND not visible at `at + 30d`.
 */
export const exceptionsExpiringWithin = (at: number, days: number, recordedAt?: number) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    const q = {
      find: ["?e", "?vendorName"],
      where: [["?e", K.exceptionVendor, "?v"], ["?v", K.vendorName, "?vendorName"]],
    };
    const now = yield* triples.queryAll(q as never, { basis: { validAt: at, recordedAt } });
    const later = yield* triples.queryAll(q as never, {
      basis: { validAt: at + days * 86_400_000, recordedAt },
    });
    const stillValid = new Set((later.results as Array<Record<string, string>>).map((r) => r["?e"]));
    return (now.results as Array<Record<string, string>>)
      .filter((r) => !stillValid.has(r["?e"]))
      .map((r) => ({ exception: r["?e"]!, vendor: r["?vendorName"]! }))
      .sort((a, b) => a.exception.localeCompare(b.exception));
  });

/** Q3 cross-check: read validTo from the stored assertion via `match`. */
export const exceptionsExpiringViaMatch = (at: number, days: number) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    const facts = yield* triples.match({ attribute: K.exceptionVendor }, { validAt: at });
    return facts
      // Surprise: Triple.validTo is an Effect `Option<number>`, not `number | undefined`.
      .flatMap((f) => (Option.isSome(f.validTo) ? [{ exception: f.entityId as string, validTo: f.validTo.value }] : []))
      .filter((f) => f.validTo <= at + days * 86_400_000)
      .sort((a, b) => a.exception.localeCompare(b.exception));
  });

/** Q4: a vendor's review state on a past date, and who asserted the facts behind it. */
export const reviewStateAt = (vendorName: string, basis: TemporalBasis) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    const findings = yield* collect([["?v", K.vendorName, vendorName]], basis);
    // Step 1: which review assertions were visible at the basis, and in which transaction.
    const facts = yield* triples.queryAll(
      {
        find: ["?r", "?tx"],
        where: [
          ["?v", K.vendorName, vendorName],
          ["?r", K.reviewVendor, "?v"],
          ["?r", K.questionnaire, true, "?tx"],
        ],
      } as never,
      { basis },
    );
    // Step 2: resolve provenance at the DEFAULT basis. Joining `?tx :_tx/actor` inside the same
    // query silently returns [] for a past validAt: the `_tx` facts are only valid from commit time.
    const results: Array<Record<string, string>> = [];
    for (const row of facts.results as Array<Record<string, string>>) {
      const prov = yield* triples.queryAll({
        find: ["?actor", "?command"],
        where: [
          [row["?tx"]!, ":_tx/actor", "?actor"],
          [row["?tx"]!, ":_tx/command-id", "?command"],
        ],
      } as never, basis.recordedAt === undefined ? {} : { basis: { recordedAt: basis.recordedAt } });
      for (const p of prov.results as Array<Record<string, string>>) results.push({ "?r": row["?r"]!, ...p });
    }
    return {
      complete: findings.length === 0,
      reasons: findings[0]?.reasons ?? [],
      assertedBy: results,
    };
  });

// ---------------------------------------------------------------------------------------------
// Enforcement. GraphConstraint covers required/cardinality/unique/ref-target only
// (docs/troubleshooting.md "general Datalog invariants are outside this guarantee"), so the
// "no active vendor without a current review" rule is a HOST guard: check, then write with an
// EntityState precondition on the vendor so a concurrent change to the vendor fails the write.
// It cannot protect against the review/evidence entities changing concurrently unless every one of
// them is listed as a precondition, and it cannot stop time from expiring a review later.
// ---------------------------------------------------------------------------------------------
export class ActivationBlocked extends Data.TaggedError("ActivationBlocked")<{
  readonly vendor: string;
  readonly reasons: ReadonlyArray<Reason>;
}> {}

export const activateVendor = (
  vendorId: EntityId,
  vendorName: string,
  meta: { actor: string; commandId: string; validAt: number; configSnapshot?: string; enforce?: { constraints: ReadonlyArray<any> } },
) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    const blocking = yield* collect([["?v", K.vendorName, vendorName]], { validAt: meta.validAt });
    if (blocking.length > 0) {
      return yield* new ActivationBlocked({ vendor: vendorName, reasons: blocking[0]!.reasons });
    }
    const current = yield* triples.match({ entityId: vendorId, attribute: K.status }, { validAt: meta.validAt });
    const observed = yield* triples.entity(vendorId);
    return yield* triples.transact(
      [
        // No "close this interval" operation exists: retract the open-ended status and re-assert it
        // with validTo, otherwise `required` fails for the vendor's earlier lifetime.
        ...current.flatMap((f) => [
          { op: "retract" as const, id: f.id },
          {
            op: "assert" as const,
            entityId: vendorId,
            entityType: "Vendor",
            attribute: K.status,
            value: f.value,
            validFrom: f.validFrom, // Triple.validFrom is a number; validTo is Option<number>
            validTo: meta.validAt,
          },
        ]),
        {
          op: "assert" as const,
          entityId: vendorId,
          entityType: "Vendor",
          attribute: K.status,
          value: { type: "string" as const, value: "active" },
          validFrom: meta.validAt,
        },
      ] as never,
      {
        actor: meta.actor,
        commandId: meta.commandId,
        configSnapshot: meta.configSnapshot,
        enforce: meta.enforce as never,
        preconditions: [{ _tag: "EntityState", entityId: vendorId, tripleIds: observed.map((f) => f.id) }],
      },
    );
  });
