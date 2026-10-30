import { Effect } from "effect";

import type { TransactOp } from "../Triple.js";
import { WriteError } from "../errors/index.js";
import type { Segment } from "../segment/Segment.js";
import type { TransactionMeta, TransactionResult, TriplesService } from "./Triples.js";

const systemWriteAuthorization: unique symbol = Symbol("triplex/SystemWriteAuthorization");
const journalSuppression: unique symbol = Symbol("triplex/JournalSuppression");
const segmentAttachment: unique symbol = Symbol("triplex/SegmentAttachment");

export type InternalTransactionMeta = TransactionMeta & {
  readonly [systemWriteAuthorization]?: true;
  readonly [journalSuppression]?: true;
  readonly [segmentAttachment]?: Segment;
};

/** The segment a transaction attaches, if any. Backends without segment support must fail. */
export const attachedSegment = (meta: TransactionMeta | undefined): Segment | undefined =>
  (meta as InternalTransactionMeta | undefined)?.[segmentAttachment];

/**
 * Attach a segment in one transaction with no other operations. Internal
 * transport for `Segment.attach`: the segment rides in the metadata so the
 * `Triples` contract doesn't change.
 */
export const transactSegment = (
  triples: TriplesService,
  segment: Segment,
  meta?: TransactionMeta,
): ReturnType<typeof transactSystem> =>
  triples.transact([], { ...meta, [segmentAttachment]: segment } as InternalTransactionMeta);

export const isSystemWriteAuthorized = (meta: TransactionMeta | undefined): boolean =>
  (meta as InternalTransactionMeta | undefined)?.[systemWriteAuthorization] === true;

export const isJournalSuppressed = (meta: TransactionMeta | undefined): boolean =>
  (meta as InternalTransactionMeta | undefined)?.[journalSuppression] === true;

/** Internal-only entry point for core services that own reserved facts. */
export const transactSystem = (
  triples: TriplesService,
  operations: readonly TransactOp[],
  meta?: TransactionMeta,
): Effect.Effect<
  TransactionResult,
  ReturnType<TriplesService["transact"]> extends Effect.Effect<unknown, infer E> ? E : never
> =>
  triples.transact(operations, {
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
  triples.transact(operations, {
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
