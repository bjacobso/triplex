/** Opt-in query benchmark. PG_BENCH_URL must point to a disposable database. */
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Triples, type DatalogQuery, type PagedQueryResponse } from "@bjacobso/triplex";
import { SqliteTriples } from "@bjacobso/triplex-sqlite";
import { PgTriples } from "@bjacobso/triplex-postgres";

const size = Number(process.env["DATALOG_BENCH_ENTITIES"] ?? 10_000);
if (!Number.isSafeInteger(size) || size < 100 || size > 1_000_000)
  throw new Error("DATALOG_BENCH_ENTITIES must be 100..1000000");
const backend = process.env["PG_BENCH_URL"] ? "postgresql" : "sqlite";
const layer = process.env["PG_BENCH_URL"]
  ? PgTriples.layerFromUrl(process.env["PG_BENCH_URL"]!)
  : SqliteTriples.layerMemory;
const cases: ReadonlyArray<{ name: string; query: DatalogQuery }> = [
  { name: "all-facts", query: { find: ["?e", "?a", "?v"], where: [["?e", "?a", "?v"]] } },
  { name: "attribute", query: { find: ["?e", "?name"], where: [["?e", ":bench/name", "?name"]] } },
  {
    name: "join",
    query: {
      find: ["?e", "?name", "?score"],
      where: [
        ["?e", ":bench/name", "?name"],
        ["?e", ":bench/score", "?score"],
        [">=", "?score", 50],
      ],
      orderBy: [{ variable: "?score", direction: "desc" }],
    },
  },
  {
    name: "aggregate",
    query: {
      find: ["?group", "?count"],
      where: [["?e", ":bench/group", "?group"]],
      aggregate: [["count", "?e", "?count"]],
    },
  },
];

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const triples = yield* Triples;
  const existing = yield* sql.unsafe<{ total: number | string }>(
    "SELECT COUNT(*) AS total FROM triples",
  );
  if (Number(existing[0]?.total) !== 0)
    return yield* Effect.fail(new Error("Benchmark requires an empty disposable database"));
  // Keep seeding out of timings. Isolated synthetic query-only data, no journal writes.
  const prefix = `bench:${Date.now()}:`;
  for (let start = 0; start < size; start += 200) {
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (let i = start; i < Math.min(start + 200, size); i++) {
      const entity = `${prefix}${String(i).padStart(7, "0")}`;
      for (const [attribute, type, text, number] of [
        [":bench/name", "string", `Person ${i}`, null],
        [":bench/score", "number", null, i % 100],
        [":bench/group", "string", `group:${i % 250}`, null],
      ]) {
        const row = [`${entity}:${attribute}`, entity, attribute, type, text, number];
        const placeholders = row.map((value) => {
          values.push(value);
          return backend === "sqlite" ? `?${values.length}` : `$${values.length}`;
        });
        tuples.push(`(${placeholders.join(",")},0,0,0)`);
      }
    }
    yield* sql.unsafe(
      `INSERT INTO triples (id,entity_id,attribute,value_type,value_string,value_number,recorded_at,recorded_position,valid_from) VALUES ${tuples.join(",")}`,
      values,
    );
  }
  yield* sql.unsafe("ANALYZE triples");
  const measurements = [];
  for (const { name, query } of cases) {
    for (const mode of ["all", "first", "later", "count"] as const) {
      let cursor: string | undefined;
      if (mode === "later") {
        // Advance five pages; report only the measured continuation request.
        for (let page = 0; page < 5; page++) {
          const result = yield* triples.query(query, {
            pageSize: 100,
            ...(cursor ? { cursor } : {}),
          });
          cursor = result.nextCursor;
          if (cursor === undefined) break;
        }
        if (!cursor) continue;
      }
      const request =
        mode === "all"
          ? triples.queryAll(query, { debug: true })
          : mode === "count"
            ? triples.queryPage({ inner: query, limit: 100, includeCount: true }, { debug: true })
            : triples.query(query, { pageSize: 100, debug: true, ...(cursor ? { cursor } : {}) });
      yield* request; // Warm-up.
      const timings = [];
      let last: PagedQueryResponse | undefined;
      for (let repetition = 0; repetition < 5; repetition++) {
        const started = performance.now();
        last = yield* request;
        timings.push(performance.now() - started);
      }
      timings.sort((a, b) => a - b);
      const debug = last!.debug!;
      const plan = yield* sql.unsafe(
        `${backend === "sqlite" ? "EXPLAIN QUERY PLAN" : "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)"} ${debug.generatedSql!}`,
        [...debug.params!],
      );
      measurements.push({
        name,
        mode,
        rows: last!.results.length,
        medianMs: timings[2],
        sqlMs: debug.executionTimeMs,
        countMs: debug.countExecutionTimeMs,
        sql: debug.generatedSql,
        plan,
      });
    }
  }
  return { backend, entities: size, facts: size * 3, measurements };
});

const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
console.log(JSON.stringify(result, null, 2));
