/** Operational reads for the two cuts of the active, serialized commit. */
import { Effect } from "effect";
import type { ContentId } from "../content/ContentId.js";
import { isContentId } from "../content/ContentId.js";
import { ReadError } from "../errors/index.js";
import type { OperationalEntryRecord } from "../operational/Entry.js";
import {
  decodeEntry,
  finishPendingEntries,
  preparePendingEntries,
} from "../operational/entryStorage.js";
import type { StorageAdapterService } from "../storage/StorageAdapter.js";
import type { TransactOp } from "../Triple.js";
import type { View } from "./CommitValidation.js";

type Port = Pick<StorageAdapterService, "getOperationalEntry" | "pendingOperationalEntries">;
const atPosition = (
  entry: OperationalEntryRecord | null,
  position: number,
): OperationalEntryRecord | null => {
  if (entry === null || entry.recordedPosition > position) return null;
  if (entry.acknowledgedPosition !== undefined && entry.acknowledgedPosition > position) {
    const {
      acknowledgedPosition: _position,
      acknowledgedAt: _instant,
      acknowledgedTxId: _txId,
      ...before
    } = entry;
    return before;
  }
  return entry;
};

/**
 * Only this attempt can differ from the last committed cut. Merge its acknowledgement
 * targets back into the pending index and overfetch past its appended entries. This
 * keeps both views indexed without adding a second historical entry index.
 */
export const commitOperationalView = (
  port: Port,
  position: number,
  operations: readonly TransactOp[],
): Pick<View, "operationalEntry" | "pendingOperationalEntries"> => ({
  operationalEntry: (id: ContentId) =>
    Effect.gen(function* () {
      if (!isContentId(id))
        return yield* new ReadError({ message: "Invalid operational entry ID" });
      const entry = atPosition(yield* port.getOperationalEntry(id), position);
      return entry === null ? null : yield* decodeEntry(entry);
    }),
  pendingOperationalEntries: (kind, request = {}) =>
    Effect.gen(function* () {
      const prepared = yield* Effect.try({
        try: () => preparePendingEntries(kind, request, `commit-view:${position}`),
        catch: (cause) => new ReadError({ message: "Invalid pending entry request", cause }),
      });
      const changed = operations.filter(
        (op) => op.op === "append-entry" || op.op === "acknowledge-entry",
      );
      const records = yield* port.pendingOperationalEntries({
        ...prepared.scan,
        limit: prepared.scan.limit + changed.length,
      });
      const candidates = new Map(records.map((entry) => [entry.id, entry]));
      for (const op of changed) {
        if (op.op !== "acknowledge-entry" || op.kind !== kind) continue;
        const entry = yield* port.getOperationalEntry(op.id);
        if (entry !== null) candidates.set(entry.id, entry);
      }
      const after = prepared.scan.after;
      const selected = [...candidates.values()]
        .map((entry) => atPosition(entry, position))
        .filter(
          (entry): entry is OperationalEntryRecord =>
            entry !== null &&
            entry.kind === kind &&
            entry.acknowledgedPosition === undefined &&
            (prepared.scan.scopeToken === undefined ||
              entry.scopeToken === prepared.scan.scopeToken) &&
            (after === undefined ||
              entry.recordedPosition > after.recordedPosition ||
              (entry.recordedPosition === after.recordedPosition && entry.id > after.id)),
        )
        .sort(
          (a, b) =>
            a.recordedPosition - b.recordedPosition || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .slice(0, prepared.scan.limit);
      return yield* finishPendingEntries(prepared, selected);
    }),
});
