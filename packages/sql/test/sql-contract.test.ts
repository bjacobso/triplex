import { boolean, datetime, json, number, ref, string } from "@bjacobso/triplex";
import { describe, expect, it } from "vitest";

import { INDEX_NAMES, migrations, packValue } from "../src/index.js";

describe("SQL package contract", () => {
  it("keeps migration versions ordered and index declarations complete", () => {
    expect(migrations.map((migration) => migration.version)).toEqual([1]);
    expect(new Set(migrations.flatMap((migration) => migration.up)).size).toBe(
      migrations.flatMap((migration) => migration.up).length,
    );
    for (const name of INDEX_NAMES) {
      expect(migrations[0]?.up.some((statement) => statement.includes(name))).toBe(true);
    }
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
