import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { EntityId, Triples, number } from "@triplex-build/triplex";
import { makeSqlLivePreconditionLookup, SqliteDialect } from "@triplex-build/triplex-sql";

/** Same guarded value, growing retracted history and unrelated live attributes. */
export const livePreconditionIndexPlan = (backend: "sqlite" | "postgres") =>
  Effect.gen(function* () {
    const evidence = [];
    const sql = yield* SqlClient.SqlClient;
    const databaseVersion = yield* sql.unsafe(
      backend === "postgres" ? "SELECT version() AS version" : "SELECT sqlite_version() AS version",
    );
    const t = yield* Triples;
    const entityId = EntityId.make("guard:plan");
    for (const count of [10, 10000]) {
      yield* sql`DELETE FROM triples WHERE entity_id = ${entityId}`;
      yield* sql.unsafe(`WITH RECURSIVE items(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM items WHERE n < ${count})
      INSERT INTO triples(id, entity_id, attribute, value_type, value_number, recorded_at, recorded_position, valid_from, retracted_at, retracted_position)
      SELECT 'guard:history:' || n, 'guard:plan', ':guard/version', 'number', n, 0, 1, 0, 1, 2 FROM items`);
      yield* sql.unsafe(`WITH RECURSIVE items(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM items WHERE n < ${count})
      INSERT INTO triples(id, entity_id, attribute, value_type, value_number, recorded_at, recorded_position, valid_from)
      SELECT 'guard:other:' || n, 'guard:plan', ':other/' || n, 'number', n, 0, 1, 0 FROM items`);
      yield* sql.unsafe(`WITH RECURSIVE items(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM items WHERE n < 1000)
      INSERT INTO triples(id, entity_id, attribute, value_type, value_number, recorded_at, recorded_position, valid_from)
      SELECT 'guard:unrelated:' || n, 'guard:unrelated:' || n, ':guard/version', 'number', n, 0, 1, 0 FROM items WHERE 1=1
      ON CONFLICT(id) DO NOTHING`);
      yield* t.assert({ entityId, attribute: ":guard/version", value: number(42) });
      yield* t.transact([], {
        preconditions: [
          { _tag: "AttributeValue", entityId, attribute: ":guard/version", value: number(42) },
          { _tag: "AttributeAbsent", entityId, attribute: ":guard/missing" },
          { _tag: "EntityAbsent", entityId: EntityId.make("guard:missing") },
        ],
      });
      yield* sql.unsafe("ANALYZE triples");
      const statements: { statement: string; params: readonly unknown[] }[] = [];
      const lookup = makeSqlLivePreconditionLookup(
        {
          run: (statement, params) => {
            statements.push({ statement, params });
            return Effect.succeed([]);
          },
        },
        backend === "postgres"
          ? { ...SqliteDialect, name: "postgresql", paramPlaceholder: (n: number) => `$${n + 1}` }
          : SqliteDialect,
      );
      yield* lookup(entityId, ":guard/version", 2);
      yield* lookup(entityId, ":guard/missing", 1);
      yield* lookup("guard:missing", undefined, 1);
      for (const [index, query] of statements.entries()) {
        const statement =
          backend === "postgres"
            ? query.statement.replace(/\?(\d+)/g, (_, n: string) => `$${n}`)
            : query.statement;
        const plan = yield* sql.unsafe(
          `${backend === "postgres" ? "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)" : "EXPLAIN QUERY PLAN"} ${statement}`,
          query.params,
        );
        if (count === 10000 || backend === "sqlite")
          expect(JSON.stringify(plan)).toMatch(
            index === 2
              ? /idx_entity/
              : backend === "postgres"
                ? /idx_live_precondition_key|idx_entity_attr/
                : /idx_entity_attr/,
          );
        evidence.push({ backend, history: count, statement, plan });
        if (process.env["TRIPLEX_EXPLAIN"])
          console.info(JSON.stringify({ backend, history: count, statement, plan }));
      }
    }
    const path = process.env["TRIPLEX_LIVE_PLANS"];
    if (path)
      writeFileSync(
        path,
        JSON.stringify(
          {
            sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
            dirty:
              execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length >
              0,
            node: process.version,
            databaseVersion,
            measuredAt: new Date().toISOString(),
            evidence,
          },
          null,
          2,
        ) + "\n",
      );
  });
