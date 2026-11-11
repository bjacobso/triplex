import { Effect } from "effect";

import type { TransactOp } from "../Triple.js";
import { WriteError, type CommitRejectedError } from "../errors/index.js";
import type { TransactionMeta, TransactionResult, TriplesService } from "./Triples.js";

const systemWriteAuthorization: unique symbol = Symbol("triplex/SystemWriteAuthorization");
const journalSuppression: unique symbol = Symbol("triplex/JournalSuppression");

export type InternalTransactionMeta = TransactionMeta & {
  readonly [systemWriteAuthorization]?: true;
  readonly [journalSuppression]?: true;
};

export const isSystemWriteAuthorized = (meta: TransactionMeta | undefined): boolean =>
  (meta as InternalTransactionMeta | undefined)?.[systemWriteAuthorization] === true;

export const isJournalSuppressed = (meta: TransactionMeta | undefined): boolean =>
  (meta as InternalTransactionMeta | undefined)?.[journalSuppression] === true;

type SystemTransactError = Exclude<
  ReturnType<TriplesService["transact"]> extends Effect.Effect<unknown, infer E> ? E : never,
  CommitRejectedError
>;

/**
 * System writes never run commit validators: Triplex owns the invariants of
 * its reserved facts. Strip any per-call validators and keep the rejection
 * error out of every system service's error channel.
 */
const runSystem = (
  triples: TriplesService,
  operations: readonly TransactOp[],
  meta: InternalTransactionMeta,
): Effect.Effect<TransactionResult, SystemTransactError> => {
  const { validate: _validate, ...rest } = meta;
  return triples
    .transact(operations, rest as InternalTransactionMeta)
    .pipe(
      Effect.catchTag("CommitRejectedError", (error) =>
        Effect.fail(
          new WriteError({ message: `System write was rejected: ${error.message}`, cause: error }),
        ),
      ),
    );
};

/** Internal-only entry point for core services that own reserved facts. */
export const transactSystem = (
  triples: TriplesService,
  operations: readonly TransactOp[],
  meta?: TransactionMeta,
): Effect.Effect<TransactionResult, SystemTransactError> =>
  runSystem(triples, operations, {
    ...meta,
    [systemWriteAuthorization]: true,
  } as InternalTransactionMeta);

/**
 * Internal maintenance write that must not recursively appear in the ordered
 * application transaction feed. Used for the feed's own consumer cursors.
 */
export const transactSystemUnjournaled = (
  triples: TriplesService,
  operations: readonly TransactOp[],
  meta?: TransactionMeta,
): ReturnType<typeof transactSystem> =>
  runSystem(triples, operations, {
    ...meta,
    [systemWriteAuthorization]: true,
    [journalSuppression]: true,
  } as InternalTransactionMeta);

export const isReservedEntityId = (entityId: string): boolean => entityId.startsWith("_triplex/");

export const isReservedAttribute = (attribute: string): boolean =>
  attribute.startsWith(":triplex/") || attribute.startsWith(":_tx/");

export const isReservedEntityType = (entityType: string | undefined): boolean =>
  entityType === "_Transaction" || entityType?.startsWith("triplex.") === true;

interface ReservedWriteTarget {
  readonly entityId: string;
  readonly attribute: string;
  readonly entityType?: string | undefined;
}

export const reservedWriteReason = (input: ReservedWriteTarget): string | undefined => {
  if (isReservedEntityId(input.entityId)) return `entity ${input.entityId}`;
  if (isReservedAttribute(input.attribute)) return `attribute ${input.attribute}`;
  if (isReservedEntityType(input.entityType)) return `entity type ${input.entityType}`;
  return undefined;
};

export const reservedWriteError = (input: ReservedWriteTarget): WriteError | undefined => {
  const reason = reservedWriteReason(input);
  return reason
    ? new WriteError({
        message: `Write targets reserved Triplex system namespace: ${reason}`,
      })
    : undefined;
};

export const reservedAssertError = (operations: readonly TransactOp[]): WriteError | undefined => {
  for (const operation of operations) {
    if (operation.op !== "assert") continue;
    const error = reservedWriteError(operation);
    if (error) return error;
  }
  return undefined;
};
