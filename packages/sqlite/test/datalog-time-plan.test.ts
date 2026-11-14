import { expect, it } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { compile } from "@triplex-internal/core/datalog";
import { SqliteTestLayer } from "../src/SqliteLayer.js";

it("uses historical bound indexes for selective expiry and start ranges", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 20000)
      INSERT INTO triples(id, entity_id, attribute, value_type, value_string, recorded_at, recorded_position, valid_from, valid_to, tx_id)
      SELECT 'fact:' || x, 'entity:' || x, ':expiry', 'string', 'approved', 1, 1, x, x + 100000, 'tx:one' FROM n`);
      yield* sql.unsafe("ANALYZE triples");
      for (const [bound, column, lower, upper] of [
        ["to", "valid_to", 110000, 110010],
        ["from", "valid_from", 10000, 10010],
      ] as const) {
        const compiled = compile(
          {
            validTime: "all",
            find: ["?e", "?bound"],
            where: [
              { pattern: ["?e", ":expiry", "approved"], valid: { [bound]: "?bound" } },
              [">=", "?bound", lower],
              ["<", "?bound", upper],
            ],
          },
          undefined,
          false,
          { basis: { recordedPosition: 1 } },
        );
        const plan = yield* sql.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${compiled.sql}`,
          compiled.params,
        );
        expect(plan.map((row) => row.detail).join("\n")).toContain(
          `idx_attribute_${column}_history`,
        );
        const equality = compile(
          {
            validTime: "all",
            find: ["?e"],
            where: [
              { pattern: ["?e", ":expiry", "approved"], valid: { [bound]: "?bound" } },
              ["=", "?bound", lower],
            ],
          },
          undefined,
          false,
          { basis: { recordedPosition: 1 } },
        );
        const equalityPlan = yield* sql.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${equality.sql}`,
          equality.params,
        );
        expect(equalityPlan.map((row) => row.detail).join("\n")).toContain(
          `idx_attribute_${column}_history`,
        );
        const result = yield* sql.unsafe(compiled.sql, compiled.params);
        expect(result).toHaveLength(10);
        // Indexes retain retracted entries, and visibility is evaluated at the old cut.
        yield* sql`UPDATE triples SET retracted_at = 2, retracted_position = 2 WHERE valid_from = 10000`;
        expect(yield* sql.unsafe(compiled.sql, compiled.params)).toHaveLength(10);
      }
      const provenance = compile(
        { find: ["?actor"], where: [["tx:one", ":_tx/actor", "?actor"]] },
        undefined,
        false,
        { basis: { recordedPosition: 1, validAt: 0 } },
      );
      const plan = yield* sql.unsafe<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${provenance.sql}`,
        provenance.params,
      );
      // Transaction metadata reads the journal row by its primary key.
      expect(plan.map((row) => row.detail).join("\n")).toMatch(
        /SEARCH t USING INDEX sqlite_autoindex_triplex_transactions_1 \(tx_id=\?\)/,
      );
    }).pipe(Effect.provide(SqliteTestLayer)),
  );
});
