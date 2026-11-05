/** Portable graph-constraint rules and transaction-time enforcement. */

import { Effect, Option, Schema } from "effect";

import type { Triple, TransactOp } from "./Triple.js";
import * as CanonicalJson from "./content/CanonicalJson.js";

export type Code = "required" | "cardinality" | "unique" | "reference-target";

export interface RequiredRule {
  readonly _tag: "Required";
  readonly v: 1;
  readonly entityType: string;
  readonly attribute: string;
}

export interface CardinalityRule {
  readonly _tag: "Cardinality";
  readonly v: 1;
  readonly entityType: string;
  readonly attribute: string;
  readonly max: number;
}

export interface UniqueRule {
  readonly _tag: "Unique";
  readonly v: 1;
  readonly entityType: string;
  readonly attribute: string;
}

export interface ReferenceTargetRule {
  readonly _tag: "ReferenceTarget";
  readonly v: 1;
  readonly entityType: string;
  readonly attribute: string;
  readonly targetEntityType: string;
}

export type Rule = RequiredRule | CardinalityRule | UniqueRule | ReferenceTargetRule;

export const RuleSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Required"),
    v: Schema.Literal(1),
    entityType: Schema.String,
    attribute: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Cardinality"),
    v: Schema.Literal(1),
    entityType: Schema.String,
    attribute: Schema.String,
    max: Schema.Number,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Unique"),
    v: Schema.Literal(1),
    entityType: Schema.String,
    attribute: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("ReferenceTarget"),
    v: Schema.Literal(1),
    entityType: Schema.String,
    attribute: Schema.String,
    targetEntityType: Schema.String,
  }),
]);

export interface Violation {
  readonly constraintKey: string;
  readonly code: Code;
  readonly subject: string;
  readonly entityType: string;
  readonly attribute: string;
  readonly path: string;
  readonly message: string;
  /** Number of observed values or claimants, used to distinguish repair from worsening. */
  readonly actual: number;
  /** Canonical identity of a value involved in uniqueness or reference validation. */
  readonly valueIdentity?: string;
}

export interface ViolationAt extends Violation {
  readonly validAt: number;
}

export interface FactLoader<E> {
  /** Load live-recorded rows that carry this entity type. */
  readonly byEntityType: (entityType: string) => Effect.Effect<readonly Triple[], E>;
  /** Batch-load every live-recorded fact for the selected entity IDs. */
  readonly byEntities: (entityIds: readonly string[]) => Effect.Effect<readonly Triple[], E>;
}

export const keyOf = (rule: Rule): string => {
  const suffix =
    rule._tag === "Cardinality"
      ? `cardinality-${rule.max}`
      : rule._tag === "ReferenceTarget"
        ? `reference-target-${rule.targetEntityType}`
        : rule._tag.toLowerCase();
  return `${rule.entityType}:${rule.attribute}:${suffix}`;
};

/**
 * Load only the current-recorded facts that can influence a rule set.
 *
 * Source type scans discover existing subjects, one batch expands those
 * subjects to their constrained attributes, and target type scans provide the
 * existence intervals needed by reference constraints. Assertions that create
 * a new source subject are included in the expansion before projection.
 */
export const loadRelevantFacts = <E>(
  rules: readonly Rule[],
  operations: readonly TransactOp[],
  loader: FactLoader<E>,
): Effect.Effect<readonly Triple[], E> =>
  Effect.gen(function* () {
    const sourceTypes = [...new Set(rules.map((rule) => rule.entityType))].sort();
    const targetTypes = [
      ...new Set(
        rules.flatMap((rule) => (rule._tag === "ReferenceTarget" ? [rule.targetEntityType] : [])),
      ),
    ].sort();
    const sourceTypeFacts = (yield* Effect.forEach(sourceTypes, loader.byEntityType)).flat();
    const sourceIds = [
      ...new Set([
        ...sourceTypeFacts.map((fact) => fact.entityId as string),
        ...operations.flatMap((operation) =>
          operation.op === "assert" &&
          operation.entityType !== undefined &&
          sourceTypes.includes(operation.entityType)
            ? [operation.entityId]
            : [],
        ),
      ]),
    ].sort();
    const [sourceFacts, targetTypeFacts] = yield* Effect.all([
      loader.byEntities(sourceIds),
      Effect.forEach(targetTypes, loader.byEntityType).pipe(Effect.map((rows) => rows.flat())),
    ]);
    return [
      ...new Map(
        [...sourceTypeFacts, ...sourceFacts, ...targetTypeFacts].map((fact) => [fact.id, fact]),
      ).values(),
    ];
  });

const pathOf = (attribute: string): string => `$[${JSON.stringify(attribute)}]`;

/**
 * Canonical value identity for uniqueness. Sealed values compare by their keyed
 * blind token, never by ciphertext (which is randomized per write) and never by
 * plaintext. A sealed value without a blind token is comparable to nothing;
 * the sensitive-values layer rejects unique enforcement in that configuration
 * before evaluation, so it cannot silently pass.
 */
const valueKey = (triple: Triple): Effect.Effect<string, CanonicalJson.CanonicalEncodingError> =>
  triple.value.type === "sealed"
    ? Effect.succeed(
        triple.value.blind === undefined
          ? `sealed-unblinded:${triple.id}`
          : `sealed:${triple.value.blind}`,
      )
    : CanonicalJson.encode(
        (triple.value.type === "blob"
          ? {
              type: triple.value.type,
              value: triple.value.value,
              mimeType: triple.value.mimeType,
              size: triple.value.size,
              ...(triple.value.filename === undefined ? {} : { filename: triple.value.filename }),
            }
          : triple.value) as unknown as CanonicalJson.CanonicalValue,
      );

const visibleAt = (triple: Triple, validAt: number): boolean =>
  triple.validFrom <= validAt && (Option.isNone(triple.validTo) || triple.validTo.value > validAt);

/** Evaluate portable rules over one current-recorded fact set at a valid-time instant. */
export const evaluateFacts = (
  facts: readonly Triple[],
  rules: readonly Rule[],
  validAt: number,
): Effect.Effect<readonly Violation[], CanonicalJson.CanonicalEncodingError> =>
  Effect.gen(function* () {
    const visible = facts.filter((fact) => visibleAt(fact, validAt));
    const violations: Violation[] = [];

    for (const rule of [...rules].sort((left, right) => keyOf(left).localeCompare(keyOf(right)))) {
      const constraintKey = keyOf(rule);
      const subjects = [
        ...new Set(
          visible
            .filter(
              (fact) => Option.isSome(fact.entityType) && fact.entityType.value === rule.entityType,
            )
            .map((fact) => fact.entityId as string),
        ),
      ].sort();
      const subjectSet = new Set(subjects);
      const typedFacts = visible.filter((fact) => subjectSet.has(fact.entityId as string));

      if (rule._tag === "Required" || rule._tag === "Cardinality") {
        for (const subject of subjects) {
          const count = typedFacts.filter(
            (fact) => fact.entityId === subject && fact.attribute === rule.attribute,
          ).length;
          if (rule._tag === "Required" && count === 0) {
            violations.push({
              constraintKey,
              code: "required",
              subject,
              entityType: rule.entityType,
              attribute: rule.attribute,
              path: pathOf(rule.attribute),
              message: `${rule.entityType} requires ${rule.attribute}`,
              actual: 0,
            });
          }
          if (rule._tag === "Cardinality" && count > rule.max) {
            violations.push({
              constraintKey,
              code: "cardinality",
              subject,
              entityType: rule.entityType,
              attribute: rule.attribute,
              path: pathOf(rule.attribute),
              message: `${rule.entityType}.${rule.attribute} has ${count} live values; maximum cardinality is ${rule.max}`,
              actual: count,
            });
          }
        }
        continue;
      }

      if (rule._tag === "Unique") {
        const claims = new Map<string, Set<string>>();
        for (const fact of typedFacts) {
          if (fact.attribute !== rule.attribute) continue;
          const identity = yield* valueKey(fact);
          const claimants = claims.get(identity) ?? new Set<string>();
          claimants.add(fact.entityId as string);
          claims.set(identity, claimants);
        }
        for (const [identity, claimants] of claims) {
          if (claimants.size < 2) continue;
          const ordered = [...claimants].sort();
          for (const subject of ordered) {
            violations.push({
              constraintKey,
              code: "unique",
              subject,
              entityType: rule.entityType,
              attribute: rule.attribute,
              path: pathOf(rule.attribute),
              message: `${rule.entityType}.${rule.attribute} must be unique; the value is also used by ${ordered.filter((candidate) => candidate !== subject).join(", ")}`,
              actual: claimants.size,
              valueIdentity: identity,
            });
          }
        }
        continue;
      }

      for (const fact of typedFacts) {
        if (fact.attribute !== rule.attribute) continue;
        const identity = yield* valueKey(fact);
        const target = fact.value.type === "ref" ? fact.value.value : undefined;
        const validTarget =
          target !== undefined &&
          visible.some(
            (candidate) =>
              candidate.entityId === target &&
              Option.isSome(candidate.entityType) &&
              candidate.entityType.value === rule.targetEntityType,
          );
        if (validTarget) continue;
        violations.push({
          constraintKey,
          code: "reference-target",
          subject: fact.entityId as string,
          entityType: rule.entityType,
          attribute: rule.attribute,
          path: pathOf(rule.attribute),
          message:
            fact.value.type === "ref"
              ? `${rule.entityType}.${rule.attribute} references ${fact.value.value}, which is not a live ${rule.targetEntityType}`
              : `${rule.entityType}.${rule.attribute} must contain a reference to a ${rule.targetEntityType}`,
          actual: 1,
          valueIdentity: identity,
        });
      }
    }

    return violations.sort(
      (left, right) =>
        left.entityType.localeCompare(right.entityType) ||
        left.subject.localeCompare(right.subject) ||
        left.path.localeCompare(right.path) ||
        left.code.localeCompare(right.code) ||
        left.constraintKey.localeCompare(right.constraintKey) ||
        (left.valueIdentity ?? "").localeCompare(right.valueIdentity ?? ""),
    );
  });

const identityOf = (violation: Violation): string =>
  [
    violation.constraintKey,
    violation.code,
    violation.subject,
    violation.attribute,
    violation.valueIdentity ?? "",
  ].join("\u0000");

const patternMatches = (
  triple: Triple,
  op: Extract<TransactOp, { readonly op: "retract-pattern" }>,
): Effect.Effect<boolean, CanonicalJson.CanonicalEncodingError> =>
  Effect.gen(function* () {
    const pattern = op.pattern;
    if (pattern.entityId !== undefined && triple.entityId !== pattern.entityId) return false;
    if (pattern.attribute !== undefined && triple.attribute !== pattern.attribute) return false;
    if (
      pattern.entityType !== undefined &&
      (!Option.isSome(triple.entityType) || triple.entityType.value !== pattern.entityType)
    ) {
      return false;
    }
    if (pattern.value !== undefined) {
      const expected = yield* CanonicalJson.encode(
        pattern.value as unknown as CanonicalJson.CanonicalValue,
      );
      return (yield* valueKey(triple)) === expected;
    }
    return true;
  });

/** Project a transaction onto live-recorded facts without mutating a backend. */
export const project = (
  current: readonly Triple[],
  operations: readonly TransactOp[],
  instant: number,
): Effect.Effect<readonly Triple[], CanonicalJson.CanonicalEncodingError> =>
  Effect.gen(function* () {
    let projected = [...current];
    for (const [index, op] of operations.entries()) {
      if (op.op === "retract") {
        projected = projected.filter((fact) => fact.id !== op.id);
        continue;
      }
      if (op.op === "retract-pattern") {
        const matches = yield* Effect.forEach(projected, (fact) => patternMatches(fact, op));
        projected = projected.filter((_, factIndex) => !matches[factIndex]);
        continue;
      }
      projected.push({
        id: `constraint-pending-${index}` as Triple["id"],
        entityId: op.entityId as Triple["entityId"],
        attribute: op.attribute as Triple["attribute"],
        value: op.value,
        recordedAt: instant,
        validFrom: op.validFrom ?? instant,
        validTo: op.validTo === undefined ? Option.none() : Option.some(op.validTo),
        createdBy: op.createdBy === undefined ? Option.none() : Option.some(op.createdBy),
        retractedAt: Option.none(),
        entityType: op.entityType === undefined ? Option.none() : Option.some(op.entityType),
        schemaVersion: Option.none(),
        txId: Option.none(),
        retractTxId: Option.none(),
      });
    }
    return projected;
  });

/**
 * Find constraints newly violated or worsened by a transaction at every
 * valid-time boundary represented by its post-state.
 */
export const newlyViolated = (
  current: readonly Triple[],
  operations: readonly TransactOp[],
  rules: readonly Rule[],
  instant: number,
): Effect.Effect<readonly ViolationAt[], CanonicalJson.CanonicalEncodingError> =>
  Effect.gen(function* () {
    if (rules.length === 0) return [];
    const projected = yield* project(current, operations, instant);
    const boundaries = [
      ...new Set(
        [...current, ...projected].flatMap((fact) => [
          fact.validFrom,
          ...(Option.isSome(fact.validTo) ? [fact.validTo.value] : []),
        ]),
      ),
    ].sort((left, right) => left - right);
    const result: ViolationAt[] = [];
    for (const validAt of boundaries) {
      const before = yield* evaluateFacts(current, rules, validAt);
      const after = yield* evaluateFacts(projected, rules, validAt);
      const prior = new Map(before.map((violation) => [identityOf(violation), violation.actual]));
      for (const violation of after) {
        const previousActual = prior.get(identityOf(violation));
        if (previousActual === undefined || violation.actual > previousActual) {
          result.push({ ...violation, validAt });
        }
      }
    }
    return result;
  });
