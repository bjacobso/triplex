import { describe, expect, it } from "vitest";
import { Option } from "effect";

import { EntityId, TripleId } from "../../src/Branded.js";
import { canonicalize, triplesToAttributeMap } from "../../src/snapshots/canonical.js";
import type { Triple } from "../../src/Triple.js";

const fact = (attribute: string, value: Triple["value"], id: string): Triple => ({
  id: TripleId.make(id),
  entityId: EntityId.make("ee:1"),
  attribute: attribute as Triple["attribute"],
  value,
  recordedAt: 1,
  validFrom: 1,
  validTo: Option.none(),
  createdBy: Option.none(),
  retractedAt: Option.none(),
  entityType: Option.none(),
  schemaVersion: Option.none(),
  txId: Option.none(),
  retractTxId: Option.none(),
});

describe("entity snapshots of sealed values", () => {
  it("commit to the sealed envelope and sort sealed values deterministically", () => {
    const sealed = (ciphertext: string, blind: string): Triple["value"] => ({
      type: "sealed",
      valueType: "string",
      keyId: "k1",
      ciphertext,
      blind,
    });
    const map = triplesToAttributeMap([
      fact(":employee/name", { type: "string", value: "Ada" }, "00000000000000000000000001"),
      fact(":employee/alias", sealed("ct-b", "blind-b"), "00000000000000000000000002"),
      fact(":employee/alias", sealed("ct-a", "blind-a"), "00000000000000000000000003"),
    ]);
    const canonical = canonicalize(map);
    expect(canonical).toContain('"ciphertext":"ct-a"');
    expect(canonical.indexOf("ct-a")).toBeLessThan(canonical.indexOf("ct-b"));
    expect(canonical).toContain("Ada");
  });
});
