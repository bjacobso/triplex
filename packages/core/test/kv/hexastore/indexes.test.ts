import { describe, it, expect } from "vitest";
import {
  EAVT_PREFIX,
  AEVT_PREFIX,
  AVET_PREFIX,
  VAET_PREFIX,
  META_PREFIX,
  eavtKey,
  aevtKey,
  avetKey,
  vaetKey,
  metaKey,
  selectIndex,
  prefixRange,
} from "../../../src/kv/hexastore/indexes.js";
import { tString, tNumber, tRef, decodeTuple } from "../../../src/kv/hexastore/tuple.js";
import { compare, startsWith } from "../../../src/kv/kv/encoding.js";

// ─── Index prefix ordering ─────────────────────────────────────────────────

describe("index prefixes", () => {
  it("prefixes are all single bytes", () => {
    expect(EAVT_PREFIX.length).toBe(1);
    expect(AEVT_PREFIX.length).toBe(1);
    expect(AVET_PREFIX.length).toBe(1);
    expect(VAET_PREFIX.length).toBe(1);
    expect(META_PREFIX.length).toBe(1);
  });

  it("prefixes are all distinct", () => {
    const set = new Set([
      EAVT_PREFIX[0],
      AEVT_PREFIX[0],
      AVET_PREFIX[0],
      VAET_PREFIX[0],
      META_PREFIX[0],
    ]);
    expect(set.size).toBe(5);
  });

  it("data indexes sort before META", () => {
    expect(compare(EAVT_PREFIX, META_PREFIX)).toBeLessThan(0);
    expect(compare(AEVT_PREFIX, META_PREFIX)).toBeLessThan(0);
    expect(compare(AVET_PREFIX, META_PREFIX)).toBeLessThan(0);
    expect(compare(VAET_PREFIX, META_PREFIX)).toBeLessThan(0);
  });
});

// ─── Key construction ──────────────────────────────────────────────────────

describe("key construction", () => {
  const entity = tString("emp:alice");
  const attr = tString(":employee/name");
  const value = tString("Alice");
  const txId = tString("tx:1");
  const tripleId = tString("triple:1");

  it("eavtKey starts with EAVT prefix", () => {
    const key = eavtKey(entity, attr, value, txId, tripleId);
    expect(startsWith(key, EAVT_PREFIX)).toBe(true);
  });

  it("aevtKey starts with AEVT prefix", () => {
    const key = aevtKey(attr, entity, value, txId, tripleId);
    expect(startsWith(key, AEVT_PREFIX)).toBe(true);
  });

  it("avetKey starts with AVET prefix", () => {
    const key = avetKey(attr, value, entity, txId, tripleId);
    expect(startsWith(key, AVET_PREFIX)).toBe(true);
  });

  it("vaetKey starts with VAET prefix", () => {
    const key = vaetKey(value, attr, entity, txId, tripleId);
    expect(startsWith(key, VAET_PREFIX)).toBe(true);
  });

  it("metaKey starts with META prefix", () => {
    const key = metaKey("triple-1");
    expect(startsWith(key, META_PREFIX)).toBe(true);
  });

  it("eavtKey contains encoded (entity, attr, value, txId, tripleId)", () => {
    const key = eavtKey(entity, attr, value, txId, tripleId);
    // Skip prefix byte, decode the rest
    const parts = decodeTuple(key.slice(1));
    expect(parts).toEqual([entity, attr, value, txId, tripleId]);
  });

  it("aevtKey contains encoded (attr, entity, value, txId)", () => {
    const key = aevtKey(attr, entity, value, txId, tripleId);
    const parts = decodeTuple(key.slice(1));
    expect(parts).toEqual([attr, entity, value, txId, tripleId]);
  });

  it("avetKey contains encoded (attr, value, entity, txId)", () => {
    const key = avetKey(attr, value, entity, txId, tripleId);
    const parts = decodeTuple(key.slice(1));
    expect(parts).toEqual([attr, value, entity, txId, tripleId]);
  });

  it("vaetKey contains encoded (value, attr, entity, txId)", () => {
    const key = vaetKey(value, attr, entity, txId, tripleId);
    const parts = decodeTuple(key.slice(1));
    expect(parts).toEqual([value, attr, entity, txId, tripleId]);
  });

  it("keys from different indexes sort into separate ranges", () => {
    const eavt = eavtKey(entity, attr, value, txId, tripleId);
    const aevt = aevtKey(attr, entity, value, txId, tripleId);
    const avet = avetKey(attr, value, entity, txId, tripleId);
    const vaet = vaetKey(value, attr, entity, txId, tripleId);

    // EAVT < AEVT < AVET < VAET (by prefix byte)
    expect(compare(eavt, aevt)).toBeLessThan(0);
    expect(compare(aevt, avet)).toBeLessThan(0);
    expect(compare(avet, vaet)).toBeLessThan(0);
  });

  it("eavtKeys for same entity sort by attribute", () => {
    const k1 = eavtKey(entity, tString(":employee/age"), tNumber(30), txId, tripleId);
    const k2 = eavtKey(entity, tString(":employee/name"), tString("Alice"), txId, tripleId);
    // ":employee/age" < ":employee/name" lexicographically
    expect(compare(k1, k2)).toBeLessThan(0);
  });
});

// ─── Index selection ───────────────────────────────────────────────────────

describe("selectIndex", () => {
  const e = tString("emp:1");
  const a = tString(":name");
  const v = tString("Alice");

  it("entity + attribute + value → EAVT", () => {
    const result = selectIndex({ entity: true, attribute: true, value: true }, e, a, v);
    expect(result.index).toBe("EAVT");
    expect(result.prefixParts).toEqual([e, a, v]);
  });

  it("entity + attribute → EAVT", () => {
    const result = selectIndex({ entity: true, attribute: true, value: false }, e, a);
    expect(result.index).toBe("EAVT");
    expect(result.prefixParts).toEqual([e, a]);
  });

  it("entity only → EAVT", () => {
    const result = selectIndex({ entity: true, attribute: false, value: false }, e);
    expect(result.index).toBe("EAVT");
    expect(result.prefixParts).toEqual([e]);
  });

  it("attribute + value → AVET", () => {
    const result = selectIndex({ entity: false, attribute: true, value: true }, undefined, a, v);
    expect(result.index).toBe("AVET");
    expect(result.prefixParts).toEqual([a, v]);
  });

  it("attribute only → AEVT", () => {
    const result = selectIndex({ entity: false, attribute: true, value: false }, undefined, a);
    expect(result.index).toBe("AEVT");
    expect(result.prefixParts).toEqual([a]);
  });

  it("value only (ref) → VAET", () => {
    const refVal = tRef("target:1");
    const result = selectIndex(
      { entity: false, attribute: false, value: true },
      undefined,
      undefined,
      refVal,
      true,
    );
    expect(result.index).toBe("VAET");
    expect(result.prefixParts).toEqual([refVal]);
  });

  it("value only (non-ref) → EAVT full scan", () => {
    const result = selectIndex(
      { entity: false, attribute: false, value: true },
      undefined,
      undefined,
      v,
      false,
    );
    expect(result.index).toBe("EAVT");
    expect(result.prefixParts).toEqual([]);
  });

  it("nothing bound → EAVT full scan", () => {
    const result = selectIndex({ entity: false, attribute: false, value: false });
    expect(result.index).toBe("EAVT");
    expect(result.prefixParts).toEqual([]);
  });
});

// ─── Prefix range computation ──────────────────────────────────────────────

describe("prefixRange", () => {
  it("empty prefix → full index range", () => {
    const { start, end } = prefixRange("EAVT", []);
    expect(start).toEqual(EAVT_PREFIX);
    // end should be the next byte after the prefix
    expect(end[0]).toBe(EAVT_PREFIX[0]! + 1);
  });

  it("prefix range start includes the prefix bytes", () => {
    const entity = tString("emp:1");
    const { start } = prefixRange("EAVT", [entity]);
    expect(startsWith(start, EAVT_PREFIX)).toBe(true);
  });

  it("prefix range end sorts after all possible continuations", () => {
    const entity = tString("emp:1");
    const { start, end } = prefixRange("EAVT", [entity]);
    // Any key that starts with the same prefix must sort between start and end
    expect(compare(start, end)).toBeLessThan(0);

    // A key with more components after the prefix should be in range
    const fullKey = eavtKey(
      entity,
      tString(":name"),
      tString("Alice"),
      tString("tx:1"),
      tString("triple:1"),
    );
    expect(compare(fullKey, start)).toBeGreaterThanOrEqual(0);
    expect(compare(fullKey, end)).toBeLessThan(0);
  });

  it("works for AVET index", () => {
    const attr = tString(":name");
    const value = tString("Alice");
    const { start, end } = prefixRange("AVET", [attr, value]);
    expect(startsWith(start, AVET_PREFIX)).toBe(true);
    expect(compare(start, end)).toBeLessThan(0);
  });
});

import { intervalRange } from "../../../src/kv/hexastore/indexes.js";
it("represents contradictory interval predicates as an empty valid KV range", () => {
  const range = intervalRange(":expiry", {
    bound: "to",
    lower: { value: 20, inclusive: true },
    upper: { value: 10, inclusive: false },
  });
  expect(range.start).toEqual(range.end);
});

import { intervalKey } from "../../../src/kv/hexastore/indexes.js";
it("canonicalizes signed zero in interval index keys", () => {
  expect(intervalKey(":expiry", "from", -0, "id")).toEqual(intervalKey(":expiry", "from", 0, "id"));
});
