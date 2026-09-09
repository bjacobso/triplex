# DuckDB analytical snapshot POC

Private, experimental Node.js package. Copies a migrated Triplex SQLite database into an
in-memory DuckDB columnar table and executes Triplex Datalog through the shared SQL compiler
and result decoder. SQLite remains the transactional system of record.

This evaluates native DuckDB execution without an engine fork. It is not a writable `Triples`
backend, distributed Datalog runtime, or S3 integration. No DuckDB extensions or network
downloads are required at runtime.

## Run

From the repository root:

```sh
pnpm install
pnpm exec turbo run build --filter=@bjacobso/triplex-duckdb
pnpm --filter @bjacobso/triplex-duckdb test
pnpm --filter @bjacobso/triplex-duckdb --silent benchmark > duckdb-benchmark.json
```

The benchmark creates disposable in-memory databases. It runs only when explicitly invoked;
small correctness tests participate in `pnpm check`.

```sh
DUCKDB_BENCH_ENTITIES=100000 DUCKDB_BENCH_ROUNDS=5 \
  pnpm --filter @bjacobso/triplex-duckdb --silent benchmark > duckdb-benchmark.json
```

`DUCKDB_BENCH_ENTITIES` defaults to 10,000 (maximum 1,000,000), `DUCKDB_BENCH_ROUNDS` to 5,
and `DUCKDB_BENCH_THREADS` to 4. `DUCKDB_BENCH_GRAPH_NODES` defaults to 128, capped by the
entity count. Increase it separately to stress recursive closure: the current SQLite plan
can become expensive even for modest graphs.

## Use a pinned snapshot

```ts
import { Effect } from "effect";
import { makeSqliteLayer } from "@bjacobso/triplex-sqlite";
import { DuckdbSnapshot } from "@bjacobso/triplex-duckdb";

const program = Effect.gen(function* () {
  const snapshot = yield* DuckdbSnapshot;
  const result = yield* snapshot.queryAll({
    find: ["?group", "?count"],
    where: [["?entity", ":person/group", "?group"]],
    aggregate: [["count", "?entity", "?count"]],
  });
  return { snapshot: snapshot.metadata, rows: result.results };
});

const result = await Effect.runPromise(
  program.pipe(
    Effect.provide(DuckdbSnapshot.layer({ scope: "my-database" })),
    Effect.provide(makeSqliteLayer("data.sqlite")),
  ),
);
```

`makeDuckdbSnapshot(options)` is also available for creating a snapshot after seeding or
writing within an existing Effect program. It requires `SqlClient` and `Scope`; keep all
queries inside `Effect.scoped`. `DuckdbSnapshot.layer` manages that scope for its consumers.
Use an already migrated SQLite source; the example's SQLite layer applies migrations.

Options include `basis: { recordedAt?, validAt? }`, `batchSize` (default 2,048; maximum
65,536), and native `threads` (default 4; maximum 64). Scope is a caller-supplied source label,
not an authorization boundary.

The importer reads the commit counter and all fact batches in one SQLite transaction.
It retains assertion/retraction history and pins every query to that commit position and
the resolved temporal basis. Later source writes cannot change a snapshot. To observe new
commits or choose another business-time instant, acquire a new snapshot. Invoke acquisition
outside an ambient write transaction if the snapshot must contain only committed data.

`queryAll(query, debug?)` completely materializes results. `queryWindow(wrappedQuery, debug?)`
supports wrapper filtering, explicit ordering, limits, and optional counts. Supply an explicit
`orderBy` with tie-breakers when comparing limited results. This low-level analytical service
does not expose `Triples` opaque cursors, subscriptions, transactions, or read-after-write
waiting. Debug output includes generated SQL, parameters, and compiler/execution metrics.

## What the benchmark measures

Both engines receive the same Datalog and exact temporal basis through the shared executor.
The fixture contains names, numeric scores, groups, bounded reference chains, and a retracted
score plus replacement for every tenth entity. It uses direct SQL seeding and a synthetic
commit counter, so it measures query execution rather than write throughput or journal cost.

For both current and historical cuts, the benchmark compares attribute scans, point lookups,
joins, grouped counts, bounded recursion, ordered first pages, and pages with counts. Each
backend is warmed before measurement. Timings include compilation, execution, and decoding;
seeding, snapshot import, warm-up, and checksum calculation are excluded. Import and seed
times are reported separately. Results and counts must match SQLite or the command fails.
JSON includes versions, fixture dimensions, snapshot metadata, result checksums, generated
SQL, and median/minimum/maximum elapsed times. Progress goes to stderr.

The default recursion fixture is intentionally small and remains fixed as the fact count
grows. It measures traversal amid unrelated facts, not distributed or large-graph scaling.
These are warm, single-client measurements in one process, with indexed SQLite and DuckDB's
shared-schema primary key; they are not concurrency, disk, or cold-start benchmarks.

## Local measurement

Measured September 9, 2026 in the development Linux x64 VM, using Node 24.14.1,
SQLite 3.51.2, DuckDB 1.5.5, and four DuckDB threads. This run used 100,000 entities,
310,124 stored facts including retractions, and 128 graph nodes. Values below are the
median of five warm executions at the current fixture cut (`recordedAt=25`, `validAt=100`,
`recordedPosition=2`). Builds and tests were idle during this run.

| Query                |    SQLite |    DuckDB |
| -------------------- | --------: | --------: |
| attribute-scan       | 254.65 ms | 236.16 ms |
| point-lookup         |   0.19 ms |   4.23 ms |
| join                 | 294.67 ms | 214.40 ms |
| grouped-count        | 161.56 ms |  23.08 ms |
| bounded-recursion    |  72.85 ms |  36.14 ms |
| first-100            | 108.41 ms |  21.51 ms |
| first-100-with-count | 202.47 ms |  39.02 ms |

Snapshot acquisition and import cost 2.39 seconds, excluded from the query timings.
Both temporal cuts passed result and count comparisons. The gains are workload-dependent:
point lookups favor SQLite, while grouped counts and ordered pages benefit from DuckDB.
The small fixed graph does not demonstrate large-graph scaling. These local diagnostics
are not production latency guarantees.

## Boundaries and next experiments

The POC transfers bounded batches through JavaScript, but retains the entire imported
database in DuckDB and materializes complete query results in JavaScript. It holds the SQLite
read transaction for the duration of copying; long copies can retain WAL history. Native
queries finish before scope cleanup, so interruption waits for an in-flight native query.

Focused tests cover typed projections, joins, negation, disjunction, aggregation, recursive
cycles, ordered windows/counts, recorded/valid time, and concurrent source writes during
batching. This is not the full writable-backend conformance suite. DuckDB uses native `ILIKE`;
cross-engine Unicode collation equivalence has not been established.

The next experiments are direct SQLite scanning versus native columnar storage, immutable
Parquet segments with snapshot manifests, and incremental projection from the Triplex journal.
Cross-shard recursive exchange, global snapshot coordination, retraction maintenance, and
object-storage persistence still require separate implementations.
