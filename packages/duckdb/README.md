# DuckDB snapshots and local federation POC

Private, experimental Node.js package. Copies a migrated Triplex SQLite database into an
in-memory DuckDB columnar table and executes Triplex Datalog through the shared SQL compiler
and result decoder. SQLite remains the transactional system of record.

This evaluates native DuckDB execution without an engine fork. It includes a local multi-process
federation POC: one immutable reader per SQLite database and a DuckDB query coordinator.
No DuckDB extensions or network downloads are required at runtime.

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

## Query two local SQLite databases

Run the disposable two-database example (including real worker processes):

```sh
pnpm --filter @bjacobso/triplex-duckdb demo:federation
```

Both databases contain `person:1` with the same email. The output contains one cross-database
match with distinct, source-qualified person IDs, worker PIDs, per-source commit cuts, scanned
attributes, and transferred row counts. The script verifies the two query syntaxes below.

```ts
import { Effect } from "effect";
import { DuckdbFederation, SnapshotProvider } from "@bjacobso/triplex-duckdb";

const program = Effect.gen(function* () {
  const db = yield* DuckdbFederation;
  return yield* db.queryAll({
    sources: { $a: "a", $b: "b" },
    find: ["?personA", "?personB", "?email"],
    where: [
      ["$a", "?personA", ":person/email", "?email"],
      ["$b", "?personB", ":person/email", "?email"],
    ],
  });
});

const result = await Effect.runPromise(
  program.pipe(
    Effect.provide(DuckdbFederation.layer()),
    Effect.provide(
      SnapshotProvider.local([
        { id: "a", tenant: "customer-a", filename: "/absolute/customer-a.sqlite" },
        { id: "b", tenant: "customer-b", filename: "/absolute/customer-b.sqlite" },
      ]),
    ),
  ),
);
```

Use existing Triplex SQLite files; federation opens them read-only and does not migrate or
create them. The catalog is trusted application configuration, not user query input. Aliases
bind catalog IDs, never filenames, and declaring an alias does not restrict unscoped patterns.
Only include databases the caller may query: this POC does not implement tenant authorization.

The same query can use ordinary Datalog membership and catalog patterns:

```ts
const query = {
  find: ["?personA", "?personB", "?email"],
  where: [
    ["?dbA", ":triplex/tenant", "customer-a"],
    ["?personA", ":triplex/database", "?dbA"],
    ["?dbB", ":triplex/tenant", "customer-b"],
    ["?personB", ":triplex/database", "?dbB"],
    ["?personA", ":person/email", "?email"],
    ["?personB", ":person/email", "?email"],
  ],
} as const;
```

`[$a, e, a, v, tx?]` lowers to the ordinary fact pattern plus database membership. The
`:triplex/database` ref links local entity, referenced, and transaction identities to their
database. `:triplex/tenant` links a database entity to its catalog tenant string (multiple
databases may share a tenant). Transaction provenance also works through
`["?e", ":person/email", "?email", "?tx"]`, `["?tx", ":_tx/database", "?db"]`, and
`["?db", ":triplex/tenant", "customer-a"]`. These three attributes are reserved virtual
facts; acquisition rejects visible source facts that use them.

Use `sourceEntity(databaseId, localId)` for literal entity/transaction IDs and ref constants
in ordinary patterns; `decodeSourceEntity` reverses result IDs. `databaseEntity(id)` addresses
a catalog entity. Source shortcuts qualify literal identities and typed ref constants
automatically. Plain string values remain unchanged, and every stored ref is local to its
source. Equal local IDs in different databases never join as entities, refs, or transactions.
Cross-database joins use shared scalar values such as email.

`makeDuckdbFederation(options)` requires `SnapshotProvider` and `Scope`. The layer handles
scope management. `mode` defaults to `"workers"`; `"in-process"` uses the identical source
reader without IPC and serves as a reference. `batchSize` defaults to 2,048 (maximum 65,536),
coordinator `threads` to 4 (maximum 64), and `workerTimeoutMs` to 30,000 per request. Each
worker uses one native DuckDB thread. At most 32 configured databases are accepted.

Each source is copied once at acquisition in a SQLite read transaction, then filtered at its
own pinned commit position and `basis: { recordedAt?, validAt? }`. These cuts are independent,
not a globally atomic snapshot. Subsequent writes do not change results; reacquire federation
to refresh. `sources` reports the cuts even before a query. Scope release closes native
handles and workers; a worker crash or timeout fails the query without partial results or
silently acquiring a newer snapshot.

`explain(query)` shows the normalized core query, selected databases, and projected attributes.
Flat source-constrained conjunctions can prune databases; complex clauses conservatively scan
all configured sources. Workers scan visible facts and requested membership attributes in
bounded IPC batches. The coordinator imports them into a fresh DuckDB table and executes joins,
negation, aggregation, and the existing bounded recursive rules. Results include `federation`
with per-source transferred row counts; `queryAll(query, true)` also exposes generated SQL. `queryWindow`
accepts a wrapped query with a federated `inner`, ordering, limit, and optional count.

Current limits:

- Source shortcuts work in top-level patterns and conjunctive `not`. Use ordinary core syntax
  in `or` and rules; unsupported shortcuts fail explicitly. The core negation clause limit
  applies after expansion. Bounded recursion runs at the coordinator, with no distributed
  fixpoint rounds or cross-source stored refs.
- Pushdown currently filters attributes, not join keys, predicates, or partial aggregates.
  Every configured source is snapshotted at acquisition, including subsequently pruned sources.
  Snapshots and each coordinator query table are in memory; IPC batches bound transfer size,
  not total memory. Queries are serialized within one federation instance. This establishes
  semantics and process boundaries, not a horizontal scaling or performance claim.
- No S3 access, replication, remote RPC, authentication, incremental updates, or snapshot cache.
  A future `SnapshotProvider` can restore a consistent, versioned SQLite snapshot locally.
  Direct random reads of SQLite pages from S3 require a separate storage/VFS design; uploading
  a SQLite file or its WAL does not make remote access equivalent to a local file.

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
