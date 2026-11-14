import { boolean, datetime, json, number, ref, string } from "@triplex-internal/core";
import { describe, expect, it } from "vitest";

import {
  BASELINE_MIGRATION_NAME,
  INDEX_NAMES,
  SchemaVersionError,
  checkSchemaHistory,
  migrations,
  packValue,
} from "../src/index.js";

describe("SQL package contract", () => {
  it("keeps one baseline migration with every index declared", () => {
    expect(migrations.map((migration) => [migration.version, migration.name])).toEqual([
      [1, BASELINE_MIGRATION_NAME],
    ]);
    const statements = migrations.flatMap((migration) => migration.up);
    expect(new Set(statements).size).toBe(statements.length);
    for (const name of INDEX_NAMES) {
      expect(statements.some((statement) => statement.includes(name))).toBe(true);
    }
    // Indexes that served only journal rows in `triples` are gone.
    expect(statements.join("\n")).not.toContain("idx_journal_instant_position");
    expect(statements.join("\n")).not.toContain("triplex_command_receipts");
  });

  it("accepts only this release's schema history", () => {
    expect(checkSchemaHistory([])).toBe("empty");
    expect(checkSchemaHistory([{ version: 1, name: BASELINE_MIGRATION_NAME }])).toBe("current");
    for (const history of [
      [{ version: 1, name: "triplex_baseline" }],
      Array.from({ length: 13 }, (_, index) => ({ version: index + 1, name: `v${index + 1}` })),
      [
        { version: 1, name: BASELINE_MIGRATION_NAME },
        { version: 2, name: "from_a_newer_release" },
      ],
    ]) {
      const status = checkSchemaHistory(history);
      expect(status).toBeInstanceOf(SchemaVersionError);
      expect((status as SchemaVersionError).message).toContain("Start a fresh database");
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

  it("creates the journal tables, their bytewise PostgreSQL key and the Datalog view", () => {
    const baseline = migrations[0]!;
    const all = [...(baseline.dialects?.pg ?? []), ...baseline.up].join("\n");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS triplex_transactions");
    expect(all).toContain("command_id TEXT UNIQUE");
    expect(all).toContain("PRIMARY KEY (entity_id, position)");
    expect(baseline.dialects?.pg?.join("\n")).toContain('entity_id TEXT COLLATE "C" NOT NULL');
    expect(all).toContain("CREATE VIEW triplex_journal_facts");
    expect(baseline.up.join("\n")).toContain("idx_attr_blind");
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
