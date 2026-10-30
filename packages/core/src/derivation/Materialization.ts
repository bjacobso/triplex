/**
 * Durable, rebuildable checkpoints for derivation candidates.
 *
 * Runs and candidate revisions are immutable. The logical head is selected by
 * `(sourcePosition, materializationPosition)`, so concurrent writers cannot
 * corrupt a mutable pointer or make an older source position current merely by
 * committing later. A run is one atomic Triples transaction.
 */

import { Data, Effect, Option, Schema } from "effect";

import * as CanonicalJson from "../content/CanonicalJson.js";
import * as ContentIds from "../content/ContentId.js";
import { EntityId, TransactionId, TripleId, unsafe } from "../Branded.js";
import { Constant as ConstantSchema } from "../datalog/schema.js";
import type { Constant, DatalogQuery } from "../datalog/types.js";
import type {
  CommandAlreadyCommittedError,
  ConstraintViolationError,
  DatalogQueryError,
  ReadError,
  TransactionConflictError,
  WriteError,
} from "../errors/index.js";
import { transactSystem } from "../store/systemNamespace.js";
import type { TransactionRecord, TransactionResult, TriplesService } from "../store/Triples.js";
import type { Triple, TransactOp } from "../Triple.js";
import type { TripleValue } from "../Value.js";
import {
  CandidateConflictError,
  type Candidate,
  type Definition,
  type EvaluateOptions,
  type Reconciliation,
  type SourceFact,
  candidateIdentityId,
  candidateRevisionId,
  evaluate,
  reconcile,
} from "./Derivation.js";

export const System = {
  prefix: "_triplex/derivation/",
  entityType: {
    candidate: "triplex.derivation-candidate",
    run: "triplex.derivation-run",
  },
  attribute: {
    contentId: ":triplex/content-id",
    name: ":triplex/derivation-name",
    definition: ":triplex/derivation-definition",
    configSnapshot: ":triplex/derivation-config-snapshot",
    candidateId: ":triplex/derivation-candidate-id",
    candidateBody: ":triplex/derivation-candidate-body",
    runCandidate: ":triplex/derivation-run-candidate",
    formatVersion: ":triplex/derivation-format-version",
    sourcePosition: ":triplex/derivation-source-position",
    validAt: ":triplex/derivation-valid-at",
    recordedAt: ":triplex/derivation-recorded-at",
    recordedPosition: ":triplex/derivation-recorded-position",
    nextTemporalBoundary: ":triplex/derivation-next-temporal-boundary",
  },
} as const;

export const entityId = {
  candidate: (revision: ContentIds.ContentId): EntityId =>
    unsafe.entityId(`${System.prefix}candidate/${revision}`),
  run: (id: ContentIds.ContentId): EntityId => unsafe.entityId(`${System.prefix}run/${id}`),
};

const SourceFactSchema = Schema.Struct({
  tripleId: TripleId,
  transactionId: Schema.optional(TransactionId),
  transactionPosition: Schema.optional(Schema.Number),
  entityId: EntityId,
  attribute: Schema.String,
  validFrom: Schema.Number,
  validTo: Schema.optional(Schema.Number),
  hypothetical: Schema.optional(Schema.Boolean),
  hypotheticalContentId: Schema.optional(ContentIds.ContentIdSchema),
});

const BindingSchema = Schema.Record(Schema.String, Schema.NullOr(ConstantSchema));

const StoredCandidateSchema = Schema.Struct({
  id: ContentIds.ContentIdSchema,
  revision: ContentIds.ContentIdSchema,
  definitionId: ContentIds.ContentIdSchema,
  configSnapshot: Schema.String,
  identity: BindingSchema,
  result: BindingSchema,
  sources: Schema.Array(SourceFactSchema),
  nextTemporalBoundary: Schema.optional(Schema.Number),
});

interface StoredCandidate {
  readonly id: ContentIds.ContentId;
  readonly revision: ContentIds.ContentId;
  readonly definitionId: ContentIds.ContentId;
  readonly configSnapshot: string;
  readonly identity: Readonly<Record<string, Constant | null>>;
  readonly result: Readonly<Record<string, Constant | null>>;
  readonly sources: readonly SourceFact[];
  readonly nextTemporalBoundary?: number;
}

interface StoredRun {
  readonly id: ContentIds.ContentId;
  readonly entityId: string;
  readonly name: string;
  readonly definitionId: ContentIds.ContentId;
  readonly configSnapshot: string;
  readonly sourcePosition: number;
  readonly materializationPosition: number;
  readonly basis: EvaluateOptions["basis"];
  readonly candidates: readonly Candidate[];
  readonly nextTemporalBoundary?: number;
}

export interface MaterializationRun {
  readonly id: ContentIds.ContentId;
  readonly definitionId: ContentIds.ContentId;
  readonly configSnapshot: string;
  readonly sourcePosition: number;
  readonly basis: EvaluateOptions["basis"];
  readonly candidates: readonly Candidate[];
  readonly nextTemporalBoundary?: number;
  readonly reconciliation: Reconciliation;
  /** Undefined when this exact immutable run was already present. */
  readonly transaction: TransactionResult | undefined;
}

export interface MaterializationState {
  readonly status: "current" | "stale" | "unmaterialized";
  readonly currentPosition: number;
  readonly sourcePosition?: number;
  readonly definitionId?: ContentIds.ContentId;
  readonly configSnapshot?: string;
  readonly basis?: EvaluateOptions["basis"];
  readonly candidates: readonly Candidate[];
  readonly nextTemporalBoundary?: number;
}

export class CorruptMaterializationError extends Data.TaggedError(
  "CorruptDerivationMaterializationError",
)<{
  readonly entityId: string;
  readonly message: string;
}> {}

export type MaterializationError =
  | ReadError
  | WriteError
  | TransactionConflictError
  | CommandAlreadyCommittedError
  | ConstraintViolationError
  | DatalogQueryError
  | CandidateConflictError
  | CorruptMaterializationError
  | CanonicalJson.CanonicalEncodingError
  | Schema.SchemaError;

const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

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

const rowsAt = (rows: readonly Triple[], attribute: string): readonly Triple[] =>
  rows.filter((row) => row.attribute === attribute);

const stringValue = (row: Triple | undefined): string | undefined =>
  row?.value.type === "string" || row?.value.type === "ref" ? row.value.value : undefined;

const numberValue = (row: Triple | undefined): number | undefined =>
  row?.value.type === "number" ? row.value.value : undefined;

const basisEqual = (left: EvaluateOptions["basis"], right: EvaluateOptions["basis"]): boolean =>
  left.validAt === right.validAt &&
  left.recordedAt === right.recordedAt &&
  left.recordedPosition === right.recordedPosition;

const runBody = (input: {
  readonly version: 1 | 2;
  readonly definitionId: ContentIds.ContentId;
  readonly configSnapshot: string;
  readonly sourcePosition: number;
  readonly basis: EvaluateOptions["basis"];
  readonly candidateRevisions: readonly ContentIds.ContentId[];
  readonly nextTemporalBoundary?: number;
}): CanonicalJson.CanonicalValue =>
  ({
    v: input.version,
    definition: input.definitionId,
    configSnapshot: input.configSnapshot,
    sourcePosition: input.sourcePosition,
    basis: input.basis,
    candidates: [...input.candidateRevisions].sort(),
    ...(input.version === 2 ? { nextTemporalBoundary: input.nextTemporalBoundary ?? null } : {}),
  }) as CanonicalJson.CanonicalValue;

const transactionIsRelevant = (definition: Definition, transaction: TransactionRecord): boolean => {
  if (transaction.actor === "triplex/derivation-materializer") return false;
  const attributes = new Set(definition.dependencies.attributes);
  return (
    transaction.changes.some(
      (change) => definition.dependencies.hasDynamicAttributes || attributes.has(change.attribute),
    ) ||
    (transaction.summary !== undefined &&
      (definition.dependencies.hasDynamicAttributes ||
        transaction.summary.attributes.some((attribute) => attributes.has(attribute))))
  );
};

/** Latest transaction position capable of changing this definition's answer. */
export const currentSourcePosition = (
  triples: TriplesService,
  definition: Definition,
  basis?: EvaluateOptions["basis"],
): Effect.Effect<number, ReadError> =>
  definition.dependencies.hasDynamicAttributes
    ? Effect.gen(function* () {
        let after = 0;
        let latest = 0;
        while (true) {
          const page = yield* triples.transactions({ after, limit: 1_000 });
          for (const transaction of page.transactions) {
            if (basis?.recordedAt !== undefined && transaction.instant > basis.recordedAt) continue;
            if (
              basis?.recordedPosition !== undefined &&
              transaction.position > basis.recordedPosition
            ) {
              continue;
            }
            if (transactionIsRelevant(definition, transaction)) latest = transaction.position;
          }
          if (page.next === undefined || page.next <= after || page.transactions.length < 1_000) {
            return latest;
          }
          after = page.next;
        }
      })
    : triples
        .dependencyState(definition.dependencies.attributes, basis)
        .pipe(Effect.map((state) => state.sourcePosition));

const storedCandidate = (candidate: Candidate): StoredCandidate => ({
  id: candidate.id,
  revision: candidate.revision,
  definitionId: candidate.definitionId,
  configSnapshot: candidate.configSnapshot,
  identity: candidate.identity,
  result: candidate.result,
  sources: candidate.sources,
  ...(candidate.nextTemporalBoundary === undefined
    ? {}
    : { nextTemporalBoundary: candidate.nextTemporalBoundary }),
});

const candidateOperations = (candidate: Candidate): readonly TransactOp[] => {
  const id = entityId.candidate(candidate.revision);
  return [
    assertOp(id, System.entityType.candidate, System.attribute.contentId, {
      type: "string",
      value: candidate.revision,
    }),
    assertOp(id, System.entityType.candidate, System.attribute.definition, {
      type: "string",
      value: candidate.definitionId,
    }),
    assertOp(id, System.entityType.candidate, System.attribute.configSnapshot, {
      type: "string",
      value: candidate.configSnapshot,
    }),
    assertOp(id, System.entityType.candidate, System.attribute.candidateId, {
      type: "string",
      value: candidate.id,
    }),
    assertOp(id, System.entityType.candidate, System.attribute.candidateBody, {
      type: "json",
      value: storedCandidate(candidate),
    }),
  ];
};

const decodeCandidate = (
  rows: readonly Triple[],
  name: string,
  basis: EvaluateOptions["basis"],
): Effect.Effect<Candidate, CorruptMaterializationError | Schema.SchemaError> => {
  const body = rowsAt(rows, System.attribute.candidateBody)[0];
  if (body?.value.type !== "json") {
    return Effect.fail(
      new CorruptMaterializationError({
        entityId: rows[0]?.entityId ?? "<unknown>",
        message: `Stored derivation candidate ${rows[0]?.entityId ?? "<unknown>"} has no body`,
      }),
    );
  }
  return Schema.decodeUnknownEffect(StoredCandidateSchema)(body.value.value).pipe(
    Effect.flatMap((stored) => {
      const candidate = stored as unknown as StoredCandidate;
      const expectedId = candidateIdentityId(name, candidate.identity);
      const expectedRevision = candidateRevisionId(candidate);
      if (candidate.id === expectedId && candidate.revision === expectedRevision) {
        return Effect.succeed({ ...candidate, basis } as Candidate);
      }
      return Effect.fail(
        new CorruptMaterializationError({
          entityId: rows[0]?.entityId ?? "<unknown>",
          message: `Stored derivation candidate ${candidate.revision} failed content verification`,
        }),
      );
    }),
  );
};

const loadRuns = (
  triples: TriplesService,
  name: string,
): Effect.Effect<
  readonly StoredRun[],
  | ReadError
  | CorruptMaterializationError
  | CanonicalJson.CanonicalEncodingError
  | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const namedRuns = yield* triples.match({
      entityType: System.entityType.run,
      attribute: System.attribute.name,
      value: { type: "string", value: name },
    });
    const runEntities = [...new Set(namedRuns.map((row) => row.entityId))];
    const runRows = yield* triples.entities(runEntities);
    const runs: StoredRun[] = [];
    for (const [index, runEntity] of runEntities.entries()) {
      const rows = runRows[index]!;
      const id = stringValue(rowsAt(rows, System.attribute.contentId)[0]);
      const definitionId = stringValue(rowsAt(rows, System.attribute.definition)[0]);
      const configSnapshot = stringValue(rowsAt(rows, System.attribute.configSnapshot)[0]);
      const sourcePosition = numberValue(rowsAt(rows, System.attribute.sourcePosition)[0]);
      const validAt = numberValue(rowsAt(rows, System.attribute.validAt)[0]);
      const recordedAt = numberValue(rowsAt(rows, System.attribute.recordedAt)[0]);
      const recordedPosition = numberValue(rowsAt(rows, System.attribute.recordedPosition)[0]);
      const formatVersion = numberValue(rowsAt(rows, System.attribute.formatVersion)[0]) ?? 1;
      const nextTemporalBoundary = numberValue(
        rowsAt(rows, System.attribute.nextTemporalBoundary)[0],
      );
      if (
        !id ||
        !ContentIds.isContentId(id) ||
        !definitionId ||
        !ContentIds.isContentId(definitionId) ||
        configSnapshot === undefined ||
        sourcePosition === undefined ||
        validAt === undefined ||
        (formatVersion !== 1 && formatVersion !== 2)
      ) {
        return yield* new CorruptMaterializationError({
          entityId: runEntity,
          message: `Stored derivation run ${runEntity} is missing required metadata`,
        });
      }
      const basis = {
        validAt,
        ...(recordedAt === undefined ? {} : { recordedAt }),
        ...(recordedPosition === undefined ? {} : { recordedPosition }),
      };
      const candidateEntities = [
        ...new Set(
          rowsAt(rows, System.attribute.runCandidate)
            .map(stringValue)
            .filter((value): value is string => value !== undefined),
        ),
      ];
      const candidateRows = yield* triples.entities(candidateEntities.map(unsafe.entityId));
      const candidates = yield* Effect.forEach(candidateRows, (candidate) =>
        decodeCandidate(candidate, name, basis),
      );
      const runEncoding = yield* CanonicalJson.encode(
        runBody({
          version: formatVersion,
          definitionId,
          configSnapshot,
          sourcePosition,
          basis,
          candidateRevisions: candidates.map((candidate) => candidate.revision),
          ...(nextTemporalBoundary === undefined ? {} : { nextTemporalBoundary }),
        }),
      );
      if (ContentIds.hash(ContentIds.Domain.derivationRun, runEncoding) !== id) {
        return yield* new CorruptMaterializationError({
          entityId: runEntity,
          message: `Stored derivation run ${id} failed content verification`,
        });
      }
      const transactionId = Option.getOrUndefined(rows[0]!.txId);
      const transaction = transactionId ? yield* triples.transaction(transactionId) : undefined;
      runs.push({
        id,
        entityId: runEntity,
        name,
        definitionId,
        configSnapshot,
        sourcePosition,
        materializationPosition: transaction?.position ?? 0,
        basis,
        candidates: [...candidates].sort((left, right) => compare(left.id, right.id)),
        ...(nextTemporalBoundary === undefined ? {} : { nextTemporalBoundary }),
      });
    }
    return runs;
  });

const latestRunForName = (
  triples: TriplesService,
  name: string,
): Effect.Effect<
  StoredRun | undefined,
  | ReadError
  | CorruptMaterializationError
  | CanonicalJson.CanonicalEncodingError
  | Schema.SchemaError
> =>
  loadRuns(triples, name).pipe(
    Effect.map(
      (runs) =>
        [...runs].sort(
          (left, right) =>
            right.materializationPosition - left.materializationPosition ||
            compare(right.id, left.id),
        )[0],
    ),
  );

const latestRunForDefinition = (
  runs: readonly StoredRun[],
  definitionId: ContentIds.ContentId,
): StoredRun | undefined =>
  [...runs]
    .filter((run) => run.definitionId === definitionId)
    .sort(
      (left, right) =>
        right.sourcePosition - left.sourcePosition ||
        right.materializationPosition - left.materializationPosition ||
        compare(right.id, left.id),
    )[0];

/**
 * Persist one immutable evaluation checkpoint and return its diff from the
 * previously selected run for the same logical definition name.
 */
export const materialize = (
  triples: TriplesService,
  definition: Definition,
  options: EvaluateOptions,
): Effect.Effect<MaterializationRun, MaterializationError> =>
  Effect.gen(function* () {
    const [sourcePosition, previous] = yield* Effect.all([
      currentSourcePosition(triples, definition, options.basis),
      latestRunForName(triples, definition.name),
    ]);
    const evaluation = yield* evaluate(triples, definition, options);
    const reconciliation = reconcile(previous?.candidates ?? [], evaluation.candidates);
    const candidateRevisions = evaluation.candidates.map((candidate) => candidate.revision).sort();
    const encoded = yield* CanonicalJson.encode(
      runBody({
        version: 2,
        definitionId: definition.id,
        configSnapshot: definition.configSnapshot,
        sourcePosition,
        basis: options.basis,
        candidateRevisions,
        ...(evaluation.nextTemporalBoundary === undefined
          ? {}
          : { nextTemporalBoundary: evaluation.nextTemporalBoundary }),
      }),
    );
    const id = ContentIds.hash(ContentIds.Domain.derivationRun, encoded);
    const runEntity = entityId.run(id);
    const [existingRun, existingCandidates] = yield* Effect.all([
      triples.match({ entityId: runEntity }),
      Effect.forEach(evaluation.candidates, (candidate) =>
        triples.match({ entityId: entityId.candidate(candidate.revision) }),
      ),
    ]);
    const operations: TransactOp[] = [];
    for (const [index, candidate] of evaluation.candidates.entries()) {
      if (existingCandidates[index]!.length === 0)
        operations.push(...candidateOperations(candidate));
    }
    if (existingRun.length === 0) {
      operations.push(
        assertOp(runEntity, System.entityType.run, System.attribute.contentId, {
          type: "string",
          value: id,
        }),
        assertOp(runEntity, System.entityType.run, System.attribute.name, {
          type: "string",
          value: definition.name,
        }),
        assertOp(runEntity, System.entityType.run, System.attribute.definition, {
          type: "string",
          value: definition.id,
        }),
        assertOp(runEntity, System.entityType.run, System.attribute.configSnapshot, {
          type: "string",
          value: definition.configSnapshot,
        }),
        assertOp(runEntity, System.entityType.run, System.attribute.sourcePosition, {
          type: "number",
          value: sourcePosition,
        }),
        assertOp(runEntity, System.entityType.run, System.attribute.formatVersion, {
          type: "number",
          value: 2,
        }),
        assertOp(runEntity, System.entityType.run, System.attribute.validAt, {
          type: "number",
          value: options.basis.validAt,
        }),
        ...(options.basis.recordedAt === undefined
          ? []
          : [
              assertOp(runEntity, System.entityType.run, System.attribute.recordedAt, {
                type: "number",
                value: options.basis.recordedAt,
              }),
            ]),
        ...(options.basis.recordedPosition === undefined
          ? []
          : [
              assertOp(runEntity, System.entityType.run, System.attribute.recordedPosition, {
                type: "number",
                value: options.basis.recordedPosition,
              }),
            ]),
        ...(evaluation.nextTemporalBoundary === undefined
          ? []
          : [
              assertOp(runEntity, System.entityType.run, System.attribute.nextTemporalBoundary, {
                type: "number",
                value: evaluation.nextTemporalBoundary,
              }),
            ]),
        ...evaluation.candidates.map((candidate) =>
          assertOp(runEntity, System.entityType.run, System.attribute.runCandidate, {
            type: "ref",
            value: entityId.candidate(candidate.revision),
          }),
        ),
      );
    }
    const transaction =
      operations.length === 0
        ? undefined
        : yield* transactSystem(triples, operations, {
            actor: "triplex/derivation-materializer",
            configSnapshot: definition.configSnapshot,
          });
    return {
      id,
      definitionId: definition.id,
      configSnapshot: definition.configSnapshot,
      sourcePosition,
      basis: options.basis,
      candidates: evaluation.candidates,
      ...(evaluation.nextTemporalBoundary === undefined
        ? {}
        : { nextTemporalBoundary: evaluation.nextTemporalBoundary }),
      reconciliation,
      transaction,
    };
  });

/** Last durable candidates plus an explicit freshness verdict. */
export const current = (
  triples: TriplesService,
  definition: Definition,
  options: EvaluateOptions,
): Effect.Effect<
  MaterializationState,
  | ReadError
  | CorruptMaterializationError
  | CanonicalJson.CanonicalEncodingError
  | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const [runs, currentPosition] = yield* Effect.all([
      loadRuns(triples, definition.name),
      currentSourcePosition(triples, definition, options.basis),
    ]);
    const run =
      latestRunForDefinition(runs, definition.id) ??
      [...runs].sort(
        (left, right) =>
          right.materializationPosition - left.materializationPosition ||
          compare(right.id, left.id),
      )[0];
    if (!run) return { status: "unmaterialized", currentPosition, candidates: [] };
    const status =
      run.definitionId === definition.id &&
      run.sourcePosition === currentPosition &&
      basisEqual(run.basis, options.basis)
        ? "current"
        : "stale";
    return {
      status,
      currentPosition,
      sourcePosition: run.sourcePosition,
      definitionId: run.definitionId,
      configSnapshot: run.configSnapshot,
      basis: run.basis,
      candidates: run.candidates,
      ...(run.nextTemporalBoundary === undefined
        ? {}
        : { nextTemporalBoundary: run.nextTemporalBoundary }),
    };
  });

/** Query all immutable run/candidate memberships for auditing or composition. */
export const runsQuery = (name: string): DatalogQuery => ({
  find: ["?run", "?definition", "?sourcePosition", "?candidate"],
  where: [
    ["?run", System.attribute.name, name],
    ["?run", System.attribute.definition, "?definition"],
    ["?run", System.attribute.sourcePosition, "?sourcePosition"],
    ["?run", System.attribute.runCandidate, "?candidate"],
  ],
});
