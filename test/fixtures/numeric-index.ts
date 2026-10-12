import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Triples } from "@triplex-build/triplex";
import { expect } from "vitest";

/** Exercise the public page SQL, including its recorded-position snapshot. */
export const numericIndexPlan = (backend: "sqlite" | "postgres") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const triples = yield* Triples;
    yield* sql`DELETE FROM triples WHERE attribute IN (':plan/due', ':plan/pending')`;
    // 160 due items, 9,840 sleeping items, plus their pending markers. Numeric
    // timestamps alternate storage types; physical rows avoid journal overhead.
    yield* sql.unsafe(`
      WITH RECURSIVE items(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM items WHERE n < 10000
      )
      INSERT INTO triples (id, entity_id, attribute, value_type, value_number,
        value_datetime, recorded_at, recorded_position, valid_from)
      SELECT 'plan:due:' || n, 'plan:item:' || n, ':plan/due',
        CASE WHEN n % 2 = 0 THEN 'datetime' ELSE 'number' END,
        CASE WHEN n % 2 = 1 THEN CASE WHEN n <= 160 THEN n ELSE 1000000 + n END END,
        CASE WHEN n % 2 = 0 THEN CASE WHEN n <= 160 THEN n ELSE 1000000 + n END END,
        1, 0, 1 FROM items
    `);
    yield* sql.unsafe(`
      INSERT INTO triples (id, entity_id, attribute, value_type, value_string,
        recorded_at, recorded_position, valid_from)
      SELECT 'marker:' || id, entity_id, ':plan/pending', 'ref', 'plan:actor', 1, 0, 1
      FROM triples WHERE attribute = ':plan/due'
    `);
    // Include history: the numeric index must remain eligible for snapshot reads.
    yield* sql.unsafe(`
      INSERT INTO triples (id, entity_id, attribute, value_type, value_number,
        recorded_at, recorded_position, valid_from, retracted_at, retracted_position)
      SELECT 'history:' || id, entity_id, attribute, 'number', 0,
        0, 0, 0, 1, 0 FROM triples WHERE attribute = ':plan/due' AND value_number <= 160
    `);
    yield* sql.unsafe("ANALYZE triples");
    const query = {
      find: ["?item", "?actor", "?due"],
      where: [
        ["?item", ":plan/due", "?due"],
        ["<=", "?due", 160],
        ["?item", ":plan/pending", "?actor"],
      ],
      orderBy: [{ variable: "?due", direction: "asc" }],
      limit: 128,
    } as const;
    // queryAll also checks the live-read predicate, while query checks the real
    // Runfold call path (with its default outer page size) and explicit 128 pages.
    for (const mode of ["live", "default-page", "128-page"] as const) {
      const result = yield* mode === "live"
        ? triples.queryAll(query, { debug: true })
        : triples.query(query, { debug: true, ...(mode === "128-page" ? { pageSize: 128 } : {}) });
      expect(result.results.map((row) => row["?due"])).toEqual(
        Array.from({ length: mode === "default-page" ? 100 : 128 }, (_, index) => index + 1),
      );
      const debug = result.debug!;
      const plan = yield* sql.unsafe(
        `${backend === "sqlite" ? "EXPLAIN QUERY PLAN" : "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)"} ${debug.generatedSql}`,
        debug.params,
      );
      if (process.env["TRIPLEX_EXPLAIN"]) {
        console.info(
          JSON.stringify({ backend, mode, sql: debug.generatedSql, params: debug.params, plan }),
        );
      }
      if (backend === "sqlite") {
        const details = plan.map((row) => String(row["detail"]));
        expect(
          details.some((detail) => /idx_attr_numeric.*attribute=\?.*<expr></.test(detail)),
        ).toBe(true);
      } else {
        const nodes: Record<string, unknown>[] = [];
        const visit = (value: unknown): void => {
          if (typeof value !== "object" || value === null) return;
          if ("Index Name" in value) nodes.push(value as Record<string, unknown>);
          for (const child of Object.values(value)) visit(child);
        };
        visit(plan);
        expect(
          nodes.some(
            (node) =>
              node["Index Name"] === "idx_attr_numeric" &&
              /attribute.*COALESCE.*<=/s.test(String(node["Index Cond"])),
          ),
        ).toBe(true);
      }
    }
  });
