import { Effect, Stream } from "effect";
import { ReadError, WriteError } from "../../errors/index.js";
import type { KvTransaction } from "./KvBackend.js";
import type { StorageAdapterService } from "../../storage/StorageAdapter.js";
import type {
  EntryKind,
  OperationalEntryRecord,
  PendingEntriesScan,
} from "../../operational/Entry.js";
import type { ContentId } from "../../content/ContentId.js";

// 0x20 is datom metadata, 0x21 positions, 0x22 command receipts.
// Entry records and the two pending-only indexes own 0x23..0x25.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const concat = (...values: readonly Uint8Array[]) => {
  const out = new Uint8Array(values.reduce((n, v) => n + v.length, 0));
  let offset = 0;
  for (const value of values) {
    out.set(value, offset);
    offset += value.length;
  }
  return out;
};
const primary = (id: ContentId) => concat(new Uint8Array([0x23]), encoder.encode(id));
const kindByte = (kind: EntryKind) => (kind === "inbox" ? 0 : 1);
const globalPrefix = (kind: EntryKind) => new Uint8Array([0x24, kindByte(kind)]);
const scopedPrefix = (kind: EntryKind, token: ContentId) =>
  concat(new Uint8Array([0x25, kindByte(kind)]), encoder.encode(token));
const suffix = (position: number, id: ContentId) => {
  const ordered = new Uint8Array(8);
  new DataView(ordered.buffer).setFloat64(0, position, false);
  return concat(ordered, encoder.encode(id));
};
const pendingKeys = (entry: OperationalEntryRecord) => [
  concat(globalPrefix(entry.kind), suffix(entry.recordedPosition, entry.id)),
  concat(scopedPrefix(entry.kind, entry.scopeToken), suffix(entry.recordedPosition, entry.id)),
];
const prefixEnd = (prefix: Uint8Array) => {
  const end = prefix.slice();
  end[end.length - 1] = end[end.length - 1]! + 1;
  return end;
};

export const makeKvOperationalEntryStorage = (
  kv: KvTransaction,
): Pick<
  StorageAdapterService,
  | "getOperationalEntry"
  | "pendingOperationalEntries"
  | "insertOperationalEntry"
  | "acknowledgeOperationalEntry"
> => {
  const getOperationalEntry: StorageAdapterService["getOperationalEntry"] = (id) =>
    Effect.gen(function* () {
      const bytes = yield* kv.get(primary(id));
      if (bytes === null) return null;
      return yield* Effect.try({
        try: () => JSON.parse(decoder.decode(bytes)) as OperationalEntryRecord,
        catch: (cause) => new ReadError({ message: "Invalid operational entry encoding", cause }),
      });
    });
  return {
    getOperationalEntry,
    insertOperationalEntry: (entry) =>
      Effect.gen(function* () {
        yield* kv.set(primary(entry.id), encoder.encode(JSON.stringify(entry)));
        for (const key of pendingKeys(entry)) yield* kv.set(key, encoder.encode(entry.id));
      }),
    acknowledgeOperationalEntry: (id, position, instant, txId) =>
      Effect.gen(function* () {
        const entry = yield* getOperationalEntry(id).pipe(
          Effect.mapError(
            (cause) => new WriteError({ message: "Failed to load acknowledgement target", cause }),
          ),
        );
        if (entry === null)
          return yield* new WriteError({
            message: "Operational entry disappeared during acknowledgement",
          });
        yield* kv.set(
          primary(id),
          encoder.encode(
            JSON.stringify({
              ...entry,
              acknowledgedPosition: position,
              acknowledgedAt: instant,
              acknowledgedTxId: txId,
            }),
          ),
        );
        for (const key of pendingKeys(entry)) yield* kv.delete(key);
      }),
    pendingOperationalEntries: (scan: PendingEntriesScan) =>
      Effect.gen(function* () {
        const prefix =
          scan.scopeToken === undefined
            ? globalPrefix(scan.kind)
            : scopedPrefix(scan.kind, scan.scopeToken);
        const start =
          scan.after === undefined
            ? prefix
            : concat(
                prefix,
                suffix(scan.after.recordedPosition, scan.after.id),
                new Uint8Array([0]),
              );
        const keys = yield* Stream.runCollect(
          kv.getRange({ start, end: prefixEnd(prefix), limit: scan.limit }),
        );
        return yield* Effect.forEach(keys, ([, value]) =>
          Effect.gen(function* () {
            const entry = yield* getOperationalEntry(decoder.decode(value) as ContentId);
            if (entry === null || entry.acknowledgedPosition !== undefined)
              return yield* new ReadError({ message: "Corrupt operational pending index" });
            return entry;
          }),
        );
      }),
  };
};
