import { Schema } from "effect";
import { EntityId, type TransactionId } from "../Branded.js";
import { type ContentId } from "../content/ContentId.js";
import type { CanonicalValue } from "../content/CanonicalJson.js";

export const EntryKind = Schema.Union([Schema.Literal("inbox"), Schema.Literal("outbox")]);
export type EntryKind = typeof EntryKind.Type;

export const AppendEntryOp = Schema.Struct({
  op: Schema.Literal("append-entry"),
  kind: EntryKind,
  scope: EntityId,
  idempotencyKey: Schema.String,
  payload: Schema.Unknown,
});
export type AppendEntryOp = typeof AppendEntryOp.Type;
export const AcknowledgeEntryOp = Schema.Struct({
  op: Schema.Literal("acknowledge-entry"),
  kind: EntryKind,
  id: Schema.String.check(Schema.isPattern(/^sha256-[0-9a-f]{64}$/)).pipe(
    Schema.brand("ContentId"),
  ),
});
export type AcknowledgeEntryOp = typeof AcknowledgeEntryOp.Type;

export interface AppendEntryInput {
  readonly scope: EntityId;
  readonly idempotencyKey: string;
  readonly payload: CanonicalValue;
}
export interface OperationalEntry {
  readonly id: ContentId;
  readonly kind: EntryKind;
  readonly scope: EntityId;
  readonly idempotencyKey: string;
  readonly payload: CanonicalValue;
  readonly recordedPosition: number;
  readonly recordedAt: number;
  readonly txId: TransactionId;
  readonly acknowledgedPosition?: number;
  readonly acknowledgedAt?: number;
  readonly acknowledgedTxId?: TransactionId;
}
/** Adapter record: canonical payload bytes and a byte-stable scope lookup key. */
export interface OperationalEntryRecord extends Omit<OperationalEntry, "payload"> {
  readonly payload: string;
  readonly scopeToken: ContentId;
}
export interface PendingEntriesRequest {
  readonly scope?: EntityId;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface PendingEntriesPage {
  readonly entries: readonly OperationalEntry[];
  readonly nextCursor?: string;
}
/** Normalized bounded adapter scan; ordering is append position, then ASCII ID. */
export interface PendingEntriesScan {
  readonly kind: EntryKind;
  readonly scopeToken?: ContentId;
  readonly after?: { readonly recordedPosition: number; readonly id: ContentId };
  readonly limit: number;
}
