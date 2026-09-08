/**
 * TriplesLive — the canonical `Triples` implementation over `StorageAdapter`
 * plus `QueryExecutor`.
 *
 * Writes and triple-level reads go through the `StorageAdapter` abstraction so
 * every SQL backend (SQLite, PostgreSQL, Cloudflare DO, …) can use its optimal
 * primitives. Datalog reads go through the `QueryExecutor` SPI (compiles
 * Datalog → SQL for SQL backends).
 *
 * The same service owns storage mutations and query execution.
 */

import { Effect, Layer, Option } from "effect";
import {
  Triples,
  type TriplesService,
  type TransactionResult,
  type TransactionMeta,
  type QueryOptions,
  type PagedQueryOptions,
} from "./Triples.js";
import { StorageAdapter } from "../storage/StorageAdapter.js";
import { QueryExecutor } from "../storage/QueryExecutor.js";
import type {
  Triple,
  TripleInput,
  TripleId,
  EntityId,
  Attribute,
  TripleRow,
  TransactOp,
} from "../Triple.js";
import { queryToPattern } from "../Triple.js";
import type { Pattern } from "../types/Pattern.js";
import type { DatalogQuery, WrappedQuery } from "../datalog/types.js";
import { validateDatalogQuery, validateWrappedQuery } from "../datalog/validation.js";
import {
  WriteError,
  ReadError,
  DatalogError,
  DatalogValidationError,
  UnboundVariableError,
  CommandAlreadyCommittedError,
  TransactionConflictError,
  ConstraintViolationError,
  PaginationCursorError,
} from "../errors/index.js";
import { unsafe } from "../Branded.js";
import * as Constraint from "../Constraint.js";
import { TripleStoreRuntime } from "./TripleStoreRuntime.js";
import {
  invalidCommandId,
  livePreconditionIds,
  metadataInputs,
  transactionRecordFromTriples,
  transactionRecordsFromTriples,
  transactionChangeFromTriple,
  validatePreconditions,
} from "./transactionMetadata.js";
import {
  isJournalSuppressed,
  isSystemWriteAuthorized,
  reservedAssertError,
  reservedWriteError,
} from "./systemNamespace.js";
import { resolveTemporalBasis } from "../Temporal.js";
import { TxAttributes } from "../utils/id.js";
import { finishPagination, preparePagination, wrapDatalogQuery } from "../Pagination.js";
import { transactionsForEntity } from "./entityTransactionHistory.js";

// =============================================================================
// Row to Triple Conversion
// =============================================================================

const rowToTriple = (row: TripleRow): Triple => {
  let value: Triple["value"];
  switch (row.value_type) {
    case "string":
      value = { type: "string", value: row.value_string ?? "" };
      break;
    case "number":
      value = { type: "number", value: row.value_number ?? 0 };
      break;
    case "boolean":
      value = { type: "boolean", value: row.value_boolean === 1 };
      break;
    case "datetime":
      value = { type: "datetime", value: row.value_datetime ?? 0 };
      break;
    case "ref":
      value = { type: "ref", value: unsafe.entityId(row.value_string ?? "") };
      break;
    case "json":
      value = { type: "json", value: row.value_json ? JSON.parse(row.value_json) : null };
      break;
    case "blob": {
      const meta = row.value_json ? JSON.parse(row.value_json) : {};
      value = {
        type: "blob",
        value: row.value_string ?? "",
        mimeType: meta.mimeType ?? "application/octet-stream",
        size: meta.size ?? 0,
        ...(meta.filename && { filename: meta.filename }),
      };
      break;
    }
    default:
      value = { type: "string", value: "" };
  }

  return {
    id: row.id as TripleId,
    entityId: row.entity_id as EntityId,
    attribute: row.attribute as Attribute,
    value,
    recordedAt: Number(row.recorded_at),
    validFrom: Number(row.valid_from),
    validTo: row.valid_to !== null ? Option.some(Number(row.valid_to)) : Option.none(),
    createdBy: row.created_by ? Option.some(row.created_by) : Option.none(),
    retractedAt: row.retracted_at !== null ? Option.some(Number(row.retracted_at)) : Option.none(),
    entityType: row.entity_type ? Option.some(row.entity_type) : Option.none(),
    schemaVersion: row.schema_version ? Option.some(row.schema_version) : Option.none(),
    txId: row.tx_id ? Option.some(unsafe.transactionId(row.tx_id)) : Option.none(),
    retractTxId: row.retract_tx_id
      ? Option.some(unsafe.transactionId(row.retract_tx_id))
      : Option.none(),
  };
};

// =============================================================================
// Triples Layer using StorageAdapter + QueryExecutor
// =============================================================================

export const TriplesLive = Layer.effect(
  Triples,
  Effect.gen(function* () {
    const adapter = yield* StorageAdapter;
    const executor = yield* QueryExecutor;
    const runtime = yield* TripleStoreRuntime;
    const now = runtime.now;
    const nextTripleId = runtime.nextTripleId;
    const nextTxId = runtime.nextTxId;

    // Initialize storage (creates tables, indexes, etc.)
    yield* adapter.initialize();

    // =========================================================================
    // Write Operations
    // =========================================================================

    const assert_ = (input: TripleInput): Effect.Effect<Triple, WriteError> =>
      transact([
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
          cause instanceof WriteError
            ? cause
            : new WriteError({ message: "Failed to assert triple", cause }),
        ),
      );

    const assertBatch = (
      inputs: readonly TripleInput[],
    ): Effect.Effect<readonly Triple[], WriteError> => {
      if (inputs.length === 0) return Effect.succeed([]);

      return transact(
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
          cause instanceof WriteError
            ? cause
            : new WriteError({ message: "Failed to assert triple batch", cause }),
        ),
      );
    };

    /**
     * Flush a batch of consecutive assert ops using adapter.batchInsert().
     * Falls back to a single adapter.insert() for batches of 1.
     */
    const flushAssertBatch = (
      assertOps: readonly TransactOp[],
      txId: string,
      timestamp: number,
      position: number,
      actor?: string,
    ): Effect.Effect<Triple[], WriteError> =>
      Effect.gen(function* () {
        if (assertOps.length === 0) return [];

        const inputs: TripleInput[] = assertOps.map((op) => {
          if (op.op !== "assert") throw new Error("unreachable");
          return {
            entityId: op.entityId,
            attribute: op.attribute,
            value: op.value,
            entityType: op.entityType,
            createdBy: op.createdBy ?? actor,
            validFrom: op.validFrom,
            validTo: op.validTo,
          };
        });

        if (inputs.length === 1) {
          const row = yield* adapter.insert(
            inputs[0]!,
            txId,
            timestamp,
            yield* nextTripleId,
            position,
          );
          return [rowToTriple(row)];
        }

        const rows = yield* adapter.batchInsert(
          inputs,
          txId,
          timestamp,
          yield* Effect.all(inputs.map(() => nextTripleId)),
          position,
        );
        return rows.map(rowToTriple);
      });

    const transact = (
      operations: readonly TransactOp[],
      meta?: TransactionMeta,
    ): Effect.Effect<
      TransactionResult,
      | WriteError
      | ReadError
      | TransactionConflictError
      | CommandAlreadyCommittedError
      | ConstraintViolationError
    > =>
      adapter.withTransaction(
        Effect.gen(function* () {
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
          const txId = yield* nextTxId;
          const timestamp = yield* now;
          if (meta?.commandId !== undefined) {
            const originalTransactionId = yield* adapter.claimCommand(
              meta.commandId,
              txId,
              timestamp,
            );
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
          const position = yield* adapter.nextCommitPosition();
          const actor = meta?.actor;
          const preconditionIds = livePreconditionIds(meta);

          if (meta?.enforce !== undefined) {
            const current = yield* Constraint.loadRelevantFacts(
              meta.enforce.constraints,
              operations,
              {
                byEntityType: (entityType) =>
                  adapter.query({ entityType }).pipe(Effect.map((rows) => rows.map(rowToTriple))),
                byEntities: (entityIds) =>
                  adapter
                    .getByEntities(entityIds)
                    .pipe(
                      Effect.map((rows) =>
                        entityIds.flatMap((entityId) =>
                          (rows.get(entityId) ?? []).map(rowToTriple),
                        ),
                      ),
                    ),
              },
            );
            const violations = yield* Constraint.newlyViolated(
              current,
              operations,
              meta.enforce.constraints,
              timestamp,
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
                  message: `Transaction would introduce or worsen ${violations.length} graph constraint violation${violations.length === 1 ? "" : "s"}`,
                }),
              );
            }
          }

          const triples: Triple[] = [];
          const changes: import("./Triples.js").TransactionChange[] = [];
          let retractedCount = 0;

          let pendingAsserts: TransactOp[] = [];

          for (const op of operations) {
            if (op.op === "assert") {
              pendingAsserts.push(op);
              continue;
            }

            if (pendingAsserts.length > 0) {
              const batch = yield* flushAssertBatch(
                pendingAsserts,
                txId,
                timestamp,
                position,
                actor,
              );
              triples.push(...batch);
              changes.push(
                ...batch.map((triple) =>
                  transactionChangeFromTriple("assert", triple, txId, timestamp),
                ),
              );
              pendingAsserts = [];
            }

            switch (op.op) {
              case "retract": {
                const current = yield* adapter.getById(op.id as string);
                if (current && !isSystemWriteAuthorized(meta)) {
                  const reserved = reservedWriteError({
                    entityId: current.entity_id,
                    attribute: current.attribute,
                    entityType: current.entity_type ?? undefined,
                  });
                  if (reserved) return yield* Effect.fail(reserved);
                }
                const didRetract = yield* adapter.retract(
                  op.id as string,
                  timestamp,
                  txId,
                  position,
                );
                if (!didRetract && preconditionIds.has(op.id as string)) {
                  return yield* Effect.fail(
                    new TransactionConflictError({
                      tripleId: op.id,
                      message: `Expected live triple ${op.id}, but another transaction changed it`,
                    }),
                  );
                }
                if (didRetract) {
                  retractedCount++;
                  if (current) {
                    changes.push(
                      transactionChangeFromTriple("retract", rowToTriple(current), txId, timestamp),
                    );
                  }
                }
                break;
              }
              case "retract-pattern": {
                const pattern = queryToPattern(op.pattern);
                const matched = yield* adapter.query(pattern);
                if (!isSystemWriteAuthorized(meta)) {
                  for (const row of matched) {
                    const reserved = reservedWriteError({
                      entityId: row.entity_id,
                      attribute: row.attribute,
                      entityType: row.entity_type ?? undefined,
                    });
                    if (reserved) return yield* Effect.fail(reserved);
                  }
                }
                for (const row of matched) {
                  if (yield* adapter.retract(row.id, timestamp, txId, position)) {
                    retractedCount++;
                    changes.push(
                      transactionChangeFromTriple("retract", rowToTriple(row), txId, timestamp),
                    );
                  }
                }
                break;
              }
            }
          }

          if (pendingAsserts.length > 0) {
            const batch = yield* flushAssertBatch(pendingAsserts, txId, timestamp, position, actor);
            triples.push(...batch);
            changes.push(
              ...batch.map((triple) =>
                transactionChangeFromTriple("assert", triple, txId, timestamp),
              ),
            );
          }

          if (!isJournalSuppressed(meta)) {
            for (const input of metadataInputs(txId, position, timestamp, meta, changes)) {
              yield* adapter.insert(input, txId, timestamp, yield* nextTripleId, position);
            }
          }

          return { txId, position, instant: timestamp, triples, retracted: retractedCount };
        }),
      );

    const retract = (id: TripleId): Effect.Effect<void, WriteError> =>
      transact([{ op: "retract", id }]).pipe(
        Effect.flatMap((result) =>
          result.retracted === 1
            ? Effect.void
            : Effect.fail(
                new WriteError({ message: `Triple not found or already retracted: ${id}` }),
              ),
        ),
        Effect.mapError((cause) =>
          cause instanceof WriteError
            ? cause
            : new WriteError({ message: `Failed to retract triple: ${id}`, cause }),
        ),
      );

    const retractByPattern = (pattern: Pattern): Effect.Effect<number, WriteError | ReadError> =>
      transact([
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
          cause instanceof WriteError || cause instanceof ReadError
            ? cause
            : new WriteError({ message: "Failed to retract by pattern", cause }),
        ),
      );

    // =========================================================================
    // Triple-level Reads
    // =========================================================================

    const get = (id: TripleId): Effect.Effect<Triple | null, ReadError> =>
      Effect.gen(function* () {
        const row = yield* adapter.getById(id);
        return row ? rowToTriple(row) : null;
      });

    const entity: TriplesService["entity"] = (entityId, basis) =>
      Effect.gen(function* () {
        const resolved = resolveTemporalBasis(basis, yield* now);
        const rows = yield* adapter.getByEntity(entityId, resolved);
        return rows.map(rowToTriple);
      });

    const entities: TriplesService["entities"] = (entityIds, basis) =>
      Effect.gen(function* () {
        const resolved = resolveTemporalBasis(basis, yield* now);
        const rows = yield* adapter.getByEntities(entityIds, resolved);
        return entityIds.map((id) => (rows.get(id) ?? []).map(rowToTriple));
      });

    const match: TriplesService["match"] = (pattern, basis) =>
      Effect.gen(function* () {
        const resolved = resolveTemporalBasis(basis, yield* now);
        const rows = yield* adapter.query(pattern, resolved);
        return rows.map(rowToTriple);
      });

    const history = (entityId: EntityId): Effect.Effect<readonly Triple[], ReadError> =>
      Effect.gen(function* () {
        const rows = yield* adapter.history(entityId);
        return rows.map(rowToTriple);
      });

    const transaction: TriplesService["transaction"] = (txId) =>
      adapter
        .query({ entityId: unsafe.entityId(txId), entityType: "_Transaction" })
        .pipe(Effect.map((rows) => transactionRecordFromTriples(txId, rows.map(rowToTriple))));

    const transactionByCommand: TriplesService["transactionByCommand"] = (commandId) =>
      adapter
        .query({ attribute: TxAttributes.COMMAND_ID, value: { type: "string", value: commandId } })
        .pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeed(null)
              : transaction(unsafe.transactionId(rows[0].entity_id)),
          ),
        );

    const transactions: TriplesService["transactions"] = (request = {}) => {
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
      return adapter.query({ entityType: "_Transaction" }).pipe(
        Effect.map((rows) => {
          const page = transactionRecordsFromTriples(rows.map(rowToTriple))
            .filter((record) => record.position > after)
            .slice(0, limit);
          const last = page.at(-1);
          return {
            transactions: page,
            ...(last ? { next: last.position } : {}),
          };
        }),
      );
    };

    const entityTransactions: TriplesService["transactionsForEntity"] = (entityId, request) =>
      transactionsForEntity(
        { currentPosition: adapter.currentCommitPosition, query: queryAll, transaction },
        entityId,
        request,
      );

    // =========================================================================
    // Datalog Reads (via QueryExecutor)
    // =========================================================================

    const queryAll = (q: DatalogQuery, options?: QueryOptions) =>
      Effect.gen(function* () {
        const basis = resolveTemporalBasis(options?.basis, yield* now);
        return yield* executor.execute(q, options?.debug ?? false, basis);
      }).pipe(Effect.withSpan("triples.query"));

    const queryPage = (q: WrappedQuery, options?: QueryOptions) =>
      Effect.gen(function* () {
        const query = yield* validateWrappedQuery(q);
        const currentTime = yield* now;
        const recordedPosition = yield* adapter.currentCommitPosition();
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
            cause instanceof PaginationCursorError
              ? cause
              : new PaginationCursorError({
                  reason: "malformed",
                  message: `Failed to prepare pagination: ${String(cause)}`,
                  cause,
                }),
        });
        const result = yield* executor.executePage(
          prepared.query,
          options?.debug ?? false,
          prepared.basis,
          prepared.cursorValues,
        );
        return finishPagination(prepared, result);
      }).pipe(Effect.withSpan("triples.queryPage"));

    const query = (q: DatalogQuery, options?: PagedQueryOptions) =>
      validateDatalogQuery(q).pipe(
        Effect.flatMap((validated) => queryPage(wrapDatalogQuery(validated, options), options)),
      );

    const explain = (q: DatalogQuery) =>
      executor.explain(q).pipe(
        Effect.mapError((error) =>
          error instanceof DatalogValidationError || error instanceof UnboundVariableError
            ? error
            : new DatalogError({ message: error.message, cause: error.cause }),
        ),
        Effect.withSpan("triples.explain"),
      );

    const explainPage = (q: WrappedQuery) =>
      executor.explainPage(q).pipe(
        Effect.mapError((error) =>
          error instanceof DatalogValidationError || error instanceof UnboundVariableError
            ? error
            : new DatalogError({ message: error.message, cause: error.cause }),
        ),
        Effect.withSpan("triples.explainPage"),
      );

    return {
      assert: assert_,
      assertBatch,
      retract,
      retractByPattern,
      transact,
      get,
      entity,
      entities,
      match,
      history,
      transaction,
      transactionByCommand,
      transactions,
      transactionsForEntity: entityTransactions,
      currentPosition: adapter.currentCommitPosition,
      dependencyState: (attributes, basis) =>
        Effect.gen(function* () {
          const resolved = resolveTemporalBasis(basis, yield* now);
          return yield* adapter.dependencyState(attributes, resolved);
        }),
      query,
      queryPage,
      queryAll,
      explain,
      explainPage,
    } satisfies TriplesService;
  }),
);
