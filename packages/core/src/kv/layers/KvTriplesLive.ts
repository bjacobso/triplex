import { validateTransactionIntervals } from "../../Triple.js";
import {
  dependencyProjections,
  recordedPositionAt,
  type DependencyProjection,
} from "../hexastore/readIndexes.js";
import { resolveRecordedBasis } from "../../store/recordedBasis.js";
import { explainAccessPaths } from "../datalog/explain.js";
import { assertQueryBasis, queryBasisForView, resolveQueryBasis } from "../../datalog/temporal.js";
import { checkCheapPreconditions } from "../../store/cheapPreconditions.js";
import { initializeKvLiveFacts, migrateKvLiveFacts } from "../hexastore/KvTripleStore.js";
/**
 * KV-backed implementation of the merged `Triples` service.
 *
 * It calls `createKvTripleStore(kvBackend)` **once** and builds both the
 * write/triple-read path and the Datalog path over that single hexastore
 * handle, keeping their in-memory datom cache coherent.
 */

import { Effect, Layer, Option, Stream } from "effect";
import type { Triple, TripleInput, TripleId, EntityId, TransactOp } from "../../Triple.js";
import type { TripleValue } from "../../Value.js";
import type { Pattern } from "../../types/Pattern.js";
import {
  Triples,
  type TriplesService,
  type TransactionResult,
  type TransactionMeta,
  type QueryOptions,
} from "../../store/Triples.js";
import type { QueryDebugInfo, QueryMetrics, QueryResult } from "../../storage/QueryExecutor.js";
import type { DatalogQuery, WrappedQuery } from "../datalog/types.js";
import {
  WriteError,
  ReadError,
  CommandAlreadyCommittedError,
  TransactionConflictError,
  ConstraintViolationError,
  CommitRejectedError,
  PaginationCursorError,
  OperationalEntryConflictError,
  DatalogValidationError,
  UnboundVariableError,
} from "../../errors/index.js";
import { validateDatalogQuery, validateWrappedQuery } from "../../datalog/validation.js";
import * as Constraint from "../../Constraint.js";
import { KvBackend, type KvBackendService, type KvTransaction } from "../kv/KvBackend.js";
import { makeTestKvBackend } from "../kv/InMemoryKvBackend.js";
import { createKvTripleStore, type Datom, type KvTripleStore } from "../hexastore/KvTripleStore.js";
import type { ScanPattern } from "../hexastore/scan.js";
import { executeQuery, executeWrappedQuery } from "../datalog/executor.js";
import {
  TripleStoreRuntime,
  TripleStoreRuntimeLayer,
  makeTripleStoreRuntimeLayer,
} from "../../store/TripleStoreRuntime.js";
import {
  entityStatePreconditions,
  invalidCommandId,
  livePreconditionIds,
  metadataInputs,
  transactionRecordFromTriples,
  transactionRecordsFromTriples,
  transactionChangeFromTriple,
  validatePreconditions,
} from "../../store/transactionMetadata.js";
import {
  isJournalSuppressed,
  isSystemWriteAuthorized,
  reservedAssertError,
  reservedWriteError,
} from "../../store/systemNamespace.js";
import { resolveTemporalBasis, type ResolvedTemporalBasis } from "../../Temporal.js";
import { TxAttributes } from "../../utils/id.js";
import { finishPagination, preparePagination, wrapDatalogQuery } from "../../Pagination.js";
import * as ContentIds from "../../content/ContentId.js";
import { unsafe } from "../../Branded.js";
import { transactionsForEntity } from "../../store/entityTransactionHistory.js";
import { encodeEntityPageCursor, prepareEntityPage } from "../../EntityPage.js";
import { tripleAtRecordedPosition } from "../../store/temporalView.js";
import { makeKvOperationalEntryStorage } from "../kv/OperationalEntries.js";
import {
  applyEntryOperation,
  decodeEntry,
  preparePendingEntries,
  finishPendingEntries,
} from "../../operational/entryStorage.js";
import { commitOperationalView } from "../../store/commitOperationalView.js";
import type * as CommitValidation from "../../store/CommitValidation.js";
import { attemptFrom, runValidators, viewBasis } from "../../store/commitValidationRun.js";

const COMMIT_POSITION_KEY = new Uint8Array([0x21]);
const COMMAND_RECEIPT_PREFIX = 0x22;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const commandReceiptKey = (commandId: string): Uint8Array => {
  const digest = textEncoder.encode(ContentIds.hash(ContentIds.Domain.commandReceipt, commandId));
  const key = new Uint8Array(digest.length + 1);
  key[0] = COMMAND_RECEIPT_PREFIX;
  key.set(digest, 1);
  return key;
};

const claimKvCommand = (
  tx: KvTransaction,
  commandId: string,
  transactionId: string,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const key = commandReceiptKey(commandId);
    const existing = yield* tx.get(key);
    if (existing !== null) return textDecoder.decode(existing);
    yield* tx.set(key, textEncoder.encode(transactionId));
    return null;
  });

const nextKvCommitPosition = (tx: KvTransaction): Effect.Effect<number, WriteError> =>
  Effect.gen(function* () {
    const stored = yield* tx.get(COMMIT_POSITION_KEY);
    const current = stored === null ? 0 : Number(textDecoder.decode(stored));
    if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
      return yield* Effect.fail(
        new WriteError({ message: "Invalid or exhausted KV commit-position counter" }),
      );
    }
    const next = current + 1;
    yield* tx.set(COMMIT_POSITION_KEY, textEncoder.encode(String(next)));
    return next;
  });

const currentKvCommitPosition = (backend: KvBackendService): Effect.Effect<number, ReadError> =>
  backend.get(COMMIT_POSITION_KEY).pipe(
    Effect.flatMap((stored) => {
      const position = stored === null ? 0 : Number(textDecoder.decode(stored));
      return Number.isSafeInteger(position) && position >= 0
        ? Effect.succeed(position)
        : Effect.fail(new ReadError({ message: "Invalid KV commit-position counter" }));
    }),
    Effect.mapError((cause) =>
      cause instanceof ReadError
        ? cause
        : new ReadError({ message: `Failed to read KV commit position: ${String(cause)}`, cause }),
    ),
  );

const dependencyStateFromDatoms = (
  datoms: readonly DependencyProjection[],
  basis: ResolvedTemporalBasis,
): { readonly sourcePosition: number; readonly nextTemporalBoundary?: number } => {
  let sourcePosition = 0;
  let nextTemporalBoundary: number | undefined;
  for (const datom of datoms) {
    const assertionVisible =
      basis.recordedPosition !== undefined
        ? datom.recordedPosition <= basis.recordedPosition
        : basis.recordedAt === undefined || datom.recordedAt <= basis.recordedAt;
    if (!assertionVisible) continue;

    sourcePosition = Math.max(sourcePosition, datom.recordedPosition);
    const retractionVisible =
      datom.retractedPosition !== null &&
      (basis.recordedPosition !== undefined
        ? datom.retractedPosition <= basis.recordedPosition
        : basis.recordedAt === undefined ||
          (datom.retractedAt !== null && datom.retractedAt <= basis.recordedAt));
    if (retractionVisible) {
      sourcePosition = Math.max(sourcePosition, datom.retractedPosition!);
      continue;
    }

    for (const boundary of [datom.validFrom, datom.validTo]) {
      if (
        boundary !== null &&
        boundary > basis.validAt &&
        (nextTemporalBoundary === undefined || boundary < nextTemporalBoundary)
      ) {
        nextTemporalBoundary = boundary;
      }
    }
  }
  return {
    sourcePosition,
    ...(nextTemporalBoundary === undefined ? {} : { nextTemporalBoundary }),
  };
};

// ─── Datom ↔ Triple conversion ─────────────────────────────────────────────

const datomToTriple = (datom: Datom): Triple => ({
  id: datom.tripleId as TripleId,
  entityId: datom.entity as EntityId,
  attribute: datom.attribute as Triple["attribute"],
  value: datom.value,
  recordedAt: datom.recordedAt,
  validFrom: datom.validFrom,
  validTo: datom.validTo !== null ? Option.some(datom.validTo) : Option.none(),
  createdBy: datom.createdBy !== null ? Option.some(datom.createdBy) : Option.none(),
  retractedAt: datom.retractedAt !== null ? Option.some(datom.retractedAt) : Option.none(),
  entityType: datom.entityType !== null ? Option.some(datom.entityType) : Option.none(),
  schemaVersion: Option.none(),
  txId: Option.some(unsafe.transactionId(datom.txId)),
  retractTxId:
    datom.retractTxId !== null
      ? Option.some(unsafe.transactionId(datom.retractTxId))
      : Option.none(),
});

const tripleInputToDatom = (
  input: TripleInput,
  tripleId: string,
  txId: string,
  recordedAt: number,
  recordedPosition: number,
): Datom => ({
  tripleId,
  entity: input.entityId,
  attribute: input.attribute,
  value: input.value,
  txId,
  recordedAt,
  recordedPosition,
  validFrom: input.validFrom ?? recordedAt,
  validTo: input.validTo ?? null,
  createdBy: input.createdBy ?? null,
  retractedAt: null,
  retractedPosition: null,
  retractTxId: null,
  entityType: input.entityType ?? null,
});

// ─── Pattern conversion ────────────────────────────────────────────────────

const patternToScan = (pattern: Pattern): ScanPattern => {
  const result: { entity?: string; attribute?: string; value?: TripleValue } = {};

  if (pattern.entityId !== undefined && typeof pattern.entityId === "string") {
    result.entity = pattern.entityId;
  }
  if (pattern.attribute !== undefined && typeof pattern.attribute === "string") {
    result.attribute = pattern.attribute;
  }
  if (
    pattern.value !== undefined &&
    typeof pattern.value === "object" &&
    pattern.value !== null &&
    !("_tag" in pattern.value)
  ) {
    result.value = pattern.value as TripleValue;
  }

  return result;
};

// ─── Datalog debug metrics (KV backends generate no SQL) ────────────────────

const makeKvMetrics = (query: DatalogQuery): QueryMetrics => ({
  joinCount: 0,
  whereConditionCount: query.where.length,
  subqueryCount: 0,
  cteCount: 0,
  sqlLength: 0,
  paramCount: 0,
  patternCount: query.where.filter((c) => Array.isArray(c) && c.length >= 3 && c.length <= 4)
    .length,
  predicateCount: query.where.filter(
    (c) => Array.isArray(c) && [">", ">=", "<", "<=", "=", "!="].includes(c[0] as string),
  ).length,
  notClauseCount: query.where.filter((c) => Array.isArray(c) && c[0] === "not").length,
  orClauseCount: query.where.filter((c) => Array.isArray(c) && c[0] === "or").length,
  hasAggregation: (query.aggregate?.length ?? 0) > 0,
  isRecursive: (query.rules?.length ?? 0) > 0,
  aggregateOps: (query.aggregate ?? []).map((a) => a[0]),
  compilationTimeMs: 0,
});

/** Adapt a backend transaction to the interface consumed by KvTripleStore. */
const transactionBackend = (tx: KvTransaction): KvBackendService => ({
  get: tx.get,
  set: tx.set,
  delete: tx.delete,
  getRange: tx.getRange,
  transact: (effect) => effect(tx),
  setAll: (entries) =>
    Effect.forEach(entries, ([key, value]) => tx.set(key, value), { discard: true }),
  getMany: (keys) =>
    Effect.forEach(keys, (key) => tx.get(key).pipe(Effect.map((value) => [key, value] as const))),
  clear: () => Effect.die("KvTripleStore.clear is not supported inside a transaction"),
});

// ─── Commit validator views ────────────────────────────────────────────────

const kvReadError = (label: string) => (cause: unknown) =>
  new ReadError({ message: `${label} failed: ${String(cause)}`, cause });

/** Read-only view over a transaction-scoped hexastore at an exact commit cut. */
const kvCommitView = (
  store: KvTripleStore,
  position: number,
  instant: number,
  tx: KvTransaction,
  operations: readonly TransactOp[],
): CommitValidation.View => {
  const basis = (options?: CommitValidation.ViewOptions) => viewBasis(position, instant, options);
  const entityAt = (entityId: string, resolved: ResolvedTemporalBasis) =>
    store
      .scanCollectTemporalAsync({ entity: entityId }, resolved)
      .pipe(Effect.map((datoms) => datoms.map(datomToTriple)));
  return {
    position,
    ...commitOperationalView(makeKvOperationalEntryStorage(tx), position, operations),
    entity: (entityId, options) =>
      basis(options).pipe(Effect.flatMap((resolved) => entityAt(entityId, resolved))),
    entities: (entityIds, options) =>
      basis(options).pipe(
        Effect.flatMap((resolved) =>
          Effect.forEach(entityIds, (entityId) => entityAt(entityId, resolved)),
        ),
      ),
    match: (pattern, options) =>
      basis(options).pipe(
        Effect.flatMap((resolved) => {
          const scan = patternToScan(pattern);
          if (
            pattern.entityType !== undefined &&
            scan.entity === undefined &&
            scan.attribute === undefined &&
            scan.value === undefined
          ) {
            return store.getByEntityTypeTemporalAsync(pattern.entityType, resolved);
          }
          return store
            .scanCollectTemporalAsync(scan, resolved)
            .pipe(
              Effect.map((datoms) =>
                pattern.entityType === undefined
                  ? datoms
                  : datoms.filter((datom) => datom.entityType === pattern.entityType),
              ),
            );
        }),
        Effect.map((datoms) => datoms.map(datomToTriple)),
      ),
    query: (q, options) =>
      basis(options).pipe(
        Effect.flatMap((resolved) =>
          queryBasisForView(q, resolved, options).pipe(
            Effect.flatMap((queryBasis) =>
              executeQuery(store, q, q.rules ?? [], { basis: queryBasis }),
            ),
          ),
        ),
        Effect.map((result) => ({ results: result.results as unknown as QueryResult })),
        Effect.mapError((error) =>
          error instanceof ReadError ||
          error instanceof DatalogValidationError ||
          error instanceof UnboundVariableError
            ? error
            : kvReadError("Commit view query")(error),
        ),
      ),
  };
};

// ─── Service implementation ────────────────────────────────────────────────

const makeKvTriplesService = Effect.gen(function* () {
  const kvBackend = yield* KvBackend;
  const runtime = yield* TripleStoreRuntime;
  yield* initializeKvLiveFacts(kvBackend);

  // Single hexastore handle shared by the write path and the Datalog path so
  // their datom caches can never diverge.
  const hexaStore = createKvTripleStore(kvBackend);
  yield* hexaStore.initializeReadIndexes();

  // === Triple-level reads (needed by retractByPattern below) ===============

  const match = (
    pattern: Pattern,
    basis?: ResolvedTemporalBasis,
  ): Effect.Effect<readonly Triple[], ReadError> =>
    Effect.gen(function* () {
      // Fast path: entityType-only query uses the KV TYPE index, at any basis.
      // Public reads always arrive with a resolved basis, so without the
      // temporal variant every entity-type read scanned the whole store.
      if (pattern.entityType && !pattern.entityId && !pattern.attribute && !pattern.value) {
        const datoms =
          basis === undefined
            ? hexaStore.getByEntityType(pattern.entityType)
            : hexaStore.getByEntityTypeTemporal(pattern.entityType, basis);
        if (datoms !== null) {
          return datoms.map(datomToTriple);
        }
        const asyncDatoms =
          basis === undefined
            ? yield* hexaStore.getByEntityTypeAsync(pattern.entityType)
            : yield* hexaStore.getByEntityTypeTemporalAsync(pattern.entityType, basis);
        return asyncDatoms
          .filter((datom) => datom.entityType === pattern.entityType)
          .map(datomToTriple);
      }

      const scanPat = patternToScan(pattern);
      const syncDatoms =
        basis === undefined
          ? hexaStore.scanCollect(scanPat)
          : hexaStore.scanCollectTemporal(scanPat, basis);
      let results: Triple[];
      if (syncDatoms !== null) {
        if (pattern.entityType) {
          results = [];
          for (let i = 0; i < syncDatoms.length; i++) {
            const d = syncDatoms[i]!;
            if (d.entityType === pattern.entityType) {
              results.push(datomToTriple(d));
            }
          }
          return results;
        }
        results = syncDatoms.map(datomToTriple);
      } else {
        const datoms = yield* basis === undefined
          ? hexaStore.scanCollectAsync(scanPat)
          : hexaStore.scanCollectTemporalAsync(scanPat, basis);
        results = datoms.map(datomToTriple);
      }

      if (pattern.entityType) {
        results = results.filter(
          (t) => Option.isSome(t.entityType) && t.entityType.value === pattern.entityType,
        );
      }

      return results;
    }).pipe(
      Effect.catch((e) =>
        Effect.fail(new ReadError({ message: `Query failed: ${String(e)}`, cause: e })),
      ),
    );

  let transactService: TriplesService["transact"];

  const service: TriplesService = {
    operationalEntry: (id) =>
      Effect.gen(function* () {
        if (!ContentIds.isContentId(id))
          return yield* new ReadError({ message: "Invalid operational entry ID" });
        const record = yield* makeKvOperationalEntryStorage(kvBackend).getOperationalEntry(id);
        return record === null ? null : yield* decodeEntry(record);
      }),
    pendingOperationalEntries: (kind, request = {}) =>
      Effect.gen(function* () {
        const prepared = yield* Effect.try({
          try: () => preparePendingEntries(kind, request, runtime.scope),
          catch: (cause) =>
            cause instanceof PaginationCursorError
              ? cause
              : new ReadError({ message: "Invalid operational pending request", cause }),
        });
        const records = yield* kvBackend.transact((tx) =>
          makeKvOperationalEntryStorage(tx).pendingOperationalEntries(prepared.scan),
        );
        return yield* finishPendingEntries(prepared, records);
      }),
    // === Writes ============================================================

    assert: (input: TripleInput) =>
      transactService([
        {
          op: "assert",
          entityId: input.entityId,
          attribute: input.attribute,
          value: input.value,
          entityType: input.entityType,
          createdBy: input.createdBy,
          validFrom: input.validFrom,
          validTo: input.validTo,
        },
      ]).pipe(
        Effect.map((result) => result.triples[0]!),
        Effect.mapError((cause) =>
          cause instanceof WriteError || cause instanceof TransactionConflictError
            ? cause
            : new WriteError({ message: "Failed to assert triple", cause }),
        ),
      ),

    assertBatch: (inputs: readonly TripleInput[]) => {
      if (inputs.length === 0) return Effect.succeed([]);
      return transactService(
        inputs.map((input) => ({
          op: "assert" as const,
          entityId: input.entityId,
          attribute: input.attribute,
          value: input.value,
          entityType: input.entityType,
          createdBy: input.createdBy,
          validFrom: input.validFrom,
          validTo: input.validTo,
        })),
      ).pipe(
        Effect.map((result) => result.triples),
        Effect.mapError((cause) =>
          cause instanceof WriteError || cause instanceof TransactionConflictError
            ? cause
            : new WriteError({ message: "Failed to assert triple batch", cause }),
        ),
      );
    },

    retract: (id: TripleId) =>
      transactService([{ op: "retract", id }]).pipe(
        Effect.flatMap((result) =>
          result.retracted === 1
            ? Effect.void
            : Effect.fail(
                new WriteError({ message: `Triple not found or already retracted: ${id}` }),
              ),
        ),
        Effect.mapError((cause) =>
          cause instanceof WriteError || cause instanceof TransactionConflictError
            ? cause
            : new WriteError({ message: `Failed to retract triple: ${id}`, cause }),
        ),
      ),

    retractByPattern: (pattern: Pattern) =>
      transactService([
        {
          op: "retract-pattern",
          pattern: {
            ...(typeof pattern.entityId === "string" ? { entityId: pattern.entityId } : {}),
            ...(typeof pattern.attribute === "string" ? { attribute: pattern.attribute } : {}),
            ...(pattern.value && !("_tag" in pattern.value) ? { value: pattern.value } : {}),
            ...(pattern.entityType ? { entityType: pattern.entityType } : {}),
          },
        },
      ]).pipe(
        Effect.map((result) => result.retracted),
        Effect.mapError((cause) =>
          cause instanceof WriteError ||
          cause instanceof ReadError ||
          cause instanceof TransactionConflictError
            ? cause
            : new WriteError({ message: "Failed to retract by pattern", cause }),
        ),
      ),

    transact: (transactService = (operations: readonly TransactOp[], meta?: TransactionMeta) =>
      kvBackend
        .transact((tx) => {
          const transactionStore = createKvTripleStore(transactionBackend(tx));
          return Effect.gen(function* () {
            yield* validateTransactionIntervals(operations);
            if (!isSystemWriteAuthorized(meta)) {
              const reserved = reservedAssertError(operations);
              if (reserved) return yield* Effect.fail(reserved);
            }
            const invalidCondition = validatePreconditions(operations, meta);
            if (invalidCondition) {
              return yield* Effect.fail(
                new WriteError({
                  message: `Transaction precondition ${invalidCondition} must have a matching retract operation`,
                }),
              );
            }
            if (invalidCommandId(meta) !== undefined) {
              return yield* Effect.fail(
                new WriteError({
                  message: "Command ID must contain between 1 and 1024 characters",
                }),
              );
            }
            const txId = yield* runtime.nextTxId;
            const now = yield* runtime.now;
            if (meta?.commandId !== undefined) {
              const originalTransactionId = yield* claimKvCommand(tx, meta.commandId, txId);
              if (originalTransactionId !== null) {
                return yield* Effect.fail(
                  new CommandAlreadyCommittedError({
                    commandId: meta.commandId,
                    transactionId: unsafe.transactionId(originalTransactionId),
                    message: `Command ${meta.commandId} already committed as ${originalTransactionId}`,
                  }),
                );
              }
            }
            const position = yield* nextKvCommitPosition(tx);
            const actor = meta?.actor;
            const preconditionIds = livePreconditionIds(meta);

            for (const id of preconditionIds) {
              const current = yield* transactionStore.getById(id);
              if (current === null || current.retractedAt !== null) {
                return yield* new TransactionConflictError({
                  tripleId: unsafe.tripleId(id),
                  message: `Expected live triple ${id}, but another transaction changed it`,
                });
              }
            }

            yield* checkCheapPreconditions(meta, (entityId, attribute, limit) =>
              transactionStore
                .livePreconditionFacts(entityId, attribute, limit)
                .pipe(Effect.map((facts) => facts.map((fact) => fact.value))),
            );

            for (const condition of entityStatePreconditions(meta)) {
              const actual = (yield* transactionStore.scanCollectAsync({
                entity: condition.entityId,
              }))
                .map((datom) => datom.tripleId)
                .sort();
              const expected = [...condition.tripleIds].sort();
              if (
                actual.length !== expected.length ||
                actual.some((id, index) => id !== expected[index])
              ) {
                return yield* Effect.fail(
                  new TransactionConflictError({
                    entityId: condition.entityId,
                    message: `Expected entity ${condition.entityId} to have the observed fact set, but another transaction changed it`,
                  }),
                );
              }
            }

            let enforce: Effect.Effect<void, WriteError | ConstraintViolationError> = Effect.void;
            if (meta?.enforce !== undefined) {
              const constraints = meta.enforce.constraints;
              const current = yield* Constraint.loadRelevantFacts(constraints, operations, {
                byEntityType: (entityType) =>
                  transactionStore
                    .getByEntityTypeAsync(entityType)
                    .pipe(Effect.map((datoms) => datoms.map(datomToTriple))),
                byEntities: (entityIds) =>
                  Effect.forEach(entityIds, (entityId) =>
                    transactionStore
                      .scanCollectAsync({ entity: entityId })
                      .pipe(Effect.map((datoms) => datoms.map(datomToTriple))),
                  ).pipe(Effect.map((rows) => rows.flat())),
              });
              enforce = Effect.gen(function* () {
                const violations = yield* Constraint.newlyViolated(
                  current,
                  operations,
                  constraints,
                  now,
                ).pipe(
                  Effect.mapError(
                    (cause) =>
                      new WriteError({
                        message: `Constraint evaluation failed: ${cause.message}`,
                        cause,
                      }),
                  ),
                );
                if (violations.length > 0) {
                  return yield* Effect.fail(
                    new ConstraintViolationError({
                      violations,
                      message: Constraint.describeViolations(violations),
                    }),
                  );
                }
              });
            }
            const asserted: Triple[] = [];
            const changes: import("../../store/Triples.js").TransactionChange[] = [];
            let retractedCount = 0;

            for (const op of operations) {
              switch (op.op) {
                case "append-entry":
                case "acknowledge-entry": {
                  yield* applyEntryOperation(op, makeKvOperationalEntryStorage(tx), {
                    txId,
                    position,
                    instant: now,
                  });
                  break;
                }
                case "assert": {
                  const datom = tripleInputToDatom(
                    {
                      entityId: op.entityId,
                      attribute: op.attribute,
                      value: op.value,
                      entityType: op.entityType,
                      createdBy: op.createdBy ?? actor,
                      validFrom: op.validFrom,
                      validTo: op.validTo,
                    },
                    yield* runtime.nextTripleId,
                    txId,
                    now,
                    position,
                  );
                  yield* transactionStore.assert(datom);
                  const triple = datomToTriple(datom);
                  asserted.push(triple);
                  changes.push(transactionChangeFromTriple("assert", triple, txId, now));
                  break;
                }
                case "retract": {
                  const current = yield* transactionStore.getById(op.id);
                  if (current && !isSystemWriteAuthorized(meta)) {
                    const reserved = reservedWriteError({
                      entityId: current.entity,
                      attribute: current.attribute,
                      entityType: current.entityType ?? undefined,
                    });
                    if (reserved) return yield* Effect.fail(reserved);
                  }
                  const ok = yield* transactionStore.retract(op.id, now, txId, position);
                  if (!ok && preconditionIds.has(op.id)) {
                    return yield* Effect.fail(
                      new TransactionConflictError({
                        tripleId: op.id,
                        message: `Expected live triple ${op.id}, but another transaction changed it`,
                      }),
                    );
                  }
                  if (ok) {
                    retractedCount++;
                    if (current) {
                      changes.push(
                        transactionChangeFromTriple("retract", datomToTriple(current), txId, now),
                      );
                    }
                  }
                  break;
                }
                case "retract-pattern": {
                  const pat = patternToScan(op.pattern as unknown as Pattern);
                  const scanned = yield* transactionStore.scanCollectAsync(pat);
                  const matched = op.pattern.entityType
                    ? scanned.filter((datom) => datom.entityType === op.pattern.entityType)
                    : scanned;
                  const datoms = [...matched].sort((left, right) =>
                    left.tripleId < right.tripleId ? -1 : left.tripleId > right.tripleId ? 1 : 0,
                  );
                  if (!isSystemWriteAuthorized(meta)) {
                    for (const datom of datoms) {
                      const reserved = reservedWriteError({
                        entityId: datom.entity,
                        attribute: datom.attribute,
                        entityType: datom.entityType ?? undefined,
                      });
                      if (reserved) return yield* Effect.fail(reserved);
                    }
                  }
                  for (const datom of datoms) {
                    const ok = yield* transactionStore.retract(datom.tripleId, now, txId, position);
                    if (ok) {
                      retractedCount++;
                      changes.push(
                        transactionChangeFromTriple("retract", datomToTriple(datom), txId, now),
                      );
                    }
                  }
                  break;
                }
              }
            }

            yield* enforce;

            if (!isJournalSuppressed(meta)) {
              for (const input of metadataInputs(txId, position, now, meta, changes)) {
                yield* transactionStore.assert(
                  tripleInputToDatom(input, yield* runtime.nextTripleId, txId, now, position),
                );
              }
            }

            if (meta?.validate !== undefined && meta.validate.length > 0) {
              yield* runValidators(meta.validate, {
                transaction: attemptFrom(txId, now, position, meta),
                changes: [...changes],
                before: kvCommitView(transactionStore, position - 1, now, tx, operations),
                after: kvCommitView(transactionStore, position, now, tx, operations),
              });
            }

            return {
              txId,
              position,
              instant: now,
              triples: asserted,
              retracted: retractedCount,
            } satisfies TransactionResult;
          });
        })
        .pipe(
          Effect.ensuring(Effect.sync(() => hexaStore.clearCache())),
          Effect.catch((e) =>
            e instanceof WriteError ||
            e instanceof OperationalEntryConflictError ||
            e instanceof TransactionConflictError ||
            e instanceof CommandAlreadyCommittedError ||
            e instanceof ConstraintViolationError ||
            e instanceof CommitRejectedError
              ? Effect.fail(e)
              : Effect.fail(new WriteError({ message: `Transact failed: ${String(e)}`, cause: e })),
          ),
        )),

    // === Triple-level reads ================================================

    get: (id: TripleId) =>
      Effect.gen(function* () {
        const datom = yield* hexaStore.getById(id);
        return datom !== null && datom.retractedAt === null ? datomToTriple(datom) : null;
      }).pipe(
        Effect.catch((e) =>
          Effect.fail(new ReadError({ message: `Get failed: ${String(e)}`, cause: e })),
        ),
      ),

    assertion: (id: TripleId) =>
      Effect.gen(function* () {
        const datom = yield* hexaStore.getById(id);
        return datom !== null ? datomToTriple(datom) : null;
      }).pipe(
        Effect.catch((e) =>
          Effect.fail(new ReadError({ message: `Assertion read failed: ${String(e)}`, cause: e })),
        ),
      ),

    entity: (entityId: EntityId, basis) =>
      Effect.gen(function* () {
        const resolved = resolveTemporalBasis(basis, yield* runtime.now);
        const syncDatoms = hexaStore.scanCollectTemporal({ entity: entityId }, resolved);
        if (syncDatoms !== null) {
          return syncDatoms.map((datom) =>
            tripleAtRecordedPosition(datomToTriple(datom), basis?.recordedPosition),
          );
        }
        const datoms = yield* hexaStore.scanCollectTemporalAsync({ entity: entityId }, resolved);
        return datoms.map((datom) =>
          tripleAtRecordedPosition(datomToTriple(datom), basis?.recordedPosition),
        );
      }).pipe(
        Effect.catch((e) =>
          Effect.fail(new ReadError({ message: `Entity failed: ${String(e)}`, cause: e })),
        ),
      ),

    entities: (entityIds, basis) =>
      Effect.gen(function* () {
        const resolved = resolveTemporalBasis(basis, yield* runtime.now);
        return yield* Effect.forEach(entityIds, (entityId) =>
          hexaStore
            .scanCollectTemporalAsync({ entity: entityId }, resolved)
            .pipe(
              Effect.map((datoms) =>
                datoms.map((datom) =>
                  tripleAtRecordedPosition(datomToTriple(datom), basis?.recordedPosition),
                ),
              ),
            ),
        );
      }).pipe(
        Effect.catch((e) =>
          Effect.fail(
            new ReadError({ message: `Batch entity read failed: ${String(e)}`, cause: e }),
          ),
        ),
      ),

    entityPage: (request) =>
      Effect.gen(function* () {
        const currentTime = yield* runtime.now;
        const recordedPosition = yield* currentKvCommitPosition(kvBackend);
        const prepared = yield* Effect.try({
          try: () =>
            prepareEntityPage({
              request,
              now: currentTime,
              recordedPosition,
              scope: runtime.scope,
            }),
          catch: (cause) =>
            cause instanceof PaginationCursorError
              ? cause
              : new PaginationCursorError({
                  reason: "malformed",
                  message: `Failed to prepare entity page: ${String(cause)}`,
                  cause,
                }),
        });
        const facts = yield* match({ entityType: request.entityType }, prepared.basis);
        const ids = [...new Set(facts.map((triple) => triple.entityId))]
          .sort()
          .filter((id) => prepared.after === undefined || id > prepared.after);
        const selected = ids.slice(0, prepared.limit);
        const rows = yield* Effect.forEach(selected, (entityId) =>
          hexaStore
            .scanCollectTemporalAsync({ entity: entityId }, prepared.basis)
            .pipe(Effect.map((datoms) => datoms.map(datomToTriple))),
        );
        return {
          entities: rows.map((facts) =>
            facts.map((fact) =>
              tripleAtRecordedPosition(
                fact,
                prepared.basis.recordedAt === undefined
                  ? prepared.basis.recordedPosition
                  : undefined,
              ),
            ),
          ),
          snapshot: prepared.basis,
          ...(ids.length > prepared.limit
            ? { nextCursor: encodeEntityPageCursor(prepared, selected.at(-1)!) }
            : {}),
        };
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof PaginationCursorError
            ? cause
            : new ReadError({ message: `Entity page failed: ${String(cause)}`, cause }),
        ),
      ),

    match: (pattern, basis) =>
      Effect.gen(function* () {
        return yield* match(pattern, resolveTemporalBasis(basis, yield* runtime.now));
      }).pipe(
        Effect.map((facts) =>
          facts.map((fact) => tripleAtRecordedPosition(fact, basis?.recordedPosition)),
        ),
      ),

    liveFacts: (entityId) =>
      hexaStore.liveFacts(entityId).pipe(Effect.map((datoms) => datoms.map(datomToTriple))),

    history: (entityId: EntityId) =>
      Effect.gen(function* () {
        const datoms = yield* Stream.runCollect(hexaStore.entityHistory(entityId));
        return Array.from(datoms).map(datomToTriple);
      }).pipe(
        Effect.catch((e) =>
          Effect.fail(new ReadError({ message: `History failed: ${String(e)}`, cause: e })),
        ),
      ),

    transaction: (txId) =>
      Effect.gen(function* () {
        const datoms = yield* hexaStore.scanCollectAsync({ entity: txId });
        return transactionRecordFromTriples(txId, datoms.map(datomToTriple));
      }).pipe(
        Effect.catch((e) =>
          Effect.fail(
            new ReadError({ message: `Transaction read failed: ${String(e)}`, cause: e }),
          ),
        ),
      ),

    transactionByCommand: (commandId) =>
      Effect.gen(function* () {
        const commandFacts = yield* match({
          attribute: TxAttributes.COMMAND_ID,
          value: { type: "string", value: commandId },
        });
        const fact = commandFacts[0];
        if (fact === undefined) return null;
        const datoms = yield* hexaStore.scanCollectAsync({ entity: fact.entityId });
        return transactionRecordFromTriples(
          unsafe.transactionId(fact.entityId),
          datoms.map(datomToTriple),
        );
      }).pipe(
        Effect.catch((e) =>
          Effect.fail(
            new ReadError({ message: `Command transaction lookup failed: ${String(e)}`, cause: e }),
          ),
        ),
      ),

    transactions: (request = {}) => {
      const prefix = request.entityIdPrefix;
      const after = request.after ?? 0;
      const limit = request.limit ?? 100;
      if (!Number.isSafeInteger(after) || after < 0) {
        return Effect.fail(
          new ReadError({ message: "Transaction cursor must be a non-negative integer" }),
        );
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        return Effect.fail(
          new ReadError({ message: "Transaction page limit must be between 1 and 1000" }),
        );
      }
      if (prefix !== undefined) {
        if (typeof prefix !== "string")
          return Effect.fail(
            new ReadError({ message: "Transaction entityIdPrefix must be a string" }),
          );
        return Effect.gen(function* () {
          const head = yield* currentKvCommitPosition(kvBackend);
          const candidates = yield* hexaStore.transactionIdsForEntityPrefix(
            prefix,
            after,
            limit,
            head,
          );
          const page = [];
          for (const candidate of candidates) {
            // Global KV journal reads use TYPE order (journal fact ID), unlike EAVT's value order.
            const datoms = (yield* hexaStore.scanCollectAsync({ entity: candidate.txId }))
              .filter((datom) => datom.entityType === "_Transaction")
              .sort((a, b) => (a.tripleId < b.tripleId ? -1 : a.tripleId > b.tripleId ? 1 : 0));
            const record = transactionRecordFromTriples(
              unsafe.transactionId(candidate.txId),
              datoms.map(datomToTriple),
            );
            if (record === null || record.position !== candidate.position)
              return yield* new ReadError({ message: "Incomplete indexed transaction envelope" });
            page.push(record);
          }
          return {
            transactions: page,
            ...(page.length === 0 ? {} : { next: page.at(-1)!.position }),
          };
        });
      }
      return match({ entityType: "_Transaction" }).pipe(
        Effect.map((triples) => {
          const page = transactionRecordsFromTriples(triples)
            .filter((record) => record.position > after)
            .slice(0, limit);
          const last = page.at(-1);
          return {
            transactions: page,
            ...(last ? { next: last.position } : {}),
          };
        }),
      );
    },

    transactionsForEntity: (entityId, request) =>
      transactionsForEntity({ ...service, query: service.queryAll }, entityId, request),

    currentPosition: () => currentKvCommitPosition(kvBackend),

    resolveRecordedBasis: (basis) =>
      resolveRecordedBasis(
        () => currentKvCommitPosition(kvBackend),
        (instant, head) => recordedPositionAt(kvBackend, instant, head),
        runtime.now,
        basis,
      ),
    dependencyStateAll: (basis) =>
      Effect.gen(function* () {
        const resolved = resolveTemporalBasis(basis, yield* runtime.now);
        return dependencyStateFromDatoms(yield* dependencyProjections(kvBackend), resolved);
      }),
    dependencyState: (attributes, basis) =>
      Effect.gen(function* () {
        const unique = [...new Set(attributes)];
        if (unique.length === 0) return { sourcePosition: 0 };
        const resolved = resolveTemporalBasis(basis, yield* runtime.now);
        const batches = yield* Effect.forEach(
          unique,
          (attribute) => hexaStore.scanCollectAsync({ attribute }, { includeRetracted: true }),
          { concurrency: 16 },
        );
        return dependencyStateFromDatoms(batches.flat(), resolved);
      }),

    // === Datalog reads =====================================================

    queryAll: (q: DatalogQuery, options?: QueryOptions) =>
      Effect.gen(function* () {
        const query = yield* validateDatalogQuery(q);
        const currentTime = yield* runtime.now;
        const basis = yield* Effect.try({
          try: () => resolveQueryBasis(query, options?.basis, currentTime),
          catch: (cause) =>
            cause instanceof DatalogValidationError
              ? cause
              : new DatalogValidationError({ message: String(cause), query: q }),
        });
        const recordedPosition =
          basis.recordedPosition ?? (yield* currentKvCommitPosition(kvBackend));
        return yield* executeQuery(hexaStore, query, query.rules ?? [], {
          basis: { ...basis, recordedPosition },
        });
      }).pipe(
        Effect.map((result) => {
          const results = result.results as unknown as QueryResult;
          if (options?.debug) {
            const debug: QueryDebugInfo = {
              metrics: makeKvMetrics(q),
              executionTimeMs: 0,
              resultCount: result.results.length,
            };
            return { results, debug };
          }
          return { results };
        }),
        Effect.mapError((e) =>
          e instanceof DatalogValidationError || e instanceof UnboundVariableError
            ? e
            : new ReadError({ message: `Query execution failed: ${String(e)}`, cause: e }),
        ),
      ),

    query: (q, options) =>
      validateDatalogQuery(q).pipe(
        Effect.flatMap((validated) =>
          service.queryPage(wrapDatalogQuery(validated, options), options),
        ),
      ),

    queryPage: (q: WrappedQuery, options?: QueryOptions) =>
      Effect.gen(function* () {
        const query = yield* validateWrappedQuery(q);
        yield* Effect.try({
          try: () => assertQueryBasis(query.inner, options?.basis),
          catch: (cause) => cause as DatalogValidationError,
        });
        const currentTime = yield* runtime.now;
        const recordedPosition = yield* currentKvCommitPosition(kvBackend);
        const prepared = yield* Effect.try({
          try: () =>
            preparePagination({
              query,
              ...(options?.basis === undefined ? {} : { basis: options.basis }),
              now: currentTime,
              recordedPosition,
              scope: runtime.scope,
            }),
          catch: (cause) =>
            cause instanceof PaginationCursorError || cause instanceof DatalogValidationError
              ? cause
              : new PaginationCursorError({
                  reason: "malformed",
                  message: `Failed to prepare pagination: ${String(cause)}`,
                  cause,
                }),
        });
        const started = performance.now();
        const result = yield* executeWrappedQuery(
          hexaStore,
          prepared.query,
          prepared.query.inner.rules ?? [],
          {
            basis: prepared.basis,
            ...(prepared.cursorValues === undefined ? {} : { cursorValues: prepared.cursorValues }),
          },
        );
        return finishPagination(prepared, {
          results: result.results as unknown as QueryResult,
          ...(result.totalCount !== undefined ? { totalCount: result.totalCount } : {}),
          ...(options?.debug
            ? {
                debug: {
                  metrics: makeKvMetrics(query.inner),
                  executionTimeMs: performance.now() - started,
                  resultCount: result.results.length,
                },
              }
            : {}),
        });
      }).pipe(
        Effect.mapError((e) =>
          e instanceof PaginationCursorError
            ? e
            : e instanceof DatalogValidationError || e instanceof UnboundVariableError
              ? e
              : new ReadError({ message: `Wrapped query failed: ${String(e)}`, cause: e }),
        ),
      ),

    explain: (q: DatalogQuery) =>
      validateDatalogQuery(q).pipe(
        Effect.map((query) => ({
          queryPlan: {
            backend: "kv-store" as const,
            steps: [{ label: "main", query: explainAccessPaths(query) }],
          },
          metrics: makeKvMetrics(query),
        })),
      ),

    explainPage: (q: WrappedQuery) =>
      validateWrappedQuery(q).pipe(
        Effect.map((query) => ({
          queryPlan: {
            backend: "kv-store" as const,
            steps: [{ label: "main", query: explainAccessPaths(query.inner) }],
          },
        })),
      ),
  };

  return service;
});

// ─── Layers ────────────────────────────────────────────────────────────────

/**
 * Layer providing the merged `Triples` service backed by the KV hexastore.
 * Requires a `KvBackend` (in-memory, FoundationDB, Cloudflare, …) and a
 * `TripleStoreRuntime` (clock + id generation).
 */
export const KvTriplesLive: Layer.Layer<Triples, never, KvBackend | TripleStoreRuntime> =
  Layer.effect(Triples, makeKvTriplesService) as unknown as Layer.Layer<
    Triples,
    never,
    KvBackend | TripleStoreRuntime
  >;

/**
 * Convenience namespace for wiring KV-backed `Triples`.
 */
export const KvTriples = {
  /** Call repeatedly until complete after upgrading every writer of an existing KV store. */
  migrateLiveFacts: (options: { readonly batchSize?: number } = {}) =>
    Effect.gen(function* () {
      const kv = yield* KvBackend;
      return yield* migrateKvLiveFacts(kv, options.batchSize);
    }),
  /**
   * `Triples` over the KV hexastore, requiring only a `KvBackend` and
   * `TripleStoreRuntime`. Use this to reuse a real KV backend (e.g. FDB).
   */
  layerBackend: KvTriplesLive,

  /**
   * Fully self-contained in-memory `Triples` — bundles a **fresh** in-memory KV
   * backend and the default runtime. One line to a working store:
   *
   * ```ts
   * program.pipe(Effect.provide(KvTriples.layer))
   * ```
   *
   * Each instantiation gets its own isolated store (unlike the shared
   * `InMemoryKvBackendLive` singleton), which is what you want for tests and
   * ephemeral workloads.
   */
  layer: KvTriplesLive.pipe(
    Layer.provide(Layer.sync(KvBackend, makeTestKvBackend)),
    Layer.provide(TripleStoreRuntimeLayer),
  ),

  /** Fresh in-memory store with an explicit opaque-cursor scope identity. */
  layerWithScope: (scope: string) =>
    KvTriplesLive.pipe(
      Layer.provide(Layer.sync(KvBackend, makeTestKvBackend)),
      Layer.provide(makeTripleStoreRuntimeLayer(`kv:memory:${scope}`)),
    ),
} as const;
