/** Opt-in, disposable in-memory analytical benchmark. No provider credentials. */
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { type DatalogQuery, type WrappedQuery } from "@bjacobso/triplex";
import { QueryExecutor } from "@bjacobso/triplex/internal";
import { SqliteTriples } from "@bjacobso/triplex-sqlite";
import { makeDuckdbSnapshot } from "../src/index.js";

const positiveInteger = (name: string, fallback: number, max: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(`${name} must be 1..${max}`);
  return value;
};
const entities = positiveInteger("DUCKDB_BENCH_ENTITIES", 10_000, 1_000_000);
const rounds = positiveInteger("DUCKDB_BENCH_ROUNDS", 5, 100);
const threads = positiveInteger("DUCKDB_BENCH_THREADS", 4, 64);
const graphNodes = Math.min(entities, positiveInteger("DUCKDB_BENCH_GRAPH_NODES", 128, 1_000_000));
const names: DatalogQuery = { find: ["?e", "?name"], where: [["?e", ":bench/name", "?name"]] };
const cases: readonly { name: string; query: DatalogQuery; window?: WrappedQuery }[] = [
  { name: "attribute-scan", query: names },
  {
    name: "point-lookup",
    query: { find: ["?name"], where: [["e:0000000", ":bench/name", "?name"]] },
  },
  {
    name: "join",
    query: {
      find: ["?e", "?name", "?score"],
      where: [
        ["?e", ":bench/name", "?name"],
        ["?e", ":bench/score", "?score"],
        [">=", "?score", 50],
      ],
    },
  },
  {
    name: "grouped-count",
    query: {
      find: ["?group", "?count"],
      where: [["?e", ":bench/group", "?group"]],
      aggregate: [["count", "?e", "?count"]],
    },
  },
  {
    name: "bounded-recursion",
    query: {
      find: ["?target"],
      where: [["reach", "e:0000000", "?target"]],
      rules: [
        { name: "reach", body: [["?x", ":bench/next", "?y"]], maxDepth: 16 },
        {
          name: "reach",
          body: [
            ["?x", ":bench/next", "?z"],
            ["reach", "?z", "?y"],
          ],
          maxDepth: 16,
        },
      ],
    },
  },
  {
    name: "first-100",
    query: names,
    window: { inner: names, limit: 100, orderBy: [{ variable: "?e", direction: "asc" }] },
  },
  {
    name: "first-100-with-count",
    query: names,
    window: {
      inner: names,
      limit: 100,
      includeCount: true,
      orderBy: [{ variable: "?e", direction: "asc" }],
    },
  },
];

const checksum = (rows: readonly Record<string, unknown>[]) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        rows
          .map((row) =>
            JSON.stringify(
              Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))),
            ),
          )
          .sort(),
      ),
    )
    .digest("hex");

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sqlite = yield* QueryExecutor;
  const seedStart = performance.now();
  // Synthetic facts bypass the write API deliberately; these timings measure
  // query execution, not transaction throughput. Include retraction history.
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (let start = 0; start < entities; start += 100) {
        const params: unknown[] = [];
        const tuples: string[] = [];
        const add = (row: unknown[]) =>
          tuples.push(
            `(${row
              .map((value) => {
                params.push(value);
                return `?${params.length}`;
              })
              .join(",")})`,
          );
        for (let i = start; i < Math.min(start + 100, entities); i++) {
          const entity = `e:${String(i).padStart(7, "0")}`;
          const updated = i % 10 === 0;
          for (const [attribute, type, text, value] of [
            [":bench/name", "string", `Person ${i}`, null],
            [":bench/score", "number", null, i % 100],
            [":bench/group", "string", `group:${i % 250}`, null],
          ]) {
            const retracted = updated && attribute === ":bench/score";
            add([
              `${entity}:${attribute}`,
              entity,
              attribute,
              type,
              text,
              value,
              10,
              1,
              0,
              retracted ? 20 : null,
              retracted ? 2 : null,
            ]);
          }
          if (updated)
            add([
              `${entity}:new-score`,
              entity,
              ":bench/score",
              "number",
              null,
              99,
              20,
              2,
              0,
              null,
              null,
            ]);
          // Disjoint chains keep closure size linear in entities at fixed depth.
          if (i % 32 !== 31 && i + 1 < graphNodes)
            add([
              `${entity}:next`,
              entity,
              ":bench/next",
              "ref",
              `e:${String(i + 1).padStart(7, "0")}`,
              null,
              10,
              1,
              0,
              null,
              null,
            ]);
        }
        yield* sql.unsafe(
          `INSERT INTO triples
        (id,entity_id,attribute,value_type,value_string,value_number,recorded_at,recorded_position,valid_from,retracted_at,retracted_position)
        VALUES ${tuples.join(",")}`,
          params,
        );
      }
      yield* sql.unsafe("INSERT INTO triplex_commit_position VALUES (1,2)");
    }),
  );
  yield* sql.unsafe("ANALYZE triples");
  const seedTimeMs = performance.now() - seedStart;
  const reports = [];
  for (const recordedAt of [25, 15]) {
    const report = yield* Effect.scoped(
      Effect.gen(function* () {
        const snapshot = yield* makeDuckdbSnapshot({
          scope: "benchmark",
          basis: { recordedAt, validAt: 100 },
          threads,
        });
        const measurements = [];
        for (const entry of cases) {
          process.stderr.write(`recordedAt=${recordedAt} query=${entry.name}\n`);
          const requests = {
            sqlite: entry.window
              ? sqlite.executePage(entry.window, true, snapshot.metadata.basis)
              : sqlite.execute(entry.query, true, snapshot.metadata.basis),
            duckdb: entry.window
              ? snapshot.queryWindow(entry.window, true)
              : snapshot.queryAll(entry.query, true),
          };
          const baseline = yield* requests.sqlite;
          const expected = checksum(baseline.results);
          const expectedCount = "totalCount" in baseline ? baseline.totalCount : undefined;
          for (const backend of ["sqlite", "duckdb"] as const) {
            yield* requests[backend]; // Warm up separately from measurements.
            const elapsed: number[] = [];
            let result = baseline;
            for (let round = 0; round < rounds; round++) {
              const start = performance.now();
              result = yield* requests[backend];
              elapsed.push(performance.now() - start);
            }
            const digest = checksum(result.results);
            const totalCount = "totalCount" in result ? result.totalCount : undefined;
            if (digest !== expected || totalCount !== expectedCount)
              return yield* Effect.fail(
                new Error(`Result mismatch: ${entry.name}, ${backend}, recordedAt=${recordedAt}`),
              );
            elapsed.sort((a, b) => a - b);
            const middle = Math.floor(elapsed.length / 2);
            measurements.push({
              query: entry.name,
              backend,
              rows: result.results.length,
              totalCount,
              medianMs:
                elapsed.length % 2 === 0
                  ? (elapsed[middle - 1]! + elapsed[middle]!) / 2
                  : elapsed[middle],
              minMs: elapsed[0],
              maxMs: elapsed[elapsed.length - 1],
              checksum: digest,
              sql: result.debug?.generatedSql,
              params: result.debug?.params,
            });
          }
        }
        return { snapshot: snapshot.metadata, measurements };
      }),
    );
    reports.push(report);
  }
  const version = yield* sql.unsafe<{ version: string }>("SELECT sqlite_version() AS version");
  return {
    entities,
    graphNodes,
    rounds,
    seedTimeMs,
    sqliteVersion: version[0]?.version,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    reports,
  };
});

const report = await Effect.runPromise(program.pipe(Effect.provide(SqliteTriples.layerMemory)));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
