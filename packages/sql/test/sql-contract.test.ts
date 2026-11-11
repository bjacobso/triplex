import { boolean, datetime, json, number, ref, string } from "@triplex-build/triplex";
import { describe, expect, it } from "vitest";

import { INDEX_NAMES, migrations, packValue } from "../src/index.js";

describe("SQL package contract", () => {
  it("keeps migration versions ordered and index declarations complete", () => {
    expect(migrations.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(migrations.flatMap((migration) => migration.up)).size).toBe(
      migrations.flatMap((migration) => migration.up).length,
    );
    for (const name of INDEX_NAMES) {
      expect(migrations.flatMap(({ up }) => up).some((statement) => statement.includes(name))).toBe(
        true,
      );
    }
  });

  it("packs sealed values into the envelope and blind columns only", () => {
    const packed = packValue({
      type: "sealed",
      valueType: "string",
      keyId: "key-1",
      ciphertext: "ciphertext",
      blind: "token",
    });
    expect(packed).toMatchObject({
      value_type: "sealed",
      value_string: null,
      value_json: null,
      value_blind: "token",
    });
    expect(JSON.parse(packed.value_sealed!)).toEqual({
      valueType: "string",
      keyId: "key-1",
      ciphertext: "ciphertext",
    });
  });

  it("declares the sealed-value migration for both SQL dialects", () => {
    const sealed = migrations.find((migration) => migration.version === 3)!;
    expect(sealed.dialects?.sqlite?.join("\n")).toContain("value_blind TEXT");
    expect(sealed.dialects?.pg?.join("\n")).toContain("ADD COLUMN IF NOT EXISTS value_blind");
    expect(sealed.up.join("\n")).toContain("idx_attr_blind");
  });

  it.each([
    [string("value"), { value_type: "string", value_string: "value" }],
    [number(42), { value_type: "number", value_number: 42 }],
    [boolean(true), { value_type: "boolean", value_boolean: 1 }],
    [datetime(123), { value_type: "datetime", value_datetime: 123 }],
    [ref("entity:1"), { value_type: "ref", value_string: "entity:1" }],
    [json({ nested: true }), { value_type: "json", value_json: '{"nested":true}' }],
  ] as const)("packs %o into one typed SQL value column", (value, expected) => {
    expect(packValue(value)).toEqual(expect.objectContaining(expected));
    const packed = packValue(value);
    const populated = [
      packed.value_string,
      packed.value_number,
      packed.value_boolean,
      packed.value_datetime,
      packed.value_json,
    ].filter((part) => part !== null);
    expect(populated).toHaveLength(1);
  });
});
