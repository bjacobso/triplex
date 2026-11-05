/**
 * The execution bridge between temporal facts and deployed configuration.
 *
 * `Evaluate` remains a pure Merkle/proof kernel. This module supplies its two
 * stored inputs: a rule catalog from one `ConfigSnapshot` ref and the exact
 * Triple facts that catalog can observe. Keeping the bridge here lets a
 * decision use one Triples storage boundary without teaching the
 * proof format about a concrete backend.
 */

import { Data, Effect } from "effect";

import type { ReadError } from "../errors/index.js";
import { Triples } from "../store/Triples.js";
import type { Triple } from "../Triple.js";
import type { TemporalBasis } from "../Temporal.js";
import type { TripleValue } from "../Value.js";
import * as CanonicalJson from "../content/CanonicalJson.js";
import * as ContentId from "../content/ContentId.js";
import * as BoolExpr from "./BoolExpr.js";
import * as Catalog from "./Catalog.js";
import * as ConfigNode from "./ConfigNode.js";
import * as ConfigStore from "./ConfigStore.js";
import * as Evaluate from "./Evaluate.js";
import * as World from "./World.js";
import { unsafe } from "../Branded.js";

export class UnknownConfigRefError extends Data.TaggedError("UnknownConfigRefError")<{
  readonly ref: string;
  readonly message: string;
}> {}

export class AmbiguousDecisionFactError extends Data.TaggedError("AmbiguousDecisionFactError")<{
  readonly entity: string;
  readonly attribute: string;
  readonly count: number;
  readonly message: string;
}> {}

export class UnsupportedDecisionFactError extends Data.TaggedError("UnsupportedDecisionFactError")<{
  readonly entity: string;
  readonly attribute: string;
  readonly valueType: TripleValue["type"];
  readonly message: string;
}> {}

export type ConfigRuntimeError =
  | ConfigStore.LoadError
  | ReadError
  | UnknownConfigRefError
  | AmbiguousDecisionFactError
  | UnsupportedDecisionFactError;

export interface EvaluateRefInput {
  /** Git-style configuration ref, for example `live` or `test`. */
  readonly ref: string;
  /** Key of a rule node in the selected configuration release. */
  readonly rule: string;
  /** Entity substituted for `World.SUBJECT`. */
  readonly subject: string;
  readonly clock: World.Clock;
  /** Evaluate against facts visible at this bitemporal basis. Defaults to now. */
  readonly basis?: TemporalBasis;
}

export interface Decision {
  /** Content identity of the release root, subject, and nested evaluation. */
  readonly cid: ContentId.ContentId;
  readonly ref: string;
  readonly snapshotId: string;
  readonly snapshotRootCid: ConfigStore.ConfigSnapshot["rootCid"];
  readonly subject: string;
  readonly evaluation: Evaluate.Evaluation;
}

export interface TamperedDecision {
  readonly path: string;
  readonly claimed: ContentId.ContentId;
  readonly actual: ContentId.ContentId;
}

interface FactRead {
  readonly entity: string;
  readonly attribute: string;
}

const readKey = ({ entity, attribute }: FactRead): string => `${entity}\u0000${attribute}`;

/**
 * Static fact dependency closure for an expression and every rule it calls.
 * Missing rules deliberately contribute no reads; the evaluator will record
 * the missing config observation and return `unknown`.
 */
const factReads = (
  expr: BoolExpr.BoolExpr,
  catalog: Catalog.Catalog,
  subject: string,
): ReadonlyArray<FactRead> => {
  const reads = new Map<string, FactRead>();
  const visitedRules = new Set<string>();

  const visit = (current: BoolExpr.BoolExpr): void => {
    for (const mentioned of BoolExpr.mentions(current)) {
      const read = {
        entity: mentioned.entity === World.SUBJECT ? subject : mentioned.entity,
        attribute: mentioned.attribute,
      };
      reads.set(readKey(read), read);
    }

    for (const key of BoolExpr.mentionsRules(current)) {
      if (visitedRules.has(key)) continue;
      visitedRules.add(key);
      const rule = Catalog.lookup(catalog, key);
      if (rule) visit(rule.expr);
    }
  };

  visit(expr);
  return [...reads.values()].sort(
    (a, b) => a.entity.localeCompare(b.entity) || a.attribute.localeCompare(b.attribute),
  );
};

const scalarValue = (value: TripleValue): World.Value | undefined => {
  switch (value.type) {
    case "string":
    case "ref":
    case "blob":
      return value.value;
    case "number":
    case "datetime":
      return value.value;
    case "boolean":
      return value.value;
    case "json":
      return undefined;
    // Sealed values are not readable by rules without an explicit host open.
    case "sealed":
      return undefined;
  }
};

const worldFromReads = (
  reads: ReadonlyArray<FactRead>,
  basis?: TemporalBasis,
): Effect.Effect<
  World.World,
  ReadError | AmbiguousDecisionFactError | UnsupportedDecisionFactError,
  Triples
> =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    const facts = new Map<string, World.Value>();

    for (const read of reads) {
      const pattern = { entityId: unsafe.entityId(read.entity), attribute: read.attribute };
      const matches = yield* triples.match(pattern, basis);

      if (matches.length > 1) {
        return yield* new AmbiguousDecisionFactError({
          ...read,
          count: matches.length,
          message: `Decision fact ${read.entity}/${read.attribute} has ${matches.length} live values; evaluation requires cardinality one`,
        });
      }

      const triple: Triple | undefined = matches[0];
      if (!triple) continue;
      const value = scalarValue(triple.value);
      if (value === undefined) {
        return yield* new UnsupportedDecisionFactError({
          ...read,
          valueType: triple.value.type,
          message: `Decision fact ${read.entity}/${read.attribute} uses unsupported ${triple.value.type} data; rules accept scalar Triple values`,
        });
      }
      facts.set(World.factKey(read.entity, read.attribute), value);
    }

    return { facts };
  });

const decisionId = (decision: {
  readonly snapshotRootCid: ConfigStore.ConfigSnapshot["rootCid"];
  readonly subject: string;
  readonly evaluation: Evaluate.Evaluation;
}): ContentId.ContentId =>
  ContentId.hash(
    ContentId.Domain.decision,
    CanonicalJson.encodeOrThrow({
      v: 1,
      snapshotRootCid: decision.snapshotRootCid,
      subject: decision.subject,
      evaluation: decision.evaluation.cid,
    }),
  );

/**
 * Evaluate a deployed rule directly against temporal Triple facts.
 *
 * The returned envelope pins the release selected by the ref. The nested
 * evaluation remains independently verifiable with `Evaluate.verify` and
 * records content IDs for every config node and fact value it observed.
 */
export const evaluate = (
  input: EvaluateRefInput,
): Effect.Effect<Decision, ConfigRuntimeError, ConfigStore.ConfigStore | Triples> =>
  Effect.gen(function* () {
    const store = yield* ConfigStore.ConfigStore;
    const snapshot = yield* store.resolveRef(input.ref);
    if (!snapshot) {
      return yield* new UnknownConfigRefError({
        ref: input.ref,
        message: `Configuration ref "${input.ref}" does not exist`,
      });
    }

    const catalog = Catalog.fromNodes([...ConfigNode.walk(snapshot.root)].map(({ node }) => node));
    const expr = BoolExpr.rule(input.rule);
    const world = yield* worldFromReads(factReads(expr, catalog, input.subject), input.basis);
    const evaluation = Evaluate.evaluate(expr, world, input.clock, catalog, input.subject);

    const decision = {
      ref: input.ref,
      snapshotId: snapshot.id,
      snapshotRootCid: snapshot.rootCid,
      subject: input.subject,
      evaluation,
    };
    return { ...decision, cid: decisionId(decision) };
  });

/** Verify both the release-pinned decision envelope and its evaluation tree. */
export const verify = (decision: Decision): ReadonlyArray<TamperedDecision | Evaluate.Tampered> => {
  const nested = Evaluate.verify(decision.evaluation);
  const actual = decisionId(decision);
  return actual === decision.cid
    ? nested
    : [...nested, { path: "decision", claimed: decision.cid, actual }];
};
