/**
 * Validation of ordinary Triple entities against deployed runtime types.
 *
 * A validation is an observation, not a mutable flag on the entity. Results
 * and individual violations are immutable, content-addressed facts. A small
 * head entity identifies the latest result for `(ref, entity type, subject)`;
 * moving that head is atomic, while the old result remains queryable forever.
 */

import { Context, Data, Effect, Layer, Result, Schema, SchemaIssue } from "effect";

import type { DatalogQuery } from "../datalog/types.js";
import type {
  CommandAlreadyCommittedError,
  ConstraintViolationError,
  DatalogQueryError,
  ReadError,
  TransactionConflictError,
  WriteError,
} from "../errors/index.js";
import { Triples } from "../store/Triples.js";
import type { TransactionResult } from "../store/Triples.js";
import { transactSystem } from "../store/systemNamespace.js";
import type { Triple, TransactOp } from "../Triple.js";
import type { TripleValue } from "../Value.js";
import * as CanonicalJson from "../content/CanonicalJson.js";
import * as ContentId from "../content/ContentId.js";
import * as ConfigNode from "./ConfigNode.js";
import * as ConfigStore from "./ConfigStore.js";
import * as GraphConstraint from "./GraphConstraint.js";
import * as TypeExpr from "./TypeExpr.js";
import * as TypeSchema from "./TypeSchema.js";
import { unsafe, type EntityId, type TripleId } from "../Branded.js";

export const ENTITY_SCHEMA_KIND = "entity-schema";

export const System = {
  prefix: "_triplex/validation/",
  entityType: {
    result: "triplex.validation-result",
    violation: "triplex.validation-violation",
    head: "triplex.validation-head",
    run: "triplex.validation-run",
    checkpoint: "triplex.validation-checkpoint",
  },
  attribute: {
    contentId: ":triplex/content-id",
    ref: ":triplex/validation-ref",
    result: ":triplex/validation-result",
    runRef: ":triplex/validation-run-ref",
    runResult: ":triplex/validation-run-result",
    subject: ":triplex/validation-subject",
    entityType: ":triplex/validation-entity-type",
    schema: ":triplex/validation-schema",
    snapshot: ":triplex/validation-snapshot",
    snapshotRoot: ":triplex/validation-snapshot-root",
    valid: ":triplex/validation-valid",
    stateContentId: ":triplex/validation-state-content-id",
    sourcePosition: ":triplex/validation-source-position",
    code: ":triplex/validation-code",
    path: ":triplex/validation-path",
    message: ":triplex/validation-message",
    constraint: ":triplex/validation-constraint",
  },
} as const;

const encodePart = (value: string): string => encodeURIComponent(value);

export const entityId = {
  result: (cid: ContentId.ContentId): EntityId => unsafe.entityId(`${System.prefix}result/${cid}`),
  violation: (cid: ContentId.ContentId): EntityId =>
    unsafe.entityId(`${System.prefix}violation/${cid}`),
  run: (cid: ContentId.ContentId): EntityId => unsafe.entityId(`${System.prefix}run/${cid}`),
  checkpoint: (ref: string): EntityId =>
    unsafe.entityId(`${System.prefix}checkpoint/${encodePart(ref)}`),
  head: (ref: string, entityType: string, subject: string) =>
    unsafe.entityId(
      `${System.prefix}head/${encodePart(ref)}/${encodePart(entityType)}/${encodePart(subject)}`,
    ),
};

export interface EntitySchemaDefinition {
  readonly entityType: string;
  readonly type: TypeExpr.TypeExpr;
}

/** Define the runtime shape of entities carrying `entityType`. */
export const define = (
  entityType: string,
  type: TypeExpr.TypeExpr,
): Effect.Effect<
  ConfigNode.ConfigNode,
  ConfigNode.DuplicateChildKeyError | CanonicalJson.CanonicalEncodingError
> =>
  ConfigNode.make({
    kind: ENTITY_SCHEMA_KIND,
    key: entityType,
    attrs: { entityType, type } as unknown as CanonicalJson.CanonicalValue,
  });

export interface ValidationViolation {
  readonly id: ContentId.ContentId;
  readonly resultId: ContentId.ContentId;
  readonly subject: string;
  readonly entityType: string;
  readonly schemaId: ContentId.ContentId;
  readonly snapshotId: string;
  readonly code: "schema" | GraphConstraint.Code;
  readonly path: string;
  readonly message: string;
  readonly constraintKey?: string;
}

export interface ValidationResult {
  readonly id: ContentId.ContentId;
  readonly subject: string;
  readonly entityType: string;
  readonly schemaId: ContentId.ContentId;
  readonly snapshotId: string;
  readonly snapshotRootCid: ContentId.ContentId;
  readonly valid: boolean;
  /** Commitment to `state`; the materialized state itself is not persisted. */
  readonly stateCid: ContentId.ContentId;
  readonly state: CanonicalJson.CanonicalValue;
  readonly violations: ReadonlyArray<ValidationViolation>;
}

export interface ValidationRun {
  readonly id: ContentId.ContentId;
  readonly ref: string;
  readonly snapshotId: string;
  readonly snapshotRootCid: ContentId.ContentId;
  /** Last non-validation transaction visible when this projection began. */
  readonly sourcePosition: number;
  readonly results: ReadonlyArray<ValidationResult>;
  /** Undefined when an identical run was already materialized. */
  readonly transaction: TransactionResult | undefined;
}

export interface InvalidEntity {
  readonly subject: string;
  readonly resultEntityId: string;
  readonly schemaId: ContentId.ContentId;
  readonly snapshotEntityId: string;
}

export interface CurrentValidation {
  readonly status: "current" | "stale" | "unvalidated";
  /** Last non-validation transaction incorporated by the projection. */
  readonly sourcePosition?: number;
  /** Latest non-validation transaction currently present in the store. */
  readonly currentPosition: number;
  /** Last known invalid entities. Stale results are never presented as current. */
  readonly invalid: ReadonlyArray<InvalidEntity>;
}

export interface StoredViolation {
  readonly violationEntityId: string;
  readonly resultEntityId: string;
  readonly subject: string;
  readonly entityType: string;
  readonly code: "schema" | GraphConstraint.Code;
  readonly path: string;
  readonly message: string;
}

const isViolationCode = (value: unknown): value is StoredViolation["code"] =>
  value === "schema" ||
  value === "required" ||
  value === "cardinality" ||
  value === "unique" ||
  value === "reference-target";

export class UnknownValidationRefError extends Data.TaggedError("UnknownValidationRefError")<{
  readonly ref: string;
  readonly message: string;
}> {}

export class InvalidEntitySchemaError extends Data.TaggedError("InvalidEntitySchemaError")<{
  readonly key: string;
  readonly message: string;
}> {}

export type RevalidateError =
  | ReadError
  | WriteError
  | TransactionConflictError
  | CommandAlreadyCommittedError
  | ConstraintViolationError
  | ConfigStore.LoadError
  | UnknownValidationRefError
  | InvalidEntitySchemaError
  | GraphConstraint.InvalidGraphConstraintError
  | GraphConstraint.DuplicateGraphConstraintError
  | CanonicalJson.CanonicalEncodingError;

export interface EntityValidationService {
  readonly revalidate: (input: {
    readonly ref: string;
  }) => Effect.Effect<ValidationRun, RevalidateError>;
  readonly currentInvalid: (
    ref: string,
  ) => Effect.Effect<CurrentValidation, ReadError | DatalogQueryError>;
  readonly everInvalid: () => Effect.Effect<ReadonlyArray<string>, ReadError | DatalogQueryError>;
  readonly violations: (input?: {
    readonly subject?: string;
    readonly resultEntityId?: string;
  }) => Effect.Effect<ReadonlyArray<StoredViolation>, ReadError | DatalogQueryError>;
}

export class EntityValidation extends Context.Service<EntityValidation, EntityValidationService>()(
  "triplex/EntityValidation",
) {}

const DefinitionSchema = Schema.Struct({
  entityType: Schema.String,
  type: TypeExpr.TypeExprSchema,
});

const parseDefinition = (
  node: ConfigNode.ConfigNode,
): Effect.Effect<EntitySchemaDefinition, InvalidEntitySchemaError> => {
  const result = Schema.decodeUnknownResult(DefinitionSchema)(node.attrs);
  if (Result.isSuccess(result) && result.success.entityType === node.key) {
    return Effect.succeed(result.success);
  }
  return Effect.fail(
    new InvalidEntitySchemaError({
      key: node.key,
      message: Result.isFailure(result)
        ? `Invalid entity schema ${node.key}: ${result.failure.message}`
        : `Invalid entity schema ${node.key}: key and entityType must match`,
    }),
  );
};

const assertOp = (
  id: string,
  entityType: string,
  attribute: string,
  value: TripleValue | { readonly type: "ref"; readonly value: string },
): TransactOp => ({
  op: "assert",
  entityId: unsafe.entityId(id),
  entityType,
  attribute,
  value: value.type === "ref" ? { ...value, value: unsafe.entityId(value.value) } : value,
});

const nativeValue = (value: TripleValue): CanonicalJson.CanonicalValue => {
  if (value.type === "blob") {
    return {
      hash: value.value,
      mimeType: value.mimeType,
      size: value.size,
      ...(value.filename !== undefined && { filename: value.filename }),
    };
  }
  return value.value as CanonicalJson.CanonicalValue;
};

const materialize = (
  triples: ReadonlyArray<Triple>,
  type: TypeExpr.TypeExpr,
): Effect.Effect<CanonicalJson.CanonicalValue, CanonicalJson.CanonicalEncodingError> =>
  Effect.gen(function* () {
    const byAttribute = new Map<string, CanonicalJson.CanonicalValue[]>();
    for (const triple of triples) {
      const values = byAttribute.get(triple.attribute) ?? [];
      values.push(nativeValue(triple.value));
      byAttribute.set(triple.attribute, values);
    }

    const state: Record<string, CanonicalJson.CanonicalValue> = {};
    for (const [attribute, unsorted] of [...byAttribute].sort(([a], [b]) => a.localeCompare(b))) {
      const encoded = yield* Effect.forEach(unsorted, (value) =>
        CanonicalJson.encode(value).pipe(Effect.map((canonical) => ({ canonical, value }))),
      );
      const values = [...encoded]
        .sort((a, b) => a.canonical.localeCompare(b.canonical))
        .map(({ value }) => value);
      const fieldType = type._tag === "Struct" ? type.fields[attribute]?.type : undefined;
      const expectsList = (expr: TypeExpr.TypeExpr | undefined): boolean => {
        if (!expr) return false;
        if (expr._tag === "List") return true;
        if (expr._tag === "Constrained") return expectsList(expr.base);
        if (expr._tag === "Union") return expr.members.some(expectsList);
        return false;
      };
      state[attribute] = expectsList(fieldType) || values.length !== 1 ? values : values[0]!;
    }
    return state;
  });

const formatPath = (
  path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined,
): string => {
  if (!path || path.length === 0) return "$";
  return path.reduce<string>((out, part) => {
    const key = typeof part === "object" ? part.key : part;
    if (typeof key === "number") return `${out}[${key}]`;
    const name = String(key);
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
      ? `${out}.${name}`
      : `${out}[${JSON.stringify(name)}]`;
  }, "$");
};

interface ValidationIssue {
  readonly code: "schema" | GraphConstraint.Code;
  readonly path: string;
  readonly message: string;
  readonly constraintKey?: string;
}

const validationIssues = (
  type: TypeExpr.TypeExpr,
  state: CanonicalJson.CanonicalValue,
): ReadonlyArray<ValidationIssue> => {
  const decoded = Schema.decodeUnknownResult(TypeSchema.compile(type))(state);
  if (Result.isSuccess(decoded)) return [];
  return SchemaIssue.makeFormatterStandardSchemaV1()(decoded.failure.issue).issues.map((issue) => ({
    code: "schema" as const,
    path: formatPath(issue.path),
    message: issue.message,
  }));
};

const grouped = (triples: ReadonlyArray<Triple>): ReadonlyMap<string, ReadonlyArray<Triple>> => {
  const out = new Map<string, Triple[]>();
  for (const triple of triples) {
    const rows = out.get(triple.entityId) ?? [];
    rows.push(triple);
    out.set(triple.entityId, rows);
  }
  return out;
};

const stringValue = (triple: Triple | undefined): string | undefined =>
  triple?.value.type === "string" || triple?.value.type === "ref" ? triple.value.value : undefined;

const rowsAt = (rows: ReadonlyArray<Triple>, attribute: string): ReadonlyArray<Triple> =>
  rows.filter((row) => row.attribute === attribute);

const numberValue = (triple: Triple | undefined): number | undefined =>
  triple?.value.type === "number" ? triple.value.value : undefined;

export const currentInvalidQuery = (ref: string): DatalogQuery => ({
  find: ["?subject", "?result", "?schema", "?snapshot"],
  where: [
    [ConfigStore.entityId.ref(ref), ConfigStore.System.attribute.target, "?snapshot"],
    ["?head", System.attribute.ref, ref],
    ["?head", System.attribute.result, "?result"],
    ["?result", System.attribute.snapshot, "?snapshot"],
    ["?result", System.attribute.valid, false],
    ["?result", System.attribute.subject, "?subject"],
    ["?result", System.attribute.schema, "?schema"],
  ],
});

/** Last materialized invalid observations for a ref, even when now stale. */
export const lastInvalidQuery = (ref: string): DatalogQuery => ({
  find: ["?subject", "?result", "?schema", "?snapshot"],
  where: [
    ["?head", System.attribute.ref, ref],
    ["?head", System.attribute.result, "?result"],
    ["?result", System.attribute.snapshot, "?snapshot"],
    ["?result", System.attribute.valid, false],
    ["?result", System.attribute.subject, "?subject"],
    ["?result", System.attribute.schema, "?schema"],
  ],
});

export const everInvalidQuery = (): DatalogQuery => ({
  find: ["?subject"],
  where: [
    ["?result", System.attribute.valid, false],
    ["?result", System.attribute.subject, "?subject"],
  ],
});

export const violationsQuery = (
  input: {
    readonly subject?: string;
    readonly resultEntityId?: string;
  } = {},
): DatalogQuery => {
  const where: DatalogQuery["where"] = [
    ["?violation", System.attribute.result, "?result"],
    ["?violation", System.attribute.subject, "?subject"],
    ["?violation", System.attribute.code, "?code"],
    ["?violation", System.attribute.path, "?path"],
    ["?violation", System.attribute.message, "?message"],
    ["?result", System.attribute.entityType, "?entityType"],
  ];
  return {
    find: ["?violation", "?result", "?subject", "?entityType", "?code", "?path", "?message"],
    where: [
      ...where,
      ...(input.resultEntityId === undefined
        ? []
        : [
            [
              "?violation",
              System.attribute.result,
              { type: "ref", value: input.resultEntityId },
            ] as const,
          ]),
      ...(input.subject === undefined
        ? []
        : [
            [
              "?violation",
              System.attribute.subject,
              { type: "ref", value: input.subject },
            ] as const,
          ]),
    ],
  };
};

const invalidFromRows = (
  rows: ReadonlyArray<Readonly<Record<string, string | number | boolean | null>>>,
): ReadonlyArray<InvalidEntity> =>
  rows.flatMap((row) => {
    const subject = row["?subject"];
    const resultEntityId = row["?result"];
    const schemaId = row["?schema"];
    const snapshotEntityId = row["?snapshot"];
    return typeof subject === "string" &&
      typeof resultEntityId === "string" &&
      typeof schemaId === "string" &&
      ContentId.isContentId(schemaId) &&
      typeof snapshotEntityId === "string"
      ? [{ subject, resultEntityId, schemaId, snapshotEntityId }]
      : [];
  });

const makeService = Effect.gen(function* () {
  const triples = yield* Triples;
  const config = yield* ConfigStore.ConfigStore;

  const latestSourcePosition = Effect.gen(function* () {
    let after = 0;
    let latest = 0;
    while (true) {
      const page = yield* triples.transactions({ after, limit: 1_000 });
      for (const transaction of page.transactions) {
        if (transaction.actor !== "triplex/entity-validation") {
          latest = transaction.position;
        }
      }
      if (page.next === undefined || page.next <= after || page.transactions.length < 1_000) {
        return latest;
      }
      after = page.next;
    }
  });

  const revalidate: EntityValidationService["revalidate"] = ({ ref }) =>
    Effect.gen(function* () {
      const snapshot = yield* config.resolveRef(ref);
      if (!snapshot) {
        return yield* new UnknownValidationRefError({
          ref,
          message: `Cannot validate entities because config ref ${ref} does not exist`,
        });
      }
      const sourcePosition = yield* latestSourcePosition;

      const definitions: EntitySchemaDefinition[] = [];
      const definedEntityTypes = new Set<string>();
      for (const { node } of ConfigNode.walk(snapshot.root)) {
        if (node.kind !== ENTITY_SCHEMA_KIND) continue;
        const definition = yield* parseDefinition(node);
        if (definedEntityTypes.has(definition.entityType)) {
          return yield* new InvalidEntitySchemaError({
            key: definition.entityType,
            message: `Config snapshot ${snapshot.id} contains more than one schema for ${definition.entityType}`,
          });
        }
        definedEntityTypes.add(definition.entityType);
        definitions.push(definition);
      }
      const graphConstraints = yield* GraphConstraint.collect(snapshot.root);
      const graphViolations = yield* GraphConstraint.evaluate(triples, graphConstraints);
      const graphIssuesBySubject = new Map<string, GraphConstraint.Violation[]>();
      for (const violation of graphViolations) {
        const key = `${violation.entityType}\u0000${violation.subject}`;
        const current = graphIssuesBySubject.get(key) ?? [];
        current.push(violation);
        graphIssuesBySubject.set(key, current);
      }

      const checkpointEntity = entityId.checkpoint(ref);
      const [resultRows, violationRows, headRows, runRows, checkpointRows] = yield* Effect.all([
        triples.match({ entityType: System.entityType.result }),
        triples.match({ entityType: System.entityType.violation }),
        triples.match({ entityType: System.entityType.head }),
        triples.match({ entityType: System.entityType.run }),
        triples.match({ entityId: checkpointEntity }),
      ]);
      const knownResults = new Set<string>(resultRows.map((row) => row.entityId));
      const knownViolations = new Set<string>(violationRows.map((row) => row.entityId));
      const knownRuns = new Set<string>(runRows.map((row) => row.entityId));
      const heads = grouped(headRows);
      const refHeads = new Map<string, ReadonlyArray<Triple>>(
        [...heads].filter(([, rows]) =>
          rowsAt(rows, System.attribute.ref).some((row) => stringValue(row) === ref),
        ),
      );

      const operations: TransactOp[] = [];
      const preconditions: Array<{ readonly _tag: "TripleLive"; readonly id: TripleId }> = [];
      const results: ValidationResult[] = [];
      const activeHeads = new Set<string>();
      const snapshotEntity = ConfigStore.entityId.snapshot(snapshot.id);

      for (const definition of definitions.sort((a, b) =>
        a.entityType.localeCompare(b.entityType),
      )) {
        const schemaId = TypeExpr.id(definition.type);
        const matching = yield* triples.match({ entityType: definition.entityType });
        const subjects = [...new Set(matching.map((row) => row.entityId))].sort();

        for (const subject of subjects) {
          const state = yield* materialize(yield* triples.entity(subject), definition.type);
          const stateCid = ContentId.hash(
            ContentId.Domain.validationState,
            yield* CanonicalJson.encode(state),
          );
          const graphIssues =
            graphIssuesBySubject.get(`${definition.entityType}\u0000${subject}`) ?? [];
          const graphOwnedPaths = new Set(
            graphIssues
              .filter((issue) => issue.code === "required" || issue.code === "cardinality")
              .map((issue) => issue.path),
          );
          const issues: ValidationIssue[] = [
            ...validationIssues(definition.type, state).filter(
              (issue) => !graphOwnedPaths.has(issue.path),
            ),
            ...graphIssues.map((issue) => ({
              code: issue.code,
              path: issue.path,
              message: issue.message,
              constraintKey: issue.constraintKey,
            })),
          ].sort(
            (left, right) =>
              left.path.localeCompare(right.path) ||
              left.code.localeCompare(right.code) ||
              left.message.localeCompare(right.message),
          );
          const resultEncoded = yield* CanonicalJson.encode({
            v: 1,
            subject,
            entityType: definition.entityType,
            schemaId,
            snapshotId: snapshot.id,
            snapshotRootCid: snapshot.rootCid,
            stateCid,
            issues: issues.map((issue) => ({
              code: issue.code,
              path: issue.path,
              message: issue.message,
              ...(issue.constraintKey === undefined ? {} : { constraintKey: issue.constraintKey }),
            })),
          });
          const resultId = ContentId.hash(ContentId.Domain.validationResult, resultEncoded);
          const resultEntity = entityId.result(resultId);
          const violations: ValidationViolation[] = [];

          for (const [index, issue] of issues.entries()) {
            const violationEncoded = yield* CanonicalJson.encode({
              v: 1,
              resultId,
              index,
              code: issue.code,
              path: issue.path,
              message: issue.message,
              ...(issue.constraintKey === undefined ? {} : { constraintKey: issue.constraintKey }),
            });
            const id = ContentId.hash(ContentId.Domain.validationViolation, violationEncoded);
            const violation: ValidationViolation = {
              id,
              resultId,
              subject,
              entityType: definition.entityType,
              schemaId,
              snapshotId: snapshot.id,
              code: issue.code,
              path: issue.path,
              message: issue.message,
              ...(issue.constraintKey === undefined ? {} : { constraintKey: issue.constraintKey }),
            };
            violations.push(violation);

            const violationEntity = entityId.violation(id);
            if (!knownViolations.has(violationEntity)) {
              operations.push(
                assertOp(violationEntity, System.entityType.violation, System.attribute.contentId, {
                  type: "string",
                  value: id,
                }),
                assertOp(violationEntity, System.entityType.violation, System.attribute.result, {
                  type: "ref",
                  value: resultEntity,
                }),
                assertOp(violationEntity, System.entityType.violation, System.attribute.subject, {
                  type: "ref",
                  value: subject,
                }),
                assertOp(violationEntity, System.entityType.violation, System.attribute.code, {
                  type: "string",
                  value: violation.code,
                }),
                assertOp(violationEntity, System.entityType.violation, System.attribute.path, {
                  type: "string",
                  value: violation.path,
                }),
                assertOp(violationEntity, System.entityType.violation, System.attribute.message, {
                  type: "string",
                  value: violation.message,
                }),
                ...(violation.constraintKey === undefined
                  ? []
                  : [
                      assertOp(
                        violationEntity,
                        System.entityType.violation,
                        System.attribute.constraint,
                        { type: "string", value: violation.constraintKey },
                      ),
                    ]),
              );
              knownViolations.add(violationEntity);
            }
          }

          const result: ValidationResult = {
            id: resultId,
            subject,
            entityType: definition.entityType,
            schemaId,
            snapshotId: snapshot.id,
            snapshotRootCid: snapshot.rootCid,
            valid: issues.length === 0,
            stateCid,
            state,
            violations,
          };
          results.push(result);

          if (!knownResults.has(resultEntity)) {
            operations.push(
              assertOp(resultEntity, System.entityType.result, System.attribute.contentId, {
                type: "string",
                value: resultId,
              }),
              assertOp(resultEntity, System.entityType.result, System.attribute.subject, {
                type: "ref",
                value: subject,
              }),
              assertOp(resultEntity, System.entityType.result, System.attribute.entityType, {
                type: "string",
                value: definition.entityType,
              }),
              assertOp(resultEntity, System.entityType.result, System.attribute.schema, {
                type: "string",
                value: schemaId,
              }),
              assertOp(resultEntity, System.entityType.result, System.attribute.snapshot, {
                type: "ref",
                value: snapshotEntity,
              }),
              assertOp(resultEntity, System.entityType.result, System.attribute.snapshotRoot, {
                type: "string",
                value: snapshot.rootCid,
              }),
              assertOp(resultEntity, System.entityType.result, System.attribute.valid, {
                type: "boolean",
                value: result.valid,
              }),
              assertOp(resultEntity, System.entityType.result, System.attribute.stateContentId, {
                type: "string",
                value: stateCid,
              }),
            );
            knownResults.add(resultEntity);
          }

          const head = entityId.head(ref, definition.entityType, subject);
          activeHeads.add(head);
          const oldTargets = rowsAt(refHeads.get(head) ?? [], System.attribute.result);
          if (!oldTargets.some((row) => stringValue(row) === resultEntity)) {
            preconditions.push(
              ...oldTargets.map((row) => ({ _tag: "TripleLive" as const, id: row.id })),
            );
            operations.push(...oldTargets.map((row) => ({ op: "retract", id: row.id }) as const));
            if (!refHeads.has(head)) {
              operations.push(
                assertOp(head, System.entityType.head, System.attribute.ref, {
                  type: "string",
                  value: ref,
                }),
                assertOp(head, System.entityType.head, System.attribute.subject, {
                  type: "ref",
                  value: subject,
                }),
                assertOp(head, System.entityType.head, System.attribute.entityType, {
                  type: "string",
                  value: definition.entityType,
                }),
              );
            }
            operations.push(
              assertOp(head, System.entityType.head, System.attribute.result, {
                type: "ref",
                value: resultEntity,
              }),
            );
          }
        }
      }

      for (const [head, rows] of refHeads) {
        if (activeHeads.has(head)) continue;
        preconditions.push(
          ...rowsAt(rows, System.attribute.result).map((row) => ({
            _tag: "TripleLive" as const,
            id: row.id,
          })),
        );
        operations.push(
          ...rowsAt(rows, System.attribute.result).map(
            (row) => ({ op: "retract", id: row.id }) as const,
          ),
        );
      }

      results.sort(
        (a, b) => a.entityType.localeCompare(b.entityType) || a.subject.localeCompare(b.subject),
      );
      const runEncoded = yield* CanonicalJson.encode({
        v: 1,
        ref,
        snapshotRootCid: snapshot.rootCid,
        sourcePosition,
        results: results.map((result) => result.id),
      });
      const runId = ContentId.hash(ContentId.Domain.validationRun, runEncoded);
      const runEntity = entityId.run(runId);
      if (!knownRuns.has(runEntity)) {
        operations.push(
          assertOp(runEntity, System.entityType.run, System.attribute.contentId, {
            type: "string",
            value: runId,
          }),
          assertOp(runEntity, System.entityType.run, System.attribute.runRef, {
            type: "string",
            value: ref,
          }),
          assertOp(runEntity, System.entityType.run, System.attribute.snapshot, {
            type: "ref",
            value: snapshotEntity,
          }),
          assertOp(runEntity, System.entityType.run, System.attribute.sourcePosition, {
            type: "number",
            value: sourcePosition,
          }),
          ...results.map((result) =>
            assertOp(runEntity, System.entityType.run, System.attribute.runResult, {
              type: "ref",
              value: entityId.result(result.id),
            }),
          ),
        );
      }

      const oldCheckpointRun = rowsAt(checkpointRows, System.attribute.result);
      const oldCheckpointSnapshot = rowsAt(checkpointRows, System.attribute.snapshot);
      const oldCheckpointPosition = rowsAt(checkpointRows, System.attribute.sourcePosition);
      const checkpointIsCurrent =
        oldCheckpointRun.some((row) => stringValue(row) === runEntity) &&
        oldCheckpointSnapshot.some((row) => stringValue(row) === snapshotEntity) &&
        oldCheckpointPosition.some((row) => numberValue(row) === sourcePosition);
      if (!checkpointIsCurrent) {
        const movingCheckpointFacts = [
          ...oldCheckpointRun,
          ...oldCheckpointSnapshot,
          ...oldCheckpointPosition,
        ];
        preconditions.push(
          ...movingCheckpointFacts.map((row) => ({
            _tag: "TripleLive" as const,
            id: row.id,
          })),
        );
        operations.push(
          ...movingCheckpointFacts.map((row) => ({ op: "retract", id: row.id }) as const),
        );
        if (checkpointRows.length === 0) {
          operations.push(
            assertOp(checkpointEntity, System.entityType.checkpoint, System.attribute.ref, {
              type: "string",
              value: ref,
            }),
          );
        }
        operations.push(
          assertOp(checkpointEntity, System.entityType.checkpoint, System.attribute.result, {
            type: "ref",
            value: runEntity,
          }),
          assertOp(checkpointEntity, System.entityType.checkpoint, System.attribute.snapshot, {
            type: "ref",
            value: snapshotEntity,
          }),
          assertOp(
            checkpointEntity,
            System.entityType.checkpoint,
            System.attribute.sourcePosition,
            { type: "number", value: sourcePosition },
          ),
        );
      }

      const transaction =
        operations.length === 0
          ? undefined
          : yield* transactSystem(triples, operations, {
              actor: "triplex/entity-validation",
              configSnapshot: snapshot.id,
              preconditions,
            });
      return {
        id: runId,
        ref,
        snapshotId: snapshot.id,
        snapshotRootCid: snapshot.rootCid,
        sourcePosition,
        results,
        transaction,
      };
    });

  const service: EntityValidationService = {
    revalidate,
    currentInvalid: (ref: string) =>
      Effect.gen(function* () {
        const checkpointEntity = entityId.checkpoint(ref);
        const [checkpointRows, refRows, invalidResponse, currentPosition] = yield* Effect.all([
          triples.match({ entityId: checkpointEntity }),
          triples.match({ entityId: ConfigStore.entityId.ref(ref) }),
          triples.queryAll(lastInvalidQuery(ref)),
          latestSourcePosition,
        ]);
        const sourcePosition = numberValue(
          rowsAt(checkpointRows, System.attribute.sourcePosition)[0],
        );
        const checkpointSnapshot = stringValue(
          rowsAt(checkpointRows, System.attribute.snapshot)[0],
        );
        const currentSnapshot = stringValue(
          rowsAt(refRows, ConfigStore.System.attribute.target)[0],
        );
        const invalid = [...invalidFromRows(invalidResponse.results)].sort(
          (a, b) =>
            a.subject.localeCompare(b.subject) || a.resultEntityId.localeCompare(b.resultEntityId),
        );
        if (sourcePosition === undefined || checkpointSnapshot === undefined) {
          return { status: "unvalidated" as const, currentPosition, invalid: [] };
        }
        const status =
          checkpointSnapshot === currentSnapshot && sourcePosition === currentPosition
            ? ("current" as const)
            : ("stale" as const);
        return { status, sourcePosition, currentPosition, invalid };
      }),
    everInvalid: () =>
      triples.queryAll(everInvalidQuery()).pipe(
        Effect.map((response) =>
          response.results
            .map((row) => row["?subject"])
            .filter((subject): subject is string => typeof subject === "string")
            .sort(),
        ),
      ),
    violations: (input?: { readonly subject?: string; readonly resultEntityId?: string }) =>
      triples.queryAll(violationsQuery(input)).pipe(
        Effect.map((response) =>
          response.results
            .flatMap((row) => {
              const violationEntityId = row["?violation"];
              const resultEntityId = row["?result"];
              const subject = row["?subject"];
              const entityType = row["?entityType"];
              const code = row["?code"];
              const path = row["?path"];
              const message = row["?message"];
              return typeof violationEntityId === "string" &&
                typeof resultEntityId === "string" &&
                typeof subject === "string" &&
                typeof entityType === "string" &&
                isViolationCode(code) &&
                typeof path === "string" &&
                typeof message === "string"
                ? [
                    {
                      violationEntityId,
                      resultEntityId,
                      subject,
                      entityType,
                      code,
                      path,
                      message,
                    },
                  ]
                : [];
            })
            .sort(
              (a, b) =>
                a.subject.localeCompare(b.subject) ||
                a.path.localeCompare(b.path) ||
                a.violationEntityId.localeCompare(b.violationEntityId),
            ),
        ),
      ),
  };
  return service;
});

export const layer: Layer.Layer<EntityValidation, never, Triples | ConfigStore.ConfigStore> =
  Layer.effect(EntityValidation, makeService);
