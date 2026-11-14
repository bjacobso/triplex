/**
 * The transaction journal, stored apart from the facts.
 *
 * Every journaled transaction keeps one journal entry: its envelope (position,
 * instant, actor, command, correlation, causation, config snapshot) and the
 * ordered references `[tripleId, op]` to the facts it changed. A
 * `TransactionRecord` is rebuilt from an entry with one batched primary-key read
 * of the referenced facts, which are immutable apart from their retraction
 * fields. Backends also index each entry by its changed entities.
 */
import { Option } from "effect";

import { unsafe, type TransactionId } from "../Branded.js";
import type { Triple } from "../Triple.js";
import { withoutBlind } from "../Value.js";
import type { TransactionChange, TransactionMeta, TransactionRecord } from "./Triples.js";

export type JournalOp = "assert" | "retract";

/** One change reference: the changed fact's ID and the operation, in commit order. */
export type JournalChangeRef = readonly [tripleId: string, op: JournalOp];

/** A stored journal entry, as backends read it. */
export interface JournalEntry {
  readonly txId: string;
  readonly position: number;
  readonly instant: number;
  readonly actor?: string;
  readonly commandId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly configSnapshot?: string;
  readonly changes: readonly JournalChangeRef[];
}

/** A journal entry to append, with its distinct changed entities in first-seen order. */
export interface JournalAppend extends JournalEntry {
  readonly entities: readonly string[];
}

/** The change a transaction made to one fact, as the write path records it. */
export interface JournalChange {
  readonly op: JournalOp;
  readonly tripleId: string;
  readonly entityId: string;
}

export const journalAppend = (
  txId: string,
  position: number,
  instant: number,
  meta: TransactionMeta | undefined,
  changes: readonly JournalChange[],
): JournalAppend => ({
  txId,
  position,
  instant,
  // Empty metadata strings were never recorded; keep that contract.
  ...(meta?.actor ? { actor: meta.actor } : {}),
  ...(meta?.commandId ? { commandId: meta.commandId } : {}),
  ...(meta?.correlationId ? { correlationId: meta.correlationId } : {}),
  ...(meta?.causationId ? { causationId: meta.causationId } : {}),
  ...(meta?.configSnapshot ? { configSnapshot: meta.configSnapshot } : {}),
  changes: changes.map((change) => [change.tripleId, change.op] as const),
  entities: [...new Set(changes.map((change) => change.entityId))],
});

/** The persisted `changes` column: a JSON array of `[tripleId, op]` pairs. */
export const encodeJournalChanges = (changes: readonly JournalChangeRef[]): string =>
  JSON.stringify(changes);

/** Decode the `changes` column; throws on a malformed value. */
export const decodeJournalChanges = (encoded: string): readonly JournalChangeRef[] => {
  const parsed: unknown = JSON.parse(encoded);
  if (!Array.isArray(parsed)) throw new TypeError("Journal changes must be an array");
  return parsed.map((change: unknown) => {
    if (
      !Array.isArray(change) ||
      change.length !== 2 ||
      typeof change[0] !== "string" ||
      (change[1] !== "assert" && change[1] !== "retract")
    ) {
      throw new TypeError("Invalid journal change reference");
    }
    return [change[0], change[1]] as const;
  });
};

/** Validate a decoded entry's identity and numeric fields; throws on a corrupt entry. */
export const checkedJournalEntry = <A extends JournalEntry>(entry: A): A => {
  if (typeof entry.txId !== "string" || entry.txId.length === 0)
    throw new TypeError("Invalid journal transaction ID");
  if (!Number.isSafeInteger(entry.position) || entry.position < 1)
    throw new TypeError(`Invalid journal position for ${entry.txId}`);
  if (!Number.isFinite(entry.instant))
    throw new TypeError(`Invalid journal instant for ${entry.txId}`);
  return entry;
};

/** Every fact ID a page of entries references, without duplicates. */
export const referencedFactIds = (entries: readonly JournalEntry[]): readonly string[] => [
  ...new Set(entries.flatMap((entry) => entry.changes.map(([tripleId]) => tripleId))),
];

/**
 * The journal's view of one changed fact. A sealed value carries no blind token
 * in the journal; see `withoutBlind`. A retract change carries the retraction
 * time and transaction of the transaction that made it.
 */
export const transactionChangeFromTriple = (
  op: JournalOp,
  triple: Triple,
  transactionId: TransactionId,
  transactionInstant: number,
): TransactionChange => ({
  op,
  tripleId: triple.id,
  entityId: triple.entityId,
  attribute: triple.attribute,
  ...(Option.isSome(triple.entityType) ? { entityType: triple.entityType.value } : {}),
  value: withoutBlind(triple.value),
  validFrom: triple.validFrom,
  ...(Option.isSome(triple.validTo) ? { validTo: triple.validTo.value } : {}),
  recordedAt: triple.recordedAt,
  ...(op === "retract" ? { retractedAt: transactionInstant } : {}),
  ...(Option.isSome(triple.txId) ? { assertionTxId: triple.txId.value } : {}),
  ...(op === "retract" ? { retractionTxId: transactionId } : {}),
});

/**
 * Rebuild a `TransactionRecord` from its entry and the referenced facts.
 * Returns the ID of the first missing fact when the facts are incomplete.
 */
export const transactionRecordFromEntry = (
  entry: JournalEntry,
  facts: ReadonlyMap<string, Triple>,
): TransactionRecord | { readonly missing: string } => {
  const txId = unsafe.transactionId(entry.txId);
  const changes: TransactionChange[] = [];
  for (const [tripleId, op] of entry.changes) {
    const fact = facts.get(tripleId);
    if (fact === undefined) return { missing: tripleId };
    changes.push(transactionChangeFromTriple(op, fact, txId, entry.instant));
  }
  return {
    txId,
    position: entry.position,
    instant: entry.instant,
    ...(entry.actor === undefined ? {} : { actor: entry.actor }),
    ...(entry.commandId === undefined ? {} : { commandId: entry.commandId }),
    ...(entry.correlationId === undefined ? {} : { correlationId: entry.correlationId }),
    ...(entry.causationId === undefined ? {} : { causationId: entry.causationId }),
    ...(entry.configSnapshot === undefined ? {} : { configSnapshot: entry.configSnapshot }),
    changes,
  };
};
