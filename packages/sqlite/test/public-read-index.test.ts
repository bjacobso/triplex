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
      const journal = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN
      SELECT MAX(recorded_position) FROM triples INDEXED BY idx_journal_instant_position
      WHERE attribute = ':_tx/instant' AND entity_type = '_Transaction'
        AND recorded_at <= 150 AND recorded_position <= 2`);
      expect(journal.map((row) => row.detail).join(" ")).toContain("idx_journal_instant_position");
      expect(journal.map((row) => row.detail).join(" ")).not.toContain("SCAN triples");
    }).pipe(Effect.provide(SqliteTestLayer)),
  );
});
