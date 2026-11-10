import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { EntityId, Triples } from "@triplex-build/triplex";
import { expect } from "vitest";

/** Many old unrelated facts plus a long later history on one entity. */
export const positionIndexPlan = (backend: "sqlite" | "postgres") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const triples = yield* Triples;
    yield* sql.unsafe(`
    WITH RECURSIVE items(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM items WHERE n < 10000)
    INSERT INTO triples (id, entity_id, attribute, value_type, value_string,
      recorded_at, recorded_position, valid_from)
    SELECT 'position:other:' || n, 'position:other:' || n, ':position/plan', 'string',
      'other', 0, n, 0 FROM items
  `);
    yield* sql.unsafe(`
    WITH RECURSIVE items(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM items WHERE n < 10000)
    INSERT INTO triples (id, entity_id, attribute, value_type, value_string,
      recorded_at, recorded_position, valid_from)
    SELECT 'position:target:' || n, 'position:target', ':position/plan', 'string',
      'target', 0, 10000 + n, 0 FROM items
  `);
    yield* sql.unsafe("ANALYZE triples");
    expect(
      yield* triples.entity(EntityId.make("position:target"), {
        recordedPosition: 10010,
        validAt: 1,
      }),
    ).toHaveLength(10);
    // Same predicate as the entity/batch/match direct read path.
    const statement = `SELECT * FROM triples WHERE entity_id = ${backend === "postgres" ? "$1" : "?"}
    AND recorded_position <= 10010
    AND (retracted_position IS NULL OR retracted_position > 10010)
    AND valid_from <= 1 AND (valid_to IS NULL OR valid_to > 1)`;
    const plan = yield* sql.unsafe(
      `${backend === "postgres" ? "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)" : "EXPLAIN QUERY PLAN"} ${statement}`,
      ["position:target"],
    );
    if (process.env["TRIPLEX_EXPLAIN"]) console.info(JSON.stringify({ backend, statement, plan }));
    expect(JSON.stringify(plan)).toContain("idx_entity_recorded_position");
  });
