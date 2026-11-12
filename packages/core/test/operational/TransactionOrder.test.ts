import { Schema } from "effect";
import { expect, it } from "vitest";
import { EntityId, TransactionId, TripleId } from "../../src/Branded.js";
import { Triple } from "../../src/Triple.js";
import type { TransactionChange } from "../../src/store/Triples.js";
import {
  metadataInputs,
  transactionRecordFromTriples,
} from "../../src/store/transactionMetadata.js";

const txId = TransactionId.make(`_tx/${"0".repeat(26)}`);
const changes: readonly TransactionChange[] = ["z", "a", "m"].map((id, index) => ({
  op: index === 1 ? "retract" : "assert",
  tripleId: TripleId.make(id.toUpperCase().repeat(26)),
  entityId: EntityId.make("entity:ordered"),
  attribute: ":test/status",
}));

const metadata = () =>
  metadataInputs(txId, 1, 100, undefined, changes).map((input, index) =>
    Schema.decodeUnknownSync(Triple)({
      ...input,
      id: String(index).padStart(26, "0"),
      recordedAt: 100,
      validFrom: 100,
    }),
  );

it("reconstructs operation order independently of metadata row order", () => {
  // ID ordering is deliberately unrelated to operation ordering.
  const triples = metadata().map((triple, index) => ({
    ...triple,
    id: TripleId.make(String(100 - index).padStart(26, "0")),
  }));
  for (const rows of [
    triples,
    [...triples].reverse(),
    [...triples.slice(2), ...triples.slice(0, 2)],
  ]) {
    expect(transactionRecordFromTriples(txId, rows)?.changes).toEqual(changes);
  }
});

it("keeps legacy journal facts without a change index readable in metadata ID order", () => {
  const triples = metadata().map((triple) => {
    if (triple.attribute !== ":_tx/change" || triple.value.type !== "json") return triple;
    const { changeIndex: _, ...value } = triple.value.value as Record<string, unknown>;
    return { ...triple, value: { type: "json" as const, value } };
  });
  expect(transactionRecordFromTriples(txId, [...triples].reverse())?.changes).toEqual(changes);
});
