import { Option } from "effect";
import { expect, it } from "vitest";
import { EntityId, TransactionId, TripleId } from "../../src/Branded.js";
import type { Triple } from "../../src/Triple.js";
import {
  decodeJournalChanges,
  encodeJournalChanges,
  journalAppend,
  transactionRecordFromEntry,
} from "../../src/store/journal.js";

const txId = TransactionId.make(`_tx/${"0".repeat(26)}`);
const ids = ["z", "a", "m"].map((id) => TripleId.make(id.toUpperCase().repeat(26)));
const fact = (id: TripleId, entity: string): Triple => ({
  id,
  entityId: EntityId.make(entity),
  attribute: ":test/status" as Triple["attribute"],
  value: { type: "string", value: id },
  recordedAt: 50,
  validFrom: 50,
  validTo: Option.none(),
  createdBy: Option.none(),
  retractedAt: Option.none(),
  entityType: Option.none(),
  schemaVersion: Option.none(),
  txId: Option.some(txId),
  retractTxId: Option.none(),
});
const facts = new Map(
  ids.map((id, index) => [id, fact(id, index === 2 ? "entity:other" : "entity:ordered")]),
);
const changes = ids.map((tripleId, index) => ({
  op: index === 1 ? ("retract" as const) : ("assert" as const),
  tripleId,
  entityId: facts.get(tripleId)!.entityId,
}));

it("keeps operation order, independent of fact ID order", () => {
  // ID ordering is deliberately unrelated to operation ordering.
  const entry = journalAppend(txId, 1, 100, { actor: "alice" }, changes);
  expect(entry.changes).toEqual([
    [ids[0], "assert"],
    [ids[1], "retract"],
    [ids[2], "assert"],
  ]);
  expect(entry.entities).toEqual(["entity:ordered", "entity:other"]);
  const stored = { ...entry, changes: decodeJournalChanges(encodeJournalChanges(entry.changes)) };
  const record = transactionRecordFromEntry(stored, facts);
  expect("missing" in record).toBe(false);
  if ("missing" in record) return;
  expect(record.changes.map((change) => [change.tripleId, change.op])).toEqual(entry.changes);
  expect(record.actor).toBe("alice");
  // A retract change carries the retracting transaction's time and ID.
  expect(record.changes[1]).toMatchObject({ retractedAt: 100, retractionTxId: txId });
  expect(record.changes[0]).not.toHaveProperty("retractedAt");
});

it("reports a referenced fact that is missing", () => {
  const entry = journalAppend(txId, 1, 100, undefined, changes);
  const record = transactionRecordFromEntry(entry, new Map([[ids[0]!, facts.get(ids[0]!)!]]));
  expect(record).toEqual({ missing: ids[1] });
});

it("rejects malformed change references", () => {
  expect(() => decodeJournalChanges("{}")).toThrow();
  expect(() => decodeJournalChanges('[["id", "delete"]]')).toThrow();
});
