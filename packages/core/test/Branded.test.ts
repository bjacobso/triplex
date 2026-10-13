import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DatabaseId, EntityId, TransactionId, TripleId, unsafe } from "../src/Branded.js";

describe("branded ID constructors", () => {
  it.each([
    [TripleId, unsafe.tripleId, "01ARZ3NDEKTSV4RRFFQ69G5FAV", "invalid"],
    [EntityId, unsafe.entityId, "worker:1", ""],
    [DatabaseId, unsafe.databaseId, "customer-a", "Customer A"],
    [TransactionId, unsafe.transactionId, "_tx/01ARZ3NDEKTSV4RRFFQ69G5FAV", "worker:1"],
  ] as const)(
    "validates %s through native make and unsafe helpers",
    (schema, make, valid, invalid) => {
      expect(schema.make(valid)).toBe(valid);
      expect(make(valid)).toBe(valid);
      expect(Schema.decodeSync(schema)(valid)).toBe(valid);
      expect(() => schema.make(invalid)).toThrow();
      expect(() => make(invalid)).toThrow();
    },
  );
});
