/**
 * Planning-time analysis of Datalog over sensitive attributes.
 *
 * A variable is sensitive when it occurs in the value position of a pattern on
 * a sensitive attribute. The store can answer presence and keyed equality for
 * such a variable, and nothing else, so every other use is rejected before an
 * engine runs. Plaintext constants on sensitive attributes are rewritten to
 * blind-token constants.
 */

import { Effect } from "effect";

import {
  isNotClause,
  isOrClause,
  isPatternClause,
  isIntervalPattern,
  isPredicateClause,
  isRuleApplication,
  isTypedConstant,
  isVariable,
  normalizeOrAlternatives,
} from "../datalog/schema.js";
import type {
  Clause,
  Constant,
  DatalogQuery,
  NotClause,
  OrAlternative,
  PatternClause,
  Term,
  WrappedQuery,
} from "../datalog/types.js";
import { SensitiveQueryError } from "../errors/index.js";
import type { PlainValue, SealableValueType } from "../Value.js";

export type BlindScope = "database" | "attribute" | "none";

export interface AnalysisPolicy {
  readonly attributes: ReadonlyMap<string, SealableValueType>;
  readonly blindScope: BlindScope;
  /** Blind token for a plaintext constant already coerced to the declared type. */
  readonly blind: (
    attribute: string,
    value: PlainValue,
  ) => Effect.Effect<string | undefined, SensitiveQueryError>;
}

/** A blind token no codec produces: the constant cannot equal any stored value. */
export const NO_MATCH_BLIND = "!no-match";

type Use =
  | { readonly kind: "sensitive"; readonly attribute: string }
  | { readonly kind: "plain" }
  | { readonly kind: "identity" }
  | { readonly kind: "dynamic"; readonly attributeVariable: string }
  | {
      readonly kind: "projection" | "order" | "aggregate" | "having" | "predicate" | "rule";
    };

const fail = (
  attribute: string,
  operation: SensitiveQueryError["operation"],
  message: string,
): Effect.Effect<never, SensitiveQueryError> =>
  Effect.fail(new SensitiveQueryError({ attribute, operation, message }));

/**
 * Coerce a Datalog constant to the attribute's declared plaintext type using
 * Datalog's flattened scalar families. `undefined` means plaintext semantics
 * could never match it (for example a number against a text attribute).
 */
export const coerceConstant = (
  valueType: SealableValueType,
  constant: Constant,
): PlainValue | undefined => {
  if (isTypedConstant(constant)) return undefined;
  switch (valueType) {
    case "string":
      return typeof constant === "string" ? { type: "string", value: constant } : undefined;
    case "number":
      return typeof constant === "number" ? { type: "number", value: constant } : undefined;
    case "datetime":
      return typeof constant === "number" ? { type: "datetime", value: constant } : undefined;
    case "boolean":
      return typeof constant === "boolean" ? { type: "boolean", value: constant } : undefined;
    case "json":
      if (typeof constant !== "string") return undefined;
      try {
        return { type: "json", value: JSON.parse(constant) as unknown };
      } catch {
        return undefined;
      }
  }
};

/** Coerce a typed value (from `match`/`retract-pattern`) to the declared type. */
export const coerceValue = (
  valueType: SealableValueType,
  value: PlainValue,
): PlainValue | undefined => {
  if (value.type === valueType) return value;
  if (valueType === "datetime" && value.type === "number") return { ...value, type: "datetime" };
  if (valueType === "number" && value.type === "datetime") return { ...value, type: "number" };
  return undefined;
};

const describe = (attributes: ReadonlyMap<string, SealableValueType>): string =>
  [...attributes.keys()].sort().join(", ");

interface Collector {
  readonly uses: Map<string, Use[]>;
}

const record = (collector: Collector, term: Term | null, use: Use) => {
  if (!isVariable(term)) return;
  const uses = collector.uses.get(term) ?? [];
  uses.push(use);
  collector.uses.set(term, uses);
};

const isSensitiveAttribute = (policy: AnalysisPolicy, term: Term): term is string =>
  typeof term === "string" && !isVariable(term) && policy.attributes.has(term);

const rewritePattern = (
  policy: AnalysisPolicy,
  collector: Collector,
  pattern: PatternClause,
): Effect.Effect<PatternClause, SensitiveQueryError> =>
  Effect.gen(function* () {
    const [entity, attribute, value] = pattern;
    record(collector, entity, { kind: "identity" });
    record(collector, attribute, { kind: "identity" });
    if (pattern.length === 4) record(collector, pattern[3], { kind: "identity" });

    if (isVariable(attribute)) {
      if (!isVariable(value) && policy.attributes.size > 0) {
        return yield* fail(
          attribute,
          "dynamic-attribute",
          `A pattern with variable attribute ${attribute} and a constant value could compare a sensitive attribute (${describe(policy.attributes)}) with plaintext; name the attribute`,
        );
      }
      record(collector, value, { kind: "dynamic", attributeVariable: attribute });
      return pattern;
    }

    if (!isSensitiveAttribute(policy, attribute)) {
      record(collector, value, { kind: "plain" });
      return pattern;
    }

    if (isVariable(value)) {
      record(collector, value, { kind: "sensitive", attribute });
      return pattern;
    }

    // A constant on a sensitive attribute: compare by blind token.
    if (isTypedConstant(value) && value.type === "blind") return pattern;
    if (policy.blindScope === "none") {
      return yield* fail(
        attribute,
        "blind-index-unavailable",
        `Equality on sensitive attribute ${attribute} needs a blind index, but the configured codec has none`,
      );
    }
    const coerced = coerceConstant(policy.attributes.get(attribute)!, value);
    const token = coerced === undefined ? NO_MATCH_BLIND : yield* policy.blind(attribute, coerced);
    const blind: Constant = { type: "blind", value: token ?? NO_MATCH_BLIND };
    return (
      pattern.length === 4 ? [entity, attribute, blind, pattern[3]] : [entity, attribute, blind]
    ) as PatternClause;
  });

const recordPredicate = (
  collector: Collector,
  clause: readonly [unknown, Term | null, Term | null],
) => {
  record(collector, clause[1], { kind: "predicate" });
  record(collector, clause[2], { kind: "predicate" });
};

const rewriteNot = (
  policy: AnalysisPolicy,
  collector: Collector,
  clause: NotClause,
): Effect.Effect<NotClause, SensitiveQueryError> =>
  Effect.gen(function* () {
    const inner: unknown[] = [];
    for (const nested of clause.slice(1)) {
      if (nested === undefined) continue;
      const candidate = nested as Clause;
      if (isIntervalPattern(candidate)) {
        for (const bound of Object.values(candidate.valid))
          if (bound !== undefined) record(collector, bound, { kind: "plain" });
        inner.push({
          ...candidate,
          pattern: yield* rewritePattern(policy, collector, candidate.pattern),
        });
      } else if (isPatternClause(candidate)) {
        inner.push(yield* rewritePattern(policy, collector, candidate));
      } else {
        recordPredicate(collector, candidate as readonly [unknown, Term | null, Term | null]);
        inner.push(candidate);
      }
    }
    return ["not", ...inner] as unknown as NotClause;
  });

const rewriteClause = (
  policy: AnalysisPolicy,
  collector: Collector,
  clause: Clause,
): Effect.Effect<Clause, SensitiveQueryError> =>
  Effect.gen(function* () {
    if (isIntervalPattern(clause)) {
      for (const bound of Object.values(clause.valid))
        if (bound !== undefined) record(collector, bound, { kind: "plain" });
      return { ...clause, pattern: yield* rewritePattern(policy, collector, clause.pattern) };
    }
    if (isPatternClause(clause)) return yield* rewritePattern(policy, collector, clause);
    if (isPredicateClause(clause)) {
      recordPredicate(collector, clause);
      return clause;
    }
    if (isNotClause(clause)) return yield* rewriteNot(policy, collector, clause);
    if (isOrClause(clause)) {
      const alternatives: OrAlternative[] = [];
      for (const alternative of normalizeOrAlternatives(clause)) {
        alternatives.push(
          (yield* rewriteClause(policy, collector, alternative as Clause)) as OrAlternative,
        );
      }
      return ["or", alternatives] as unknown as Clause;
    }
    if (isRuleApplication(clause)) {
      record(collector, clause[1], { kind: "rule" });
      record(collector, clause[2], { kind: "rule" });
      return clause;
    }
    return clause;
  });

const SENSITIVE_USE_ERRORS: Record<
  "projection" | "order" | "aggregate" | "having" | "predicate" | "rule",
  { readonly operation: SensitiveQueryError["operation"]; readonly what: string }
> = {
  projection: { operation: "projection", what: "projected" },
  order: { operation: "order", what: "used for ordering" },
  aggregate: { operation: "aggregate", what: "aggregated" },
  having: { operation: "having", what: "compared in having" },
  predicate: {
    operation: "predicate",
    what: "compared in a predicate (use a constant in the pattern for equality)",
  },
  rule: { operation: "rule", what: "passed to a rule" },
};

const USE_PRIORITY: ReadonlyArray<Use["kind"]> = [
  "predicate",
  "aggregate",
  "having",
  "order",
  "rule",
  "projection",
  "plain",
  "identity",
  "dynamic",
  "sensitive",
];

const checkUses = (
  policy: AnalysisPolicy,
  collector: Collector,
): Effect.Effect<void, SensitiveQueryError> =>
  Effect.gen(function* () {
    for (const [variable, uses] of collector.uses) {
      const sensitive = uses.flatMap((use) => (use.kind === "sensitive" ? [use.attribute] : []));
      const dynamic = uses.find((use) => use.kind === "dynamic");

      if (dynamic !== undefined && policy.attributes.size > 0 && uses.length > 1) {
        return yield* fail(
          dynamic.attributeVariable,
          "dynamic-attribute",
          `${variable} is bound by a pattern with variable attribute ${dynamic.attributeVariable}, which may read a sensitive attribute (${describe(policy.attributes)}); name the attribute`,
        );
      }

      if (sensitive.length === 0) continue;
      const attribute = sensitive[0]!;

      // Report the most specific operation: a variable that is ordered or
      // aggregated is necessarily also projected.
      const ordered = [...uses].sort(
        (left, right) => USE_PRIORITY.indexOf(left.kind) - USE_PRIORITY.indexOf(right.kind),
      );
      for (const use of ordered) {
        if (use.kind in SENSITIVE_USE_ERRORS) {
          const error = SENSITIVE_USE_ERRORS[use.kind as keyof typeof SENSITIVE_USE_ERRORS];
          return yield* fail(
            attribute,
            error.operation,
            `Sensitive attribute ${attribute} value ${variable} cannot be ${error.what}; sealed values support presence and equality only`,
          );
        }
        if (use.kind === "plain" || use.kind === "identity") {
          return yield* fail(
            attribute,
            "join",
            `Sensitive attribute ${attribute} value ${variable} cannot be joined with a plaintext or identity position`,
          );
        }
      }

      if (sensitive.length > 1) {
        if (policy.blindScope === "none") {
          return yield* fail(
            attribute,
            "blind-index-unavailable",
            `Joining sensitive attribute ${attribute} needs a blind index, but the configured codec has none`,
          );
        }
        const distinct = new Set(sensitive);
        if (policy.blindScope === "attribute" && distinct.size > 1) {
          return yield* fail(
            attribute,
            "join",
            `Sensitive attributes ${[...distinct].sort().join(" and ")} have attribute-scoped blind tokens and cannot be joined`,
          );
        }
      }
    }
  });

const rejectSensitiveRules = (
  policy: AnalysisPolicy,
  query: DatalogQuery,
): Effect.Effect<void, SensitiveQueryError> =>
  Effect.gen(function* () {
    for (const rule of query.rules ?? []) {
      for (const clause of rule.body) {
        if (!isPatternClause(clause as Clause)) continue;
        const attribute = (clause as PatternClause)[1];
        if (isSensitiveAttribute(policy, attribute)) {
          return yield* fail(
            attribute,
            "rule",
            `Rule ${rule.name} reads sensitive attribute ${attribute}; rules relate identities and cannot use sealed values`,
          );
        }
        if (isVariable(attribute) && policy.attributes.size > 0) {
          return yield* fail(
            attribute,
            "dynamic-attribute",
            `Rule ${rule.name} uses variable attribute ${attribute}, which may read a sensitive attribute (${describe(policy.attributes)})`,
          );
        }
      }
    }
  });

/**
 * Check a (schema-valid) query against the policy and rewrite sensitive
 * constants to blind tokens. Additional terms (wrapper columns and ordering)
 * are checked as projections and orderings.
 */
export const prepareQuery = (
  policy: AnalysisPolicy,
  query: DatalogQuery,
  extra: { readonly projected?: readonly string[]; readonly ordered?: readonly string[] } = {},
): Effect.Effect<DatalogQuery, SensitiveQueryError> =>
  Effect.gen(function* () {
    if (policy.attributes.size === 0) return query;
    yield* rejectSensitiveRules(policy, query);

    const collector: Collector = { uses: new Map() };
    const where: Clause[] = [];
    for (const clause of query.where) where.push(yield* rewriteClause(policy, collector, clause));

    for (const term of query.find) record(collector, term, { kind: "projection" });
    for (const variable of extra.projected ?? []) {
      record(collector, variable, { kind: "projection" });
    }
    for (const spec of query.orderBy ?? []) record(collector, spec.variable, { kind: "order" });
    for (const variable of extra.ordered ?? []) record(collector, variable, { kind: "order" });
    for (const [, source] of query.aggregate ?? []) {
      record(collector, source, { kind: "aggregate" });
    }
    for (const [, left, right] of query.having ?? []) {
      record(collector, left, { kind: "having" });
      record(collector, right, { kind: "having" });
    }
    if (query.optionalProjection) {
      record(collector, query.optionalProjection.rowBinding, { kind: "identity" });
      for (const field of query.optionalProjection.fields) {
        if (policy.attributes.has(field.attribute)) {
          return yield* fail(
            field.attribute,
            "projection",
            `Sensitive attribute ${field.attribute} cannot be projected as ${field.variable}; sealed values support presence and equality only`,
          );
        }
      }
    }

    yield* checkUses(policy, collector);
    return { ...query, where };
  });

export const prepareWrappedQuery = (
  policy: AnalysisPolicy,
  query: WrappedQuery,
): Effect.Effect<WrappedQuery, SensitiveQueryError> =>
  prepareQuery(policy, query.inner, {
    projected: (query.filters ?? []).map((filter) => filter.column),
    ordered: (query.orderBy ?? []).map((spec) => spec.variable),
  }).pipe(Effect.map((inner) => ({ ...query, inner })));
