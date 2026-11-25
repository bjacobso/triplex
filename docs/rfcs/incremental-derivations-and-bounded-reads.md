# RFC: incremental derivation maintenance and bounded low-level reads at scale

Status: **proposed; owner decisions required; no implementation**. This RFC changes no package
source or public exports.

## 1. Problem and motivation

Two quieter bottlenecks surface as soon as a Triplex database grows to millions of entities and
entities accumulate tens of thousands of attribute mutations:

1. **Full re-evaluation of derivations and live queries.** Today,
   `Derivation.Materialization.materialize` (and the proposed [Live queries](live-queries.md)
   stream) re-executes the derivation's complete Datalog query across the database whenever any
   dependency attribute changes. At 10,000 entities that takes ~15–30 ms; at 5,000,000 entities,
   re-scanning an entire attribute or multi-way join on every agent write breaks sub-second
   reactivity and wastes CPU.
2. **Unbounded low-level read APIs.** As audited in
   [Datalog pagination and performance](../datalog-performance.md#read-path-audit), while
   `Triples.query` and `Triples.queryPage` are bounded to 100 rows by default (max 1,000),
   low-level `Triples.entity`, `Triples.entities`, `Triples.match`, and `Triples.history` still
   materialize complete arrays in memory. On an entity with 50,000 historical changes—or an agent
   calling `entity_facts` / `fact_match` via MCP—these calls can OOM the process or overflow an
   agent's context window.

This RFC specifies both fixes so reactive derivations and agent inspection stay O(delta) and
O(pageSize) regardless of total database size.

---

## Part 1: Incremental / delta-evaluated derivations

### 2. Two tiers of incremental maintenance

Rather than jumping straight to a full distributed stream processor, define a **two-level
incremental strategy** behind the existing `Derivation` and `LiveQuery` contracts:

#### Level A: Entity-scoped dirty-key re-evaluation (high leverage, works on SQLite & PostgreSQL)

Most practical derivations (and agent obligations) are **keyed by a root entity variable** in
`definition.identity` (e.g., `?worker`, `?case`, `?account`) and join attributes reachable within
1–2 hops from that key.

When advancing a materialization from `lastPosition` to `headPosition`:

1. Read journal changes in `(lastPosition, headPosition]` (already bounded and ordered by
   `Triples.transactions`).
2. Extract the **dirty candidate keys**:
   - Direct hits: changed `entityId`s whose `attribute` is in `definition.dependencies`.
   - Reverse-ref hops: for reference attributes in the query, resolve the 1-hop referencing
     entities via `idx_ref_target` (or a small parameterized Datalog delta query).
3. If the dirty key set is small (e.g., `<= 1,000` entities), execute the derivation's Datalog
   query **restricted to `dirtyKeys`** (injecting a parameterized `VALUES` / `IN` binding for the
   root identity variable), then patch only those candidate IDs in the materialized candidate set
   instead of recomputing all 5,000,000 entities.
4. Fall back to full re-evaluation automatically when:
   - the query uses global aggregates (`count`/`sum` across all entities),
   - the query uses recursive rules or dynamic attributes,
   - the dirty key set exceeds the threshold, or
   - an uncovered unjournaled position gap is observed.

**Exact provenance preserved:** Because each dirty candidate is re-evaluated through the same
Datalog/provenance path at `headPosition`, candidate identity, source triple provenance, and
`nextTemporalBoundary` remain 100% identical to full materialization.

#### Level B: Semi-naive delta Datalog / DBSP engine (for multi-hop joins & global aggregates)

For derivations with multi-hop joins, global aggregations, or high-frequency agent streams where
entity-scoped restriction isn't enough:

- Represent each `TransactionChange` (`assert` = `+1`, `retract` = `-1`) as a **Z-set delta**
  (inspired by DBSP / Differential Dataflow).
- Maintain indexed incremental join/aggregate state in a dedicated opt-in `IncrementalDerivation`
  worker (in-process Rust/Wasm/TS engine or external Feldera/Materialize adapter) fed by
  `Triples.transactions({ after })` and checkpointed via `ConsumerCheckpoint`.
- Emit standard `Derivation.reconcile` diffs (`added`, `removed`, `changed`) at each
  `recorded_position` so downstream `Runner` handlers do not change.

### 3. Temporal wakeup scaling

With millions of entities carrying `validTo` expiries, `Triples.dependencyState` returns the single
earliest future boundary. To avoid waking up and re-scanning all entities when _one_ certification
expires:

- Add an indexed query for **entities with valid-time boundaries in `(lastValidAt, now]`** using
  the existing `idx_attribute_valid_to_history` and `idx_attribute_valid_from_history` indexes.
- Feed those expiring `entityId`s directly into Level A's `dirtyKeys` set, so a valid-time expiry
  only re-evaluates the exact entities whose facts crossed the time boundary.

---

## Part 2: Bounded low-level reads & token-aware agent views

### 4. Cursor-paginated low-level `Triples` APIs

Add bounded, commit-position-pinned counterparts to the unbounded read methods on `Triples`
(`packages/core/src/store/Triples.ts`):

```ts
export interface FactPageRequest {
  readonly limit?: number; // default 100, max 1,000
  readonly cursor?: string; // opaque cursor pinned to recordedPosition + keyset
}

export interface FactPage {
  readonly triples: readonly Triple[];
  readonly snapshotPosition: number;
  readonly nextCursor?: string;
}

// Proposed additions on TriplesService:
// historyPage(entityId: EntityId, options?: FactPageRequest & { order?: "asc" | "desc" }): Effect<FactPage, ...>
// matchPage(pattern: Pattern, basis?: TemporalBasis, options?: FactPageRequest): Effect<FactPage, ...>
// entityFactsPage(entityId: EntityId, basis?: TemporalBasis, options?: FactPageRequest): Effect<FactPage, ...>
```

- **Storage-level keyset pagination**:
  - `historyPage` seeks `idx_entity_recorded_position (entity_id, recorded_position)` with keyset
    `(recorded_position, id)` and `LIMIT N + 1`—never loading the full history array.
  - `matchPage` uses the same pinned `snapshotPosition` and keyset `(id)` (or `(entity_id,
attribute, id)`) across SQLite, PostgreSQL, KV, and cold DuckDB.
- **Explicit complete-read naming**: Mirror the `query` vs. `queryAll` convention so callers
  explicitly opt into unbounded materialization, while CLI, MCP, and dashboard default to bounded
  pages.

### 5. Token-budget & summary projections for MCP and CLI

Agents inspecting large entities via `packages/mcp/src/index.ts`
often only need a concise view before drilling into specific attributes or history ranges:

- Update MCP `entity_facts` and `fact_match` to accept `limit` + `cursor` (defaulting to 100,
  returning `nextCursor` and `hasMore`).
- Add an optional `summary: true` mode on `entity_get` / `entity_facts` that returns attribute
  names, value types, live value counts, and latest `recordedAt` / `recordedPosition` without
  dumping large text/JSON blobs—letting agents selectively fetch only the attributes they need.
- Update the dashboard and explorer entity views to consume `historyPage` and `entityFactsPage`
  instead of slicing full arrays in JavaScript.

## 6. Open questions & decision gates

1. **Level A dirty-key soundness**: Static analysis of the Datalog query must _prove_ that the
   derived dirty-key set is a superset of all affected candidates (especially across `not` clauses
   and multi-attribute joins), falling back to full evaluation whenever soundness is not proven.
2. **Breaking change policy**: Pre-1.0 allows either adding `*Page` methods alongside existing
   `history`/`match` or making `history`/`match` bounded by default and introducing
   `historyAll`/`matchAll` (matching `query`/`queryAll`). Decide which ergonomic trade-off fits
   best before implementation.
3. **Conformance gate**: Differential test comparing Level A incremental materialization against
   full materialization across randomized sequences of assertions, retractions, corrections,
   valid-time expiries, and negated clauses.
