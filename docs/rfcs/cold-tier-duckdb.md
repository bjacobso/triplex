# RFC: hot/cold storage tiering, S3 Parquet compaction, and DuckDB `QueryExecutor`

Status: **proposed; owner decisions required; no implementation**. This RFC changes no package
source or public exports.

## 1. Problem and motivation

Triplex's 0.5 layout moved the journal out of `triples`, reducing storage footprint to ~699 bytes
per asserted triple on SQLite and ~1,044 bytes on PostgreSQL (see
[Storage footprint](../storage-footprint.md)). That is lean for back-office domains with tens or
hundreds of thousands of facts, but it hits three structural limits when agent workloads scale to
**millions of entities with millions of attribute mutations**:

1. **Historical index bloat in the hot OLTP table.** `triples` maintains 16–17 secondary indexes,
   several of which are non-partial (`idx_attribute_history`, `idx_temporal`,
   `idx_entity_recorded_position`, `idx_attribute_valid_from_history`,
   `idx_attribute_valid_to_history`, `idx_dependency_all`, `idx_attr_numeric`) so snapshot-pinned
   reads can still see facts retracted after the snapshot cut. At 1M entities × 10 attributes × 50
   mutations, 500M rows (~500 GB+ in PostgreSQL) sit in one hot table, and ~90% of write time goes
   to B-tree maintenance.
2. **Dead history degrades live snapshot reads.** Because `Triples.query` pins a
   `recorded_position`, partial `WHERE retracted_at IS NULL` indexes cannot serve snapshot pages.
   Once retracted rows outnumber live rows 20:1, current-state Datalog queries scan through dead
   history.
3. **Analytical and historical queries compete with OLTP writes.** Wide aggregations, full audit
   replays, and agent evals over historical cuts hit the same primary database serving live
   transactional writes.

Triplex's data model has an unusual property that makes tiering clean: **once a fact is retracted
at `retracted_position <= W`, that row is immutable forever** (modulo explicit sensitive-value
erasure/rewrap, addressed in §6).

## 2. Recommendation

Introduce a **watermark-bounded hot/cold storage architecture** with three composable pieces:

1. **Compaction & archival to Parquet on object storage (S3/R2/local FS)** for retracted facts and
   historical journal entries strictly at or below a durable compaction watermark `W`.
2. **A `DuckDbDialect` and `DuckDbQueryExecutor`** implementing Triplex's existing
   `QueryExecutor` SPI over Parquet / Iceberg / DuckLake datasets—usable both as a standalone
   cold/snapshot query engine and as a federated executor.
3. **A `TieredQueryExecutor` (and `TieredTriples` decorator)** that routes queries by their
   `TemporalBasis` relative to `W`:
   - Live / recent cuts (`recordedPosition > W`, no retracted-history scan) → **100% hot SQL**.
   - Historical cuts (`recordedPosition <= W`) → **100% cold DuckDB over Parquet**.
   - Cross-boundary, full-history, or heavy analytical queries → **DuckDB federating hot SQL
     (`ATTACH`) + cold Parquet** in one plan.

All TypeScript snippets below are proposed contract fragments (ordinary `ts` fences).

## 3. Compaction watermark contract

A database with cold tiering maintains a durable, monotonically advancing **compaction watermark**
`W` (`cold_watermark_position`, stored in a reserved metadata row and mirrored in the cold
manifest).

### Invariants

1. **Strict immutability below `W`.** A fact row is eligible for archival iff:
   - `retracted_position IS NOT NULL AND retracted_position <= W`, and
   - `W <= safe_cursor_position` (older than any active pagination cursor TTL and any pinned
     maintenance/derivation checkpoint that expects hot-only reads).
     Live facts (`retracted_position IS NULL`) always remain in the hot store (they may also be
     _copied_ into periodic S3 snapshots for read-only analytical clones, §5, without being removed
     from hot).
2. **Journal change-reference integrity.** As noted in
   [journal-change-references.md](journal-change-references.md), `triplex_transactions.changes`
   stores `[tripleId, op]` references rather than full copies. Archiving a retracted fact without
   preserving its reachability would break `Triples.transaction`, `transactions`, and `why` for
   historical positions. Therefore:
   - Journal rows with `position <= W` are archived alongside the facts they reference into a cold
     `transactions` Parquet table (and `transaction_entities` Parquet table).
   - If a journal entry at `position > W` references a fact whose `retracted_position <= W`? That
     is impossible because `retracted_position >= recorded_position` and a transaction only records
     facts it asserted (`recorded_position = position`) or retracted (`retracted_position =
position`). Still, an assertion at `position_1 <= W` retracted at `position_2 > W` stays in
     hot until `W >= position_2`.
   - Rebuilding `TransactionRecord.changes` for `position <= W` resolves `tripleId` against the
     union of cold + hot facts (or reads a pre-joined cold journal segment).
3. **Opaque pagination cursor safety.** Existing `Triples.query` cursors encode
   `recordedPosition`. If a cursor's `recordedPosition <= W`, continuation requests route through
   the cold/federated executor using the exact same canonical keyset order and scalar-family rules.
   Advancing `W` never invalidates an in-flight cursor as long as the archived rows are visible in
   the cold manifest **before** they are deleted from hot.
4. **Two-phase commit of archival.**
   1. Export rows with `retracted_position <= W_next` to immutable Parquet segment(s) and compute
      their domain-separated `ContentId`.
   2. Atomically publish the new cold manifest pointing to `W_next` (via S3 conditional `PUT` /
      Iceberg commit / DuckLake metadata tx) and update `cold_watermark_position = W_next` in the
      hot DB.
   3. Delete/detach rows with `retracted_position <= W_next` from the hot DB only after step 2 is
      durable. During the overlap window, federated queries deduplicate by `triple.id` (or filter
      cold to `retracted_position <= W_old` until hot deletion completes).

## 4. Cold Parquet layout and indexing

Each compacted segment writes three Parquet datasets under a database-scoped prefix
(`s3://<bucket>/<db-scope>/cold/`):

- `triples/bucket=<pos_bucket>/attr=<attr_hash>/part-<ulid>.parquet`
  - Columns match `TripleRow` (`id`, `entity_id`, `attribute`, `value_type`, `value_string`,
    `value_number`, `value_boolean`, `value_datetime`, `value_json`, `value_sealed`, `value_blind`,
    `recorded_at`, `recorded_position`, `valid_from`, `valid_to`, `created_by`, `retracted_at`,
    `retracted_position`, `retract_tx_id`, `entity_type`, `schema_version`, `tx_id`).
  - **Sort order**: `(attribute, entity_id, recorded_position)` within each row group (64k–256k
    rows). Parquet min/max statistics (zone maps) + Parquet bloom filters on `entity_id`, `tx_id`,
    and `value_string`/`value_blind` prune irrelevant files and row groups without secondary B-trees.
  - **Compression**: Zstd (level 3–6) with dictionary encoding on `attribute`, `entity_type`,
    `value_type`, `created_by`. Expected footprint: **~20–40 bytes/triple** (25–50× smaller than
    PostgreSQL).
- `transactions/bucket=<pos_bucket>/part-<ulid>.parquet` (sorted by `position`, bloom filter on
  `tx_id` and `command_id`).
- `transaction_entities/bucket=<pos_bucket>/part-<ulid>.parquet` (sorted by `(entity_id,
position)`).

An optional **Iceberg** or **DuckLake** catalog layer can manage the manifest, snapshot isolation,
and background small-file compaction (`L0 -> Ln`) so Triplex does not reinvent table-format
metadata.

### PostgreSQL hot-table synergy: live vs. retracted partitioning

On PostgreSQL, deleting millions of retracted rows triggers heavy `VACUUM` overhead. As an opt-in
PostgreSQL physical layout:

- Partition `triples` by `retracted_position IS NULL` (or a generated `is_retracted` boolean /
  range partition on `retracted_position` epoch buckets).
- Moving a retracted epoch to cold becomes **export → manifest commit → `ALTER TABLE triples DETACH
PARTITION ... CONCURRENTLY` → `DROP TABLE`**, eliminating vacuum storms completely.

## 5. `DuckDbDialect`, `DuckDbQueryExecutor`, and S3 snapshot clones

Triplex's SQL Datalog compiler already targets a narrow `SqlDialect` interface
(`packages/core/src/dialects/types.ts`):

```ts
export interface SqlDialect {
  readonly name: "sqlite" | "postgresql" | "mysql" | "duckdb";
  readonly limitOffset: (limit: number | undefined, offset: number | undefined) => string;
  readonly castAsText: (expression: string) => string;
  readonly booleanLiteral: (value: boolean) => string;
  readonly paramPlaceholder: (index: number) => string;
  readonly escapeLikePattern: (value: string) => string;
}
```

### `DuckDbQueryExecutor`

- Implements `QueryExecutorService` (`execute`, `executePage`, `explain`, `explainPage`) over a
  `SqlStatementRunner` backed by `@duckdb/node-api` (or DuckDB-Wasm in browser/edge environments).
- Must pass the **exact same shared Datalog conformance corpus** as KV, SQLite, and PostgreSQL:
  hidden canonical scalar-family projections, mixed-family total-order keyset pagination, typed
  equality/ordered predicates, negation, disjunction, grouped aggregation, binary recursive CTEs,
  and blind-index sealed-value equality.
- Dialect differences to verify explicitly:
  - `DOUBLE` / `BIGINT` arithmetic and `COALESCE(value_number, value_datetime)` cast behavior.
  - `NULL` ordering (`NULLS FIRST` / `NULLS LAST`) and bytewise string collation (`COLLATE C` /
    default UTF-8 binary comparison in DuckDB).
  - Recursive CTE cycle/depth bounds and parameter binding (`$1` or `?`).

### Tier-routed & federated execution (`TieredQueryExecutor`)

```ts
export interface TierRoutingPolicy {
  readonly watermark: Effect.Effect<number, ReadError>;
  readonly preferAnalyticalCold?: boolean;
}
```

Routing decision for a query with resolved `TemporalBasis`:

1. **Hot-only path**: `basis.recordedPosition > W` (or latest) AND the query only reads facts
   visible at that cut (all live facts and facts retracted _after_ `W` are guaranteed to be in hot!).
   - _Key insight_: Any fact retracted at `<= W` is **invisible** at any `recordedPosition > W`!
     Therefore, **100% of current-state and recent-snapshot Datalog queries never touch cold
     storage at all**, unless the query explicitly reads `:_tx/*` history below `W` or calls
     `history(entityId)`.
2. **Cold-only path**: `basis.recordedPosition <= W` AND no rows from `(W, head]` are needed?
   Careful: a fact asserted at `<= W` and still live (or retracted at `> W`) is in **hot**, not
   cold! So a point-in-time read at `recordedPosition <= W` needs `hot (where recorded_position <=
basis) UNION ALL cold (where recorded_position <= basis AND retracted_position > basis)` —
   **unless** a full S3 snapshot exists at `W`, in which case cold-only reads are possible.
3. **Federated path (DuckDB `ATTACH` hot + cold Parquet)**:
   - DuckDB attaches the hot PostgreSQL (`postgres_scanner`) or SQLite (`sqlite_scanner`) database
     read-only and exposes `triples`, `triplex_transactions`, and `triplex_transaction_entities` as
     `UNION ALL` views over hot + Parquet with predicate pushdown on `attribute`, `entity_id`,
     `recorded_position`, and `retracted_position`.
   - The existing Datalog SQL compiler compiles against those view names unchanged.

### Periodic S3 snapshots for instant agent clones

In addition to retracted-history compaction, a background job can export a **complete live
snapshot** at `recorded_position = P` to `s3://<bucket>/<db-scope>/snapshots/pos=<P>/`.

- Any agent, eval harness, or browser tab running DuckDB-Wasm can open a frozen, read-only
  `Triples` view of millions of entities directly from S3 with zero load on the production OLTP
  database.

## 6. Interaction with sensitive values and erasure

Per [Sensitive values](../sensitive-values.md):

- Cold Parquet files store only `value_sealed` and `value_blind`, never plaintext.
- **Crypto-shredding** (destroying a subject's data key in `triplex_data_keys`) immediately renders
  cold `value_sealed` unreadable without rewriting Parquet files.
- **Blind-token scrubbing on erasure** requires rewriting only the Parquet files containing that
  subject's `value_blind` tokens (pruned via bloom filters) or maintaining a compact erasure
  tombstone set checked by the cold executor. Rewriting affected segments during the next
  compaction cycle should be explicit and auditable.

## 7. Open questions & decision gates

1. **Table format**: Start with a minimal Triplex-owned JSON manifest (content-addressed via
   `ContentId`) or adopt **DuckLake** / **Apache Iceberg** from day one?
2. **Hot-table deletion strategy**: Simple batched `DELETE` for SQLite/small Postgres vs.
   partitioned `DETACH PARTITION` for large Postgres?
3. **DuckDB runtime packaging**: Keep `@triplex-build/triplex/duckdb` as an optional peer-dependency
   subpath (matching the existing architecture where core stays browser-safe and drivers are
   optional peers).
4. **Conformance gate**: `DuckDbQueryExecutor` must pass 100% of the shared Datalog conformance
   corpus (including differential tests against KV/SQLite/PostgreSQL and a new hot+cold split-cut
   conformance suite that compacts mid-history and verifies identical results before and after
   compaction).
