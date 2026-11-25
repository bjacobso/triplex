# RFC: federated and distributed Datalog across hot, cold, and sharded stores

Status: **proposed; owner decisions required; no implementation**. This RFC changes no package
source or public exports.

## 1. Problem and motivation

[Hot/cold storage tiering and DuckDB](cold-tier-duckdb.md) scales a single logical Triplex database
to hundreds of millions of historical facts while keeping hot OLTP storage bounded by live state.
However, two scale regimes eventually exceed a single hot database node:

1. **Multi-workspace / multi-agent fleet queries**: Triplex's `packages/host` and `DatabaseScope`
   isolate one database per tenant, workspace, or agent swarm. Operators and meta-agents often need
   to query _across_ hundreds or thousands of isolated databases (e.g., global compliance, cross-org
   analytics, or fleet-wide agent memory search) without breaking tenant isolation.
2. **Single-database scale-out**: A single logical knowledge graph with **tens of millions of live
   entities** and **thousands of concurrent agent writes per second** exceeds the RAM, disk IOPS,
   or write throughput of a single SQLite file or single PostgreSQL primary.

This RFC separates these two regimes cleanly so Triplex does not over-engineer a distributed
consensus engine before simpler federation solves 90% of real workloads.

## 2. Level 1: Cross-database federated Datalog (read-only)

### Recommendation

Build a **read-only `FederatedQueryExecutor`** over explicit sets of `DatabaseScope` targets,
preserving Triplex's strict rule from [Roadmap](../roadmap.md): _never add an ambient `tenantId`
column that silently changes query semantics._

### Contract sketch

```ts
export interface FederatedTarget {
  readonly scope: DatabaseScope;
  readonly cut: { readonly recordedPosition: number };
  readonly source:
    | { readonly kind: "duckdb-parquet"; readonly uri: string }
    | { readonly kind: "sql"; readonly connectionRef: string };
}

export interface FederatedQueryRequest {
  readonly targets: readonly FederatedTarget[];
  readonly query: DatalogQuery;
  /** Explicit variable bound to each target's DatabaseId, required when >1 target. */
  readonly scopeVariable?: string;
}
```

### Semantics

- **Explicit scope binding**: Every result row can bind `?db` (via `scopeVariable`) so cross-shard
  entity IDs never silently collide. Joins across databases only occur when the query explicitly
  constrains or projects across scopes.
- **Per-target consistent cuts**: Each target is pinned to an explicit `recordedPosition` (or
  resolved to each shard's latest position at query start, returning a `vectorCut: Record<DatabaseId,
number>` inside the opaque pagination cursor). There is no cross-database distributed lock.
- **Execution**:
  - When targets publish live/cold Parquet snapshots to S3 (per
    [cold-tier-duckdb.md](cold-tier-duckdb.md)), a single DuckDB or **Apache DataFusion** worker
    scans only the authorized target prefixes in parallel with predicate pushdown and executes the
    compiled Datalog SQL.
  - For live hot shards, the coordinator fans out pushed-down subqueries per shard and merges
    projected bindings (for partition-local joins) or streams shard slices into DuckDB/DataFusion
    for cross-shard joins and aggregations.
- **Authorization**: The host authorizes the exact list of `targets` before invoking the federated
  executor. Unauthorized databases are never attached or scanned.

## 3. Level 2: Scale-out single logical database

When a _single_ logical database must scale past one PostgreSQL primary's live working set or write
throughput, two candidate architectures fit Triplex's contract.

### Candidate A: S3-native log + LSM/Parquet engine + stateless query workers (XTDB v2 / SlateDB model)

```
  Agent Writers
       │
       ▼
  Append-Only Ordered Log (Kafka / S3 Express / Postgres WAL / Raft log)
       │
       ├──► Hot In-Memory / NVMe Indexers (recent tail + live Arrow batches)
       │         │
       │         ▼ (background compaction: L0 -> Ln)
       └──► Object Storage (S3/R2): Sorted Arrow / Parquet Runs + Bloom Filters
                 │
                 ▼
  Stateless Distributed Query Workers (DataFusion / Ballista / DuckDB cluster)
```

- **Writes**: Transactions append to a durable ordered log, which naturally supplies Triplex's
  monotonic `recorded_position` without maintaining 17 B-trees synchronously on the write path!
  Write throughput scales to tens of thousands of triples/sec per log partition.
- **Compaction**: Background workers compact log segments into sorted Arrow/Parquet runs on S3
  (keyed by `(attribute, entity_id, recorded_position)` and `(entity_id, attribute,
recorded_position)`), deduplicating/folding retracted intervals cleanly.
- **Reads / Distributed Datalog**:
  - Stateless query workers (DataFusion / DuckDB) evaluate Datalog over the union of S3 Parquet
    runs + hot tail batches.
  - Large joins and aggregations shuffle across workers using standard distributed relational
    operators (hash-partitioned join, distributed semi-naive fixpoint for recursive rules).
- **Tradeoffs**:
  - **Pros**: Near-zero idle storage cost, elastic read scaling, unified hot+cold storage format
    (Arrow/Parquet everywhere), naturally bitemporal.
  - **Cons**: Non-interactive write model (same staged-overlay challenge documented in
    [XTDB blueprint](../xtdb.md)); higher point-lookup tail latency unless hot indexers cache live
    working sets on NVMe.

### Candidate B: Distributed transactional KV/SQL hot tier + cold Parquet tier

- **Hot tier**: FoundationDB (Triplex already has an experimental FDB backend in
  `packages/foundationdb`), TiKV, CockroachDB, or Citus-sharded PostgreSQL holds **live facts +
  recent tail**.
- **Cold tier**: Compaction watermark flushes retracted history to S3 Parquet (same protocol as
  [cold-tier-duckdb.md](cold-tier-duckdb.md)).
- **Distributed Datalog**:
  - Point lookups and selective entity/attribute joins execute directly against the distributed
    hot store (parallel range scans / pushdown).
  - Wide joins, aggregations, and historical/cross-tier queries execute in a stateless
    DataFusion/DuckDB query tier reading both hot and cold.
- **Tradeoffs**:
  - **Pros**: Preserves interactive `withTransaction` semantics, strict serializable preconditions,
    and low-latency point reads; builds directly on Triplex's existing `KvBackend` / SQL adapters
    and [TX1 scoped concurrency](tx1-scoped-concurrency.md).
  - **Cons**: Higher operational footprint than S3-native storage; distributed KV still needs
    sharded commit-position allocation or HLC-ordered publication.

## 4. Preserving Triplex contracts in distributed Datalog

Whichever Level 2 engine is chosen, it must preserve these non-negotiable Triplex guarantees:

| Contract                     | Distributed requirement                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bitemporal cut**           | Every distributed worker evaluates against the exact same `recordedPosition` (or `vectorCut` in Level 1) and `validAt`.                                                                     |
| **Deterministic pagination** | Opaque cursors bind the canonical query, cut, scope(s), and total-order keyset across retries even if a different stateless worker serves page 2.                                           |
| **Recursive rules**          | Binary identity-only transitive closure compiles to distributed semi-naive fixpoint (or bounded recursive CTE on the coordinator when the frontier is small) with strict depth/row budgets. |
| **Sensitive values**         | Blind tokens are compared across shards identically; plaintext never enters shuffle buffers or S3 Parquet.                                                                                  |
| **`why` provenance**         | Assertion/retraction `txId`s remain resolvable across hot + cold tiers at the pinned cut.                                                                                                   |

## 5. Phased delivery and decision gates

1. **Do not build Level 2 before Level 1 + Cold Tiering.** Most "millions of entities" workloads
   fit comfortably on a single hot PostgreSQL node once retracted history is offloaded to S3
   Parquet via [cold-tier-duckdb.md](cold-tier-duckdb.md) and write contention is relieved via
   [TX1 scoped concurrency](tx1-scoped-concurrency.md).
2. **Ship Level 1 (`FederatedQueryExecutor`) first**: It reuses `DuckDbQueryExecutor` and
   `DatabaseScope` directly, unlocking fleet-wide agent queries with minimal surface area.
3. **Gate Level 2 on measured benchmarks**: Publish a 10M-entity / 100M-fact stress benchmark in
   `test/stress` measuring single-node Postgres + Cold DuckDB before committing to either
   Candidate A (S3-native Arrow/Parquet LSM + DataFusion) or Candidate B (distributed KV/SQL hot
   tier).
