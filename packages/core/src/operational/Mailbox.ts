import { Effect } from "effect";
import type { TriplesService } from "../store/Triples.js";
import type { EntityId } from "../Branded.js";
import type { ContentId } from "../content/ContentId.js";
import type {
  AcknowledgeEntryOp,
  AppendEntryInput,
  AppendEntryOp,
  EntryKind,
  PendingEntriesRequest,
} from "./Entry.js";
import { entryId } from "./entryStorage.js";

const mailbox = (kind: EntryKind) => ({
  id: (scope: EntityId, idempotencyKey: string): ContentId => entryId(kind, scope, idempotencyKey),
  append: (input: AppendEntryInput): AppendEntryOp => ({ ...input, op: "append-entry", kind }),
  acknowledge: (id: ContentId): AcknowledgeEntryOp => ({ op: "acknowledge-entry", kind, id }),
  get: (triples: TriplesService, id: ContentId) =>
    triples.operationalEntry(id).pipe(Effect.map((entry) => (entry?.kind === kind ? entry : null))),
  pending: (triples: TriplesService, request: PendingEntriesRequest = {}) =>
    triples.pendingOperationalEntries(kind, request),
});
export const Inbox = mailbox("inbox");
export const Outbox = mailbox("outbox");
