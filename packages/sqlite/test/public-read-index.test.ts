import { expect, it } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { SqliteTestLayer } from "../src/index.js";

it("uses covering indexes for wildcard dependencies and the journal timestamp lookup", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const dependency = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN
      SELECT MAX(CASE WHEN recorded_position > 2 THEN 0 WHEN retracted_position <= 2
        THEN retracted_position ELSE recorded_position END) FROM triples INDEXED BY idx_dependency_all`);
      expect(dependency.map((row) => row.detail).join(" ")).toContain(
        "COVERING INDEX idx_dependency_all",
      );
      // The timestamp lookup of the adapter's recordedPositionAt, on the journal table.
      const journal = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN
      SELECT MAX(position) AS position FROM triplex_transactions
      WHERE instant <= 150 AND position <= 2`);
      // Either the (instant, position) index or the unique position index; never a scan.
      expect(journal.map((row) => row.detail).join(" ")).toMatch(
        /SEARCH triplex_transactions USING (COVERING )?INDEX (idx_transactions_instant|sqlite_autoindex_triplex_transactions_2)/,
      );
      expect(journal.map((row) => row.detail).join(" ")).not.toContain("SCAN");
    }).pipe(Effect.provide(SqliteTestLayer)),
  );
});
