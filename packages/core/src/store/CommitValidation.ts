/**
 * Commit validators: host checks that run inside a `Triples` transaction.
 *
 * A validator runs after the transaction's operations and journal envelope
 * have been applied and before it commits. It reads the database exactly as
 * it will be after commit (`after`) and as it was at the last committed
 * position (`before`), and may reject the whole transaction with typed,
 * structured findings. Rejection rolls back facts, journal, command receipt,
 * and commit position together.
 *
 * Validators are installed per call through `TransactionMeta.validate`, or
 * for every application transaction through {@link layer}, which decorates any
 * `Layer<Triples>` and also owns optional rejection auditing.
 */

import { Context, Effect, Layer, Option } from "effect";

import type { EntityId, TransactionId } from "../Branded.js";
import { unsafe } from "../Branded.js";
import {
  CommandAlreadyCommittedError,
  CommitRejectedError,
  TransactionConflictError,
  WriteError,
  type DatalogQueryError,
  type ReadError,
} from "../errors/index.js";
import type { EntryKind, PendingEntriesPage, PendingEntriesRequest } from "../operational/Entry.js";
import type { DatalogQuery } from "../datalog/types.js";
import type { QueryResult } from "../storage/QueryExecutor.js";
import type { Triple, TripleInput, TransactOp } from "../Triple.js";
import type { Pattern } from "../types/Pattern.js";
import { datetime, json, number, string, type TripleValue } from "../Value.js";
import { isSystemWriteAuthorized, transactSystem } from "./systemNamespace.js";
import { Triples, type TransactionChange, type TriplesService } from "./Triples.js";

// =============================================================================
// Contract
// =============================================================================

/** One finding returned by a validator. Any finding rejects the transaction. */
export interface Rejection {
  /** Stable machine-readable code, e.g. `not_asserter`. */
  readonly code: string;
  /** Human-readable explanation. */
  readonly message: string;
  /** Subject entity of the finding, when there is one. */
  readonly entityId?: EntityId;
  /** Attribute the finding concerns, when there is one. */
  readonly attribute?: string;
  /** Host-defined location, such as a form field path. */
  readonly path?: readonly (string | number)[];
  /** JSON-serializable evidence. */
  readonly details?: { readonly [key: string]: unknown };
  /** What the caller could do instead. */
  readonly suggestion?: string;
}

/** A finding stamped with the name of the validator that produced it. */
export interface CommitRejection extends Rejection {
  readonly validator: string;
}

/** The attempted transaction envelope. Its `txId` never commits if rejected. */
export interface Attempt {
  readonly txId: TransactionId;
  readonly instant: number;
  /** Last committed position; the `before` view reads at exactly this cut. */
  readonly basisPosition: number;
  readonly actor?: string;
  readonly commandId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly configSnapshot?: string;
}

export interface ViewOptions {
  /** Business-time instant. Defaults to the transaction instant. */
  readonly validAt?: number;
}

/**
 * Read-only view of the database at one exact commit cut. Reads use the same
 * indexed paths as ordinary reads; no snapshot is materialized.
 */
export interface View {
  /** Operational entries at this cut, including acknowledgements visible then. */
  readonly operationalEntry: TriplesService["operationalEntry"];
  /** Pending inbox/outbox entries at this cut. Cursors belong to this view. */
  readonly pendingOperationalEntries: (
    kind: EntryKind,
    request?: PendingEntriesRequest,
  ) => Effect.Effect<PendingEntriesPage, ReadError>;
  /** Commit position this view reads at. */
  readonly position: number;
  readonly entity: (
    entityId: EntityId,
    options?: ViewOptions,
  ) => Effect.Effect<readonly Triple[], ReadError>;
  readonly entities: (
    entityIds: readonly EntityId[],
    options?: ViewOptions,
  ) => Effect.Effect<readonly (readonly Triple[])[], ReadError>;
  readonly match: (
    pattern: Pattern,
    options?: ViewOptions,
  ) => Effect.Effect<readonly Triple[], ReadError>;
  /** Complete (unpaged) Datalog at this view's cut. */
  readonly query: (
    query: DatalogQuery,
    options?: ViewOptions,
  ) => Effect.Effect<QueryResult, ReadError | DatalogQueryError>;
}

/** Everything a validator may inspect. */
export interface CommitContext {
  readonly transaction: Attempt;
  /** Resolved assertions and retractions, exactly as the journal records them. */
  readonly changes: readonly TransactionChange[];
  /** The database at the last committed position. */
  readonly before: View;
  /** The database as it will be if this transaction commits, envelope included. */
  readonly after: View;
}

/**
 * Return rejections to refuse the transaction, or nothing (or an empty array)
 * to accept it. Failing with an error also aborts the transaction, as a
 * `WriteError` naming the validator: a validator that cannot decide never
 * accepts.
 */
export type ValidationResult = readonly Rejection[] | undefined | void;

export interface Validator<R = never> {
  readonly name: string;
  readonly validate: (
    context: CommitContext,
  ) => Effect.Effect<ValidationResult, ReadError | DatalogQueryError, R>;
}

/** Define a named validator. Names identify validators in errors and audit records. */
export const make = <R = never>(
  name: string,
  validate: Validator<R>["validate"],
): Validator<R> => ({ name, validate });

// =============================================================================
// Rejection audit records
// =============================================================================

export const System = {
  prefix: "_triplex/commit-rejection/",
  entityType: "triplex.commit-rejection",
  commandPrefix: "triplex/commit-rejection/",
  attribute: {
    attempt: ":triplex/commit-rejection-attempt",
    instant: ":triplex/commit-rejection-instant",
    basisPosition: ":triplex/commit-rejection-basis-position",
    actor: ":triplex/commit-rejection-actor",
    commandId: ":triplex/commit-rejection-command-id",
    correlationId: ":triplex/commit-rejection-correlation-id",
    causationId: ":triplex/commit-rejection-causation-id",
    configSnapshot: ":triplex/commit-rejection-config-snapshot",
    validator: ":triplex/commit-rejection-validator",
    finding: ":triplex/commit-rejection-finding",
    change: ":triplex/commit-rejection-change",
  },
} as const;

/** Reference to a durable rejection record. */
export interface RecordedReference {
  readonly entityId: EntityId;
  /** The system transaction that wrote the record (not the rejected attempt). */
  readonly txId: TransactionId;
}

/** A rejection record read back from the database. */
export interface RecordedRejection {
  readonly entityId: EntityId;
  readonly attempt: Attempt;
  readonly validators: readonly string[];
  readonly rejections: readonly CommitRejection[];
  readonly changes: readonly TransactionChange[];
}

/** Deterministic record identity for one attempted transaction. */
export const rejectionEntityId = (attemptTxId: TransactionId): EntityId =>
  unsafe.entityId(`${System.prefix}${attemptTxId.replace(/^_tx\//, "")}`);

const recordOperations = (error: CommitRejectedError): readonly TransactOp[] => {
  const entityId = rejectionEntityId(error.attempt.txId);
  const assert = (attribute: string, value: TripleValue) =>
    ({
      op: "assert",
      entityId,
      entityType: System.entityType,
      attribute,
      value,
    }) as const;
  const { attempt } = error;
  return [
    assert(System.attribute.attempt, string(attempt.txId)),
    assert(System.attribute.instant, datetime(attempt.instant)),
    assert(System.attribute.basisPosition, number(attempt.basisPosition)),
    ...(attempt.actor === undefined ? [] : [assert(System.attribute.actor, string(attempt.actor))]),
    ...(attempt.commandId === undefined
      ? []
      : [assert(System.attribute.commandId, string(attempt.commandId))]),
    ...(attempt.correlationId === undefined
      ? []
      : [assert(System.attribute.correlationId, string(attempt.correlationId))]),
    ...(attempt.causationId === undefined
      ? []
      : [assert(System.attribute.causationId, string(attempt.causationId))]),
    ...(attempt.configSnapshot === undefined
      ? []
      : [assert(System.attribute.configSnapshot, string(attempt.configSnapshot))]),
    ...error.validators.map((name) => assert(System.attribute.validator, string(name))),
    ...error.rejections.map((rejection, index) =>
      assert(System.attribute.finding, json({ index, ...rejection })),
    ),
    ...error.changes.map((change, index) =>
      assert(System.attribute.change, json({ index, ...change })),
    ),
  ];
};

/**
 * Durably record a rejected attempt as a reserved system entity. Call this
 * after the rollback has completed, including after a host's enclosing SQL
 * transaction rolled back. Idempotent per attempted transaction.
 */
export const recordRejection = (
  triples: TriplesService,
  error: CommitRejectedError,
): Effect.Effect<RecordedReference, WriteError | ReadError> => {
  const entityId = rejectionEntityId(error.attempt.txId);
  return transactSystem(triples, recordOperations(error), {
    commandId: `${System.commandPrefix}${error.attempt.txId}`,
    ...(error.attempt.correlationId === undefined
      ? {}
      : { correlationId: error.attempt.correlationId }),
  }).pipe(
    Effect.map((result) => ({ entityId, txId: result.txId })),
    Effect.catch((cause) =>
      cause instanceof CommandAlreadyCommittedError
        ? Effect.succeed({ entityId, txId: cause.transactionId })
        : cause._tag === "WriteError" || cause._tag === "ReadError"
          ? Effect.fail(cause)
          : Effect.fail(
              new WriteError({
                message: `Failed to record commit rejection: ${cause.message}`,
                cause,
              }),
            ),
    ),
  );
};

const sortedPayloads = (triples: readonly Triple[], attribute: string): unknown[] =>
  triples
    .flatMap((triple) =>
      triple.attribute === attribute && triple.value.type === "json"
        ? [triple.value.value as { readonly index?: number }]
        : [],
    )
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
    .map(({ index: _index, ...payload }) => payload);

/** Read a durable rejection record, or `null` when it does not exist. */
export const readRejection = (
  triples: TriplesService,
  entityId: EntityId,
): Effect.Effect<RecordedRejection | null, ReadError> =>
  triples.entity(entityId).pipe(
    Effect.map((facts) => {
      const records = facts.filter(
        (fact) => Option.isSome(fact.entityType) && fact.entityType.value === System.entityType,
      );
      if (records.length === 0) return null;
      const text = (attribute: string) => {
        const value = records.find((fact) => fact.attribute === attribute)?.value;
        return value?.type === "string" ? value.value : undefined;
      };
      const numeric = (attribute: string) => {
        const value = records.find((fact) => fact.attribute === attribute)?.value;
        return value?.type === "number" || value?.type === "datetime" ? value.value : undefined;
      };
      const txId = text(System.attribute.attempt);
      const instant = numeric(System.attribute.instant);
      const basisPosition = numeric(System.attribute.basisPosition);
      if (txId === undefined || instant === undefined || basisPosition === undefined) return null;
      const optional = (key: keyof Attempt, attribute: string) => {
        const value = text(attribute);
        return value === undefined ? {} : { [key]: value };
      };
      return {
        entityId,
        attempt: {
          txId: unsafe.transactionId(txId),
          instant,
          basisPosition,
          ...optional("actor", System.attribute.actor),
          ...optional("commandId", System.attribute.commandId),
          ...optional("correlationId", System.attribute.correlationId),
          ...optional("causationId", System.attribute.causationId),
          ...optional("configSnapshot", System.attribute.configSnapshot),
        } as Attempt,
        validators: records
          .filter((fact) => fact.attribute === System.attribute.validator)
          .sort((left, right) => left.id.localeCompare(right.id))
          .flatMap((fact) => (fact.value.type === "string" ? [fact.value.value] : [])),
        rejections: sortedPayloads(records, System.attribute.finding) as CommitRejection[],
        changes: sortedPayloads(records, System.attribute.change) as TransactionChange[],
      } satisfies RecordedRejection;
    }),
  );

// =============================================================================
// Runtime-wide installation
// =============================================================================

export interface LayerOptions<R = never> {
  /** Validators run on every application transaction, before per-call validators. */
  readonly validators: readonly Validator<R>[];
  /**
   * After rollback, durably record each rejection as a reserved
   * `triplex.commit-rejection` entity. Leave this off when transactions run
   * inside a host-owned SQL transaction that the host then rolls back; call
   * {@link recordRejection} after that rollback instead.
   */
  readonly recordRejections?: boolean;
  /**
   * Runs after rollback (and after recording, when enabled) for rejections
   * from runtime-wide and per-call validators alike. Failures are logged.
   */
  readonly onRejected?: (error: CommitRejectedError) => Effect.Effect<void, unknown, R>;
}

/**
 * Decorate `Triples` so every application transaction runs these validators.
 *
 * ```ts
 * const Database = CommitValidation.layer({ validators: [asserters] }).pipe(
 *   Layer.provide(SqliteTriples.layerMemory),
 * )
 * ```
 *
 * The validators' requirements are captured once when the layer is built.
 * Triplex system writes (configuration, validation, derivation, checkpoint,
 * and rejection records) are not subject to runtime-wide validators.
 */
export const layer = <R = never>(
  options: LayerOptions<R>,
): Layer.Layer<Triples, never, Triples | R> =>
  Layer.effect(
    Triples,
    Effect.gen(function* () {
      const inner = yield* Triples;
      const captured = yield* Effect.context<R>();
      // The live fiber context wins: it carries transaction-local services such
      // as Effect SQL's transaction connection, which must not be replaced.
      const provide = <A, E>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
        Effect.updateContext(effect, (current: Context.Context<never>) =>
          Context.merge(captured, current),
        ) as Effect.Effect<A, E>;
      const installed: readonly Validator[] = options.validators.map((validator) => ({
        name: validator.name,
        validate: (context) => provide(validator.validate(context)),
      }));
      return decorate(inner, {
        validators: installed,
        recordRejections: options.recordRejections ?? false,
        ...(options.onRejected === undefined
          ? {}
          : { onRejected: (error: CommitRejectedError) => provide(options.onRejected!(error)) }),
      });
    }),
  );

interface Installed {
  readonly validators: readonly Validator[];
  readonly recordRejections: boolean;
  readonly onRejected?: (error: CommitRejectedError) => Effect.Effect<void, unknown>;
}

const decorate = (inner: TriplesService, installed: Installed): TriplesService => {
  const audit = (error: CommitRejectedError): Effect.Effect<CommitRejectedError> =>
    Effect.gen(function* () {
      let result = error;
      if (installed.recordRejections) {
        const recorded = yield* recordRejection(inner, error).pipe(
          Effect.map(Option.some),
          Effect.catch((cause) =>
            Effect.logError("Failed to record commit rejection", cause).pipe(
              Effect.as(Option.none<RecordedReference>()),
            ),
          ),
        );
        if (Option.isSome(recorded)) {
          result = new CommitRejectedError({ ...error, recorded: recorded.value });
        }
      }
      if (installed.onRejected !== undefined) {
        yield* installed
          .onRejected(result)
          .pipe(
            Effect.catchCause((cause) => Effect.logError("Commit rejection hook failed", cause)),
          );
      }
      return result;
    });

  const transact: TriplesService["transact"] = (operations, meta) => {
    if (isSystemWriteAuthorized(meta)) return inner.transact(operations, meta);
    const validate = [...installed.validators, ...(meta?.validate ?? [])];
    return inner
      .transact(operations, validate.length === 0 ? meta : { ...meta, validate })
      .pipe(
        Effect.catchTag("CommitRejectedError", (error) =>
          audit(error).pipe(Effect.flatMap(Effect.fail)),
        ),
      );
  };

  const assertOp = (input: TripleInput): TransactOp => ({
    op: "assert",
    entityId: input.entityId,
    attribute: input.attribute,
    value: input.value,
    entityType: input.entityType,
    createdBy: input.createdBy,
    validFrom: input.validFrom,
    validTo: input.validTo,
  });

  const toWriteFailure =
    (message: string) =>
    <E extends { readonly _tag: string }>(cause: E): WriteError | TransactionConflictError =>
      cause instanceof WriteError || cause instanceof TransactionConflictError
        ? cause
        : new WriteError({ message, cause });

  return {
    ...inner,
    transact,
    assert: (input) =>
      transact([assertOp(input)]).pipe(
        Effect.map((result) => result.triples[0]!),
        Effect.mapError(toWriteFailure("Failed to assert triple")),
      ),
    assertBatch: (inputs) =>
      inputs.length === 0
        ? Effect.succeed([])
        : transact(inputs.map(assertOp)).pipe(
            Effect.map((result) => result.triples),
            Effect.mapError(toWriteFailure("Failed to assert triple batch")),
          ),
    retract: (id) =>
      transact([{ op: "retract", id }]).pipe(
        Effect.flatMap((result) =>
          result.retracted === 1
            ? Effect.void
            : Effect.fail(
                new WriteError({ message: `Triple not found or already retracted: ${id}` }),
              ),
        ),
        Effect.mapError(toWriteFailure(`Failed to retract triple: ${id}`)),
      ),
    retractByPattern: (pattern) =>
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
          cause._tag === "ReadError"
            ? cause
            : toWriteFailure("Failed to retract by pattern")(cause),
        ),
      ),
  };
};
