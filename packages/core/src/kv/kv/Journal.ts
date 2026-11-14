/**
 * The KV transaction journal (in-memory KV and FoundationDB share it).
 *
 * Journal datoms are not hexastore facts: they never enter EAVT, AEVT, AVET,
 * VAET, TYPE or META. Each journaled transaction writes:
 *
 * - `0x0b position` → the entry (envelope, `[tripleId, op]` changes and changed
 *   entities), so `transactions({ after })` is a range seek;
 * - `0x0c txId` → position;
 * - `0x0d entity position` → position, one per changed entity, so an entity's
 *   history and the entity-ID prefix feed are ranges;
 * - `0x22 hash(commandId)` → position (first writer wins inside the KV transaction);
 * - the instant trie of `readIndexes.ts`, for `recordedPositionAt`.
 */
import { Effect, Stream } from "effect";

import * as ContentIds from "../../content/ContentId.js";
import { ReadError } from "../../errors/index.js";
import {
  checkedJournalEntry,
  type JournalAppend,
  type JournalChangeRef,
} from "../../store/journal.js";
import { transactionPrefixBounds } from "../../store/transactionPrefix.js";
import { concat, increment } from "./encoding.js";
import type { KvBackendService, KvEntry, KvTransaction, RangeOptions } from "./KvBackend.js";
import { encodeTuple, tNumber, tString } from "../hexastore/tuple.js";
import { journalInstantEntries } from "../hexastore/readIndexes.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const POSITION_PREFIX = new Uint8Array([0x0b]);
const TX_PREFIX = new Uint8Array([0x0c]);
const ENTITY_PREFIX = new Uint8Array([0x0d]);
const COMMAND_PREFIX = 0x22;

/** A stored KV journal entry keeps its changed entities for Datalog. */
export type KvJournalEntry = JournalAppend;

const positionKey = (position: number) => concat(POSITION_PREFIX, encodeTuple(tNumber(position)));
const txKey = (txId: string) => concat(TX_PREFIX, encodeTuple(tString(txId)));
const entityKey = (entityId: string, position: number) =>
  concat(ENTITY_PREFIX, encodeTuple(tString(entityId), tNumber(position)));
const entityRange = (entityId: string) => {
  const start = concat(ENTITY_PREFIX, encodeTuple(tString(entityId)));
  return { start, end: increment(start) };
};
/** A string tuple part without its terminator: a prefix of every longer string's key. */
const stringPrefix = (value: string) => encodeTuple(tString(value)).slice(0, -2);
const commandKey = (commandId: string): Uint8Array => {
  const digest = encoder.encode(ContentIds.hash(ContentIds.Domain.commandReceipt, commandId));
  const key = new Uint8Array(digest.length + 1);
  key[0] = COMMAND_PREFIX;
  key.set(digest, 1);
  return key;
};

const encodePosition = (position: number) => encoder.encode(String(position));
const decodePosition = (bytes: Uint8Array): number => {
  const position = Number(decoder.decode(bytes));
  if (!Number.isSafeInteger(position) || position < 1)
    throw new TypeError("Invalid KV journal position");
  return position;
};

const encodeEntry = (entry: KvJournalEntry): Uint8Array => encoder.encode(JSON.stringify(entry));
const decodeEntry = (bytes: Uint8Array): KvJournalEntry => {
  const parsed = JSON.parse(decoder.decode(bytes)) as KvJournalEntry;
  if (
    !Array.isArray(parsed.changes) ||
    !Array.isArray(parsed.entities) ||
    parsed.changes.some(
      (change: JournalChangeRef) =>
        !Array.isArray(change) ||
        typeof change[0] !== "string" ||
        (change[1] !== "assert" && change[1] !== "retract"),
    )
  )
    throw new TypeError("Invalid KV journal entry");
  return checkedJournalEntry(parsed);
};

/** The reads and writes the journal needs: a backend or a transaction. */
type Kv = Pick<KvTransaction, "get" | "set" | "getRange"> &
  Partial<Pick<KvBackendService, "getSync" | "getRangeSync">>;

const readError = (message: string) => (cause: unknown) =>
  cause instanceof ReadError ? cause : new ReadError({ message, cause });

/**
 * Append an entry inside the caller's KV transaction. When another committed
 * transaction holds the command ID, nothing is written and the winner's
 * transaction ID is returned.
 */
export const appendKvJournal = (
  tx: KvTransaction,
  entry: KvJournalEntry,
): Effect.Effect<string | null, ReadError> =>
  Effect.gen(function* () {
    if (entry.commandId !== undefined) {
      const key = commandKey(entry.commandId);
      const existing = yield* tx.get(key);
      if (existing !== null) {
        const winner = yield* kvJournalEntryAt(tx, decodePosition(existing));
        if (winner === null)
          return yield* new ReadError({ message: "Command receipt names a missing journal entry" });
        return winner.txId;
      }
      yield* tx.set(key, encodePosition(entry.position));
    }
    yield* tx.set(positionKey(entry.position), encodeEntry(entry));
    yield* tx.set(txKey(entry.txId), encodePosition(entry.position));
    for (const entityId of entry.entities)
      yield* tx.set(entityKey(entityId, entry.position), encodePosition(entry.position));
    for (const [key, value] of journalInstantEntries(entry.instant, entry.position))
      yield* tx.set(key, value);
    return null;
  }).pipe(Effect.mapError(readError("Failed to append the KV journal entry")));

export const kvJournalEntryAt = (
  kv: Kv,
  position: number,
): Effect.Effect<KvJournalEntry | null, ReadError> =>
  kv.get(positionKey(position)).pipe(
    Effect.flatMap((bytes) =>
      bytes === null ? Effect.succeed(null) : Effect.try(() => decodeEntry(bytes)),
    ),
    Effect.mapError(readError("Failed to read a KV journal entry")),
  );

export const kvJournalEntry = (
  kv: Kv,
  txId: string,
): Effect.Effect<KvJournalEntry | null, ReadError> =>
  kv.get(txKey(txId)).pipe(
    Effect.flatMap((bytes) =>
      bytes === null ? Effect.succeed(null) : kvJournalEntryAt(kv, decodePosition(bytes)),
    ),
    Effect.mapError(readError("Failed to read a KV transaction")),
  );

export const kvJournalEntryByCommand = (
  kv: Kv,
  commandId: string,
): Effect.Effect<KvJournalEntry | null, ReadError> =>
  kv.get(commandKey(commandId)).pipe(
    Effect.flatMap((bytes) =>
      bytes === null ? Effect.succeed(null) : kvJournalEntryAt(kv, decodePosition(bytes)),
    ),
    Effect.mapError(readError("Failed to read a KV command transaction")),
  );

const collect = (kv: Kv, range: RangeOptions) =>
  Stream.runCollect(kv.getRange(range)).pipe(Effect.map((entries) => Array.from(entries)));

/** Entries in `(after, head]` by position, at most `limit`: a seek, not a scan. */
export const kvJournalEntriesAfter = (
  kv: Kv,
  after: number,
  limit: number,
  head: number,
): Effect.Effect<readonly KvJournalEntry[], ReadError> =>
  head <= after
    ? Effect.succeed([])
    : collect(kv, {
        start: increment(positionKey(after)),
        end: increment(positionKey(head)),
        limit,
      }).pipe(
        Effect.flatMap((entries) =>
          Effect.try(() => entries.map(([, value]) => decodeEntry(value))),
        ),
        Effect.mapError(readError("Failed to read the KV journal page")),
      );

const entriesAt = (kv: Kv, positions: readonly number[]) =>
  Effect.forEach(positions, (position) =>
    kvJournalEntryAt(kv, position).pipe(
      Effect.flatMap((entry) =>
        entry === null
          ? Effect.fail(new ReadError({ message: `Missing KV journal entry at ${position}` }))
          : Effect.succeed(entry),
      ),
    ),
  );

/**
 * Entries in `(after, head]` that changed an entity whose ID starts with
 * `prefix`, by position, deduplicated, at most `limit`. Reads only the
 * matching entity rows and the selected entries.
 */
export const kvJournalEntriesForEntityPrefix = (
  kv: Kv,
  prefix: string,
  after: number,
  limit: number,
  head: number,
): Effect.Effect<readonly KvJournalEntry[], ReadError> => {
  const bounds = transactionPrefixBounds(prefix);
  if (bounds === null) return Effect.succeed([]);
  const start = concat(ENTITY_PREFIX, stringPrefix(bounds.lower));
  const end =
    bounds.upper === undefined
      ? increment(concat(ENTITY_PREFIX, encodeTuple(tString("")).slice(0, 1)))
      : concat(ENTITY_PREFIX, stringPrefix(bounds.upper));
  return Effect.gen(function* () {
    const selected: number[] = [];
    yield* Stream.runForEach(kv.getRange({ start, end }), ([, value]) =>
      Effect.sync(() => {
        const position = decodePosition(value);
        if (position <= after || position > head) return;
        // Keep the `limit` earliest positions, sorted and without duplicates.
        let low = 0,
          high = selected.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (selected[middle]! < position) low = middle + 1;
          else high = middle;
        }
        if (low >= limit || selected[low] === position) return;
        selected.splice(low, 0, position);
        if (selected.length > limit) selected.pop();
      }),
    );
    return yield* entriesAt(kv, selected);
  }).pipe(Effect.mapError(readError("Failed to read the KV entity-prefix journal page")));
};

/** Entries that changed one entity at or before `snapshot` (and before `before`), newest first. */
export const kvJournalEntriesForEntity = (
  kv: Kv,
  entityId: string,
  snapshot: number,
  before: number | undefined,
  limit: number,
): Effect.Effect<readonly KvJournalEntry[], ReadError> => {
  const { start } = entityRange(entityId);
  const upper = Math.min(snapshot + 1, before ?? Number.POSITIVE_INFINITY);
  const end = Number.isFinite(upper) ? entityKey(entityId, upper) : entityRange(entityId).end;
  return collect(kv, { start, end, reverse: true, limit }).pipe(
    Effect.flatMap((entries) =>
      entriesAt(
        kv,
        entries.map(([, value]) => decodePosition(value)),
      ),
    ),
    Effect.mapError(readError("Failed to read the KV entity journal")),
  );
};

// ─── Datalog reads ──────────────────────────────────────────────────────────

const decodeAll = (entries: readonly KvEntry[]) => entries.map(([, value]) => decodeEntry(value));

/** Every entry, by position (Datalog patterns no index narrows). */
export const kvJournalAll = (kv: Kv): Effect.Effect<readonly KvJournalEntry[], ReadError> =>
  collect(kv, { start: POSITION_PREFIX, end: increment(POSITION_PREFIX) }).pipe(
    Effect.flatMap((entries) => Effect.try(() => decodeAll(entries))),
    Effect.mapError(readError("Failed to scan the KV journal")),
  );

/** Positions of the entries that changed one entity. */
export const kvJournalPositionsForEntity = (
  kv: Kv,
  entityId: string,
): Effect.Effect<readonly number[], ReadError> =>
  collect(kv, entityRange(entityId)).pipe(
    Effect.flatMap((entries) =>
      Effect.try(() => entries.map(([, value]) => decodePosition(value))),
    ),
    Effect.mapError(readError("Failed to read the KV entity journal")),
  );

export const kvJournalEntriesAt = entriesAt;

/** Synchronous reads for the in-memory Datalog fast path; null without sync support. */
export const kvJournalSync = (kv: Kv) => {
  const getSync = kv.getSync;
  const getRangeSync = kv.getRangeSync;
  if (getSync === undefined || getRangeSync === undefined) return null;
  const at = (position: number) => {
    const bytes = getSync(positionKey(position));
    return bytes === null ? null : decodeEntry(bytes);
  };
  const byPositionBytes = (bytes: Uint8Array | null) =>
    bytes === null ? null : at(decodePosition(bytes));
  return {
    all: (): readonly KvJournalEntry[] =>
      decodeAll(getRangeSync({ start: POSITION_PREFIX, end: increment(POSITION_PREFIX) })),
    at,
    byTransaction: (txId: string) => byPositionBytes(getSync(txKey(txId))),
    byCommand: (commandId: string) => byPositionBytes(getSync(commandKey(commandId))),
    forEntity: (entityId: string): readonly KvJournalEntry[] =>
      getRangeSync(entityRange(entityId)).flatMap(([, value]) => {
        const entry = at(decodePosition(value));
        return entry === null ? [] : [entry];
      }),
  };
};

export const kvJournalAsync = (kv: Kv) => ({
  all: () => kvJournalAll(kv),
  at: (position: number) => kvJournalEntryAt(kv, position),
  byTransaction: (txId: string) => kvJournalEntry(kv, txId),
  byCommand: (commandId: string) => kvJournalEntryByCommand(kv, commandId),
  forEntity: (entityId: string) =>
    kvJournalPositionsForEntity(kv, entityId).pipe(
      Effect.flatMap((positions) => entriesAt(kv, positions)),
    ),
});
