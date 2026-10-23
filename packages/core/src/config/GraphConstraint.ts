/** Content-addressed constraints over relationships between Triplex facts. */

import { Data, Effect, Option, Result, Schema } from "effect";

import { unsafe } from "../Branded.js";
import type { ReadError } from "../errors/index.js";
import type { TriplesService } from "../store/Triples.js";
import type { TemporalBasis } from "../Temporal.js";
import type { Triple } from "../Triple.js";
import * as CanonicalJson from "../content/CanonicalJson.js";
import * as Constraint from "../Constraint.js";
import * as ConfigNode from "./ConfigNode.js";
import * as TypeExpr from "./TypeExpr.js";

export const KIND = "graph-constraint";

export type Code = Constraint.Code;
export type RequiredRule = Constraint.RequiredRule;
export type CardinalityRule = Constraint.CardinalityRule;
export type UniqueRule = Constraint.UniqueRule;
export type ReferenceTargetRule = Constraint.ReferenceTargetRule;
export type Rule = Constraint.Rule;

export interface Definition<R extends Rule = Rule> {
  readonly _tag: "GraphConstraint";
  readonly key: string;
  readonly rule: R;
  readonly node: Effect.Effect<
    ConfigNode.ConfigNode,
    ConfigNode.DuplicateChildKeyError | CanonicalJson.CanonicalEncodingError | Schema.SchemaError
  >;
}

export type Violation = Omit<Constraint.Violation, "actual" | "valueIdentity">;

export class InvalidGraphConstraintError extends Data.TaggedError("InvalidGraphConstraintError")<{
  readonly key: string;
  readonly message: string;
}> {}

export class DuplicateGraphConstraintError extends Data.TaggedError(
  "DuplicateGraphConstraintError",
)<{
  readonly key: string;
  readonly message: string;
}> {}

const RuleSchema = Constraint.RuleSchema;

const DefinitionType = TypeExpr.struct({
  _tag: TypeExpr.required(
    TypeExpr.enumOf(["Required", "Cardinality", "Unique", "ReferenceTarget"]),
  ),
  v: TypeExpr.required(TypeExpr.integer),
  entityType: TypeExpr.required(TypeExpr.text),
  attribute: TypeExpr.required(TypeExpr.text),
  max: TypeExpr.optional(TypeExpr.integer),
  targetEntityType: TypeExpr.optional(TypeExpr.text),
});

const keyOf = Constraint.keyOf;

const definition = <R extends Rule>(rule: R): Definition<R> => {
  const key = keyOf(rule);
  return {
    _tag: "GraphConstraint",
    key,
    rule,
    node: ConfigNode.makeTyped({
      kind: KIND,
      key,
      type: DefinitionType,
      attrs: rule,
      refs: [
        { rel: "constrains-entity-type", kind: "entity-schema", key: rule.entityType },
        { rel: "constrains-attribute", kind: "attribute", key: rule.attribute },
        ...(rule._tag === "ReferenceTarget"
          ? [
              {
                rel: "requires-target-entity-type",
                kind: "entity-schema",
                key: rule.targetEntityType,
              },
            ]
          : []),
      ],
    }),
  };
};

export const required = (entityType: string, attribute: string): Definition<RequiredRule> =>
  definition({ _tag: "Required", v: 1, entityType, attribute });

export const cardinality = (
  entityType: string,
  attribute: string,
  max: number,
): Definition<CardinalityRule> => {
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new TypeError("Graph constraint cardinality must be a positive safe integer");
  }
  return definition({ _tag: "Cardinality", v: 1, entityType, attribute, max });
};

export const unique = (entityType: string, attribute: string): Definition<UniqueRule> =>
  definition({ _tag: "Unique", v: 1, entityType, attribute });

export const referenceTarget = (
  entityType: string,
  attribute: string,
  targetEntityType: string,
): Definition<ReferenceTargetRule> =>
  definition({
    _tag: "ReferenceTarget",
    v: 1,
    entityType,
    attribute,
    targetEntityType,
  });

/** Build the plain transaction metadata payload for atomic enforcement. */
export const enforcement = (
  definitions: ReadonlyArray<Definition>,
): { readonly constraints: ReadonlyArray<Rule> } => ({
  constraints: definitions.map(({ rule }) => rule),
});

export const parse = (
  node: ConfigNode.ConfigNode,
): Effect.Effect<Rule, InvalidGraphConstraintError> => {
  const decoded = Schema.decodeUnknownResult(RuleSchema)(node.attrs);
  if (Result.isFailure(decoded)) {
    return Effect.fail(
      new InvalidGraphConstraintError({
        key: node.key,
        message: `Invalid graph constraint ${node.key}: ${decoded.failure.message}`,
      }),
    );
  }
  if (keyOf(decoded.success) !== node.key) {
    return Effect.fail(
      new InvalidGraphConstraintError({
        key: node.key,
        message: `Invalid graph constraint ${node.key}: key does not match its rule`,
      }),
    );
  }
  if (
    decoded.success._tag === "Cardinality" &&
    (!Number.isSafeInteger(decoded.success.max) || decoded.success.max < 1)
  ) {
    return Effect.fail(
      new InvalidGraphConstraintError({
        key: node.key,
        message: `Invalid graph constraint ${node.key}: max must be a positive safe integer`,
      }),
    );
  }
  return Effect.succeed(decoded.success);
};

/** Load and validate every independently versioned graph constraint in a config tree. */
export const collect = (
  root: ConfigNode.ConfigNode,
): Effect.Effect<
  ReadonlyArray<Definition>,
  InvalidGraphConstraintError | DuplicateGraphConstraintError
> =>
  Effect.gen(function* () {
    const nodes = [...ConfigNode.walk(root)].map(({ node }) => node);
    const slots = new Set(nodes.map((node) => `${node.kind}\u0000${node.key}`));
    const found = new Map<string, { readonly cid: string; readonly definition: Definition }>();
    for (const node of nodes) {
      if (node.kind !== KIND) continue;
      const rule = yield* parse(node);
      const requiredSlots = [
        `entity-schema\u0000${rule.entityType}`,
        `attribute\u0000${rule.attribute}`,
        ...(rule._tag === "ReferenceTarget" ? [`entity-schema\u0000${rule.targetEntityType}`] : []),
      ];
      const missing = requiredSlots.find((slot) => !slots.has(slot));
      if (missing) {
        const [kind, key] = missing.split("\u0000");
        return yield* new InvalidGraphConstraintError({
          key: node.key,
          message: `Invalid graph constraint ${node.key}: missing ${kind} ${key}`,
        });
      }
      const existing = found.get(node.key);
      if (existing && existing.cid !== node.cid) {
        return yield* new DuplicateGraphConstraintError({
          key: node.key,
          message: `Configuration contains graph constraint ${node.key} more than once`,
        });
      }
      found.set(node.key, {
        cid: node.cid,
        definition: {
          _tag: "GraphConstraint",
          key: node.key,
          rule,
          node: Effect.succeed(node),
        },
      });
    }
    return [...found.values()]
      .map(({ definition }) => definition)
      .sort((left, right) => left.key.localeCompare(right.key));
  });

/**
 * Transaction metadata that governs a write by one release: `configSnapshot`
 * records the release id, and `enforce` carries the graph constraints collected
 * from that same release's root, so the two can never disagree.
 */
export const pinned = (release: {
  readonly id: string;
  readonly root: ConfigNode.ConfigNode;
}): Effect.Effect<
  {
    readonly configSnapshot: string;
    readonly enforce: { readonly constraints: ReadonlyArray<Rule> };
  },
  InvalidGraphConstraintError | DuplicateGraphConstraintError
> =>
  Effect.map(collect(release.root), (definitions) => ({
    configSnapshot: release.id,
    enforce: enforcement(definitions),
  }));

const pathOf = (attribute: string): string => `$[${JSON.stringify(attribute)}]`;

const tripleValueKey = (
  triple: Triple,
): Effect.Effect<string, CanonicalJson.CanonicalEncodingError> =>
  CanonicalJson.encode(
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

/** Evaluate graph constraints at one bitemporal basis without mutating the store. */
export const evaluate = (
  triples: TriplesService,
  definitions: ReadonlyArray<Definition>,
  basis?: TemporalBasis,
): Effect.Effect<ReadonlyArray<Violation>, ReadError | CanonicalJson.CanonicalEncodingError> =>
  Effect.gen(function* () {
    const byType = new Map<string, Definition[]>();
    for (const item of definitions) {
      const current = byType.get(item.rule.entityType) ?? [];
      current.push(item);
      byType.set(item.rule.entityType, current);
    }

    const violations: Violation[] = [];
    for (const [entityType, constraints] of [...byType].sort(([a], [b]) => a.localeCompare(b))) {
      const typedFacts = yield* triples.match({ entityType }, basis);
      const subjects = [...new Set(typedFacts.map((fact) => fact.entityId))].sort();
      const entityRows = yield* triples.entities(subjects.map(unsafe.entityId), basis);
      const facts = entityRows.flat();
      const bySubject = new Map<string, Triple[]>();
      for (const fact of facts) {
        const rows = bySubject.get(fact.entityId) ?? [];
        rows.push(fact);
        bySubject.set(fact.entityId, rows);
      }

      for (const item of constraints.sort((a, b) => a.key.localeCompare(b.key))) {
        const { rule } = item;
        if (rule._tag === "Required" || rule._tag === "Cardinality") {
          for (const subject of subjects) {
            const count = (bySubject.get(subject) ?? []).filter(
              (fact) => fact.attribute === rule.attribute,
            ).length;
            if (rule._tag === "Required" && count === 0) {
              violations.push({
                constraintKey: item.key,
                code: "required",
                subject,
                entityType,
                attribute: rule.attribute,
                path: pathOf(rule.attribute),
                message: `${entityType} requires ${rule.attribute}`,
              });
            }
            if (rule._tag === "Cardinality" && count > rule.max) {
              violations.push({
                constraintKey: item.key,
                code: "cardinality",
                subject,
                entityType,
                attribute: rule.attribute,
                path: pathOf(rule.attribute),
                message: `${entityType}.${rule.attribute} has ${count} live values; maximum cardinality is ${rule.max}`,
              });
            }
          }
          continue;
        }

        if (rule._tag === "Unique") {
          const claims = new Map<string, Set<string>>();
          for (const fact of facts) {
            if (fact.attribute !== rule.attribute) continue;
            const valueKey = yield* tripleValueKey(fact);
            const subjectsForValue = claims.get(valueKey) ?? new Set<string>();
            subjectsForValue.add(fact.entityId);
            claims.set(valueKey, subjectsForValue);
          }
          for (const duplicateSubjects of claims.values()) {
            if (duplicateSubjects.size < 2) continue;
            const ordered = [...duplicateSubjects].sort();
            for (const subject of ordered) {
              violations.push({
                constraintKey: item.key,
                code: "unique",
                subject,
                entityType,
                attribute: rule.attribute,
                path: pathOf(rule.attribute),
                message: `${entityType}.${rule.attribute} must be unique; the value is also used by ${ordered.filter((candidate) => candidate !== subject).join(", ")}`,
              });
            }
          }
          continue;
        }

        const sourceFacts = facts.filter((fact) => fact.attribute === rule.attribute);
        const sourceRefs = sourceFacts.filter(
          (
            fact,
          ): fact is Triple & {
            readonly value: { readonly type: "ref"; readonly value: string };
          } => fact.attribute === rule.attribute && fact.value.type === "ref",
        );
        const targetIds = [...new Set(sourceRefs.map((fact) => fact.value.value))].sort();
        const targetRows = yield* triples.entities(targetIds.map(unsafe.entityId), basis);
        const validTargets = new Set(
          targetIds.filter((_, index) =>
            targetRows[index]!.some(
              (fact) =>
                Option.isSome(fact.entityType) && fact.entityType.value === rule.targetEntityType,
            ),
          ),
        );
        for (const fact of sourceFacts) {
          if (fact.value.type !== "ref") {
            violations.push({
              constraintKey: item.key,
              code: "reference-target",
              subject: fact.entityId,
              entityType,
              attribute: rule.attribute,
              path: pathOf(rule.attribute),
              message: `${entityType}.${rule.attribute} must contain a reference to a ${rule.targetEntityType}`,
            });
            continue;
          }
          if (validTargets.has(fact.value.value)) continue;
          violations.push({
            constraintKey: item.key,
            code: "reference-target",
            subject: fact.entityId,
            entityType,
            attribute: rule.attribute,
            path: pathOf(rule.attribute),
            message: `${entityType}.${rule.attribute} references ${fact.value.value}, which is not a live ${rule.targetEntityType}`,
          });
        }
      }
    }

    return violations.sort(
      (left, right) =>
        left.entityType.localeCompare(right.entityType) ||
        left.subject.localeCompare(right.subject) ||
        left.path.localeCompare(right.path) ||
        left.code.localeCompare(right.code) ||
        left.constraintKey.localeCompare(right.constraintKey),
    );
  });
