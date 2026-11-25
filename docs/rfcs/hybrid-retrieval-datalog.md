# RFC: full-text search and vector similarity in Datalog (`fts` and `similar`)

Status: **proposed; owner decisions required; no implementation**. This RFC changes no package
source or public exports.

## 1. Problem and motivation

Agents rarely query knowledge solely by exact string equality. They constantly need to combine
**fuzzy retrieval** (semantic similarity or keyword search) with **structured graph traversal,
bitemporal validity, and provenance**—for example:

> _"Find the top 20 incident notes semantically similar to this error trace that were valid last
> Tuesday, linked to service `billing`, excluding retracted facts and anything asserted by an
> unverified agent."_

Today, hosts must run a separate vector database or search index alongside Triplex, fetch candidate
entity IDs, and manually join them back—losing atomic consistency with `recorded_position`,
bitemporal correctness, and single-query provenance.

This RFC expands roadmap §4 (_Integrated Full-Text Search_) into a unified **hybrid retrieval**
contract for Datalog covering both full-text search (`fts`) and vector similarity (`similar`).

## 2. Ontology & value model

### Embeddings as a first-class typed value (or declared attribute type)

Add a `vector` value type (or `Attribute.embedding` over a packed float32 representation) to core's
`Value` and ontology DSL:

```ts
// Proposed ontology declarations (fragment)
const NoteBody = Attribute.text(":note/body").searchable();
const NoteEmbedding = Attribute.embedding(":note/embedding", {
  dimensions: 1536,
  metric: "cosine", // "cosine" | "l2" | "dot"
});
```

- **Storage**:
  - **PostgreSQL**: `vector(N)` (via `pgvector`) or a dedicated `triples_vectors(triple_id,
attribute, embedding)` sidecar table so `triples` rows stay compact and `pgvector` HNSW/IVFFlat
    indexes remain optional for databases that do not use embeddings.
  - **SQLite**: `sqlite-vec` virtual table sidecar keyed by `triple_id` + `FTS5` virtual table for
    searchable text attributes, maintained atomically inside the same SQLite transaction.
  - **DuckDB (cold/analytical)**: Native `FLOAT[N]` column in Parquet + DuckDB `vss` (HNSW) and
    `fts` extensions.
  - **In-memory KV**: Exact brute-force cosine/L2/dot scan and simple tokenized BM25/term match
    for deterministic conformance tests and browser/ephemeral use.
- **Why sidecar tables for SQL**: Keeps core `triples` row width small (avoiding 6 KB float32
  vectors bloating every B-tree page or full-row read) and makes vector/FTS extensions opt-in at
  migration/runtime time.

## 3. Datalog syntax and semantics

Introduce two built-in retrieval clauses in `where`:

```ts
// Full-text search: binds ?entity (and optionally ?score and ?tx)
["fts", "?e", ":note/body", "payment timeout retry", { score: "?score", limit: 50 }][
  // Vector similarity: binds ?entity (and optionally ?score)
  ("similar", "?e", ":note/embedding", queryVector, { metric: "cosine", k: 50, score: "?score" })
];
```

### Semantic rules (backend-independent)

1. **Temporal visibility is mandatory.** Both `fts` and `similar` must respect the query's exact
   `TemporalBasis` (`recordedPosition` / `recordedAt` and `validAt`). A retracted or
   future-effective fact must never leak into results just because it exists in an FTS or HNSW
   index.
2. **Explicit `k` / candidate bound.** `similar` requires a positive integer `k` (capped at a safe
   maximum, e.g. 1,000) so planners know whether to use ANN top-K index scans or exact reranking.
3. **Composable with standard Datalog.** Variables bound by `fts` or `similar` join freely with
   patterns, `not`, `or`, predicates, aggregates, fourth-term transaction joins (`:_tx/actor`), and
   wrapped pagination/ordering (`orderBy: [{ variable: "?score", direction: "desc" }]`).
4. **Score normalization & determinism.**
   - `similar` returns a numeric similarity/distance score in a documented direction per metric
     (e.g., cosine similarity in `[-1, 1]` higher-is-better, or distance lower-is-better—pick one
     convention and enforce it identically across backends).
   - `fts` returns a non-negative relevance score (higher-is-better). Because BM25 weights vary
     slightly between SQLite FTS5, Postgres `ts_rank`, and DuckDB FTS, conformance tests verify
     _exact membership and relative ordering on clear fixtures_, while exact floating-point equality
     across backends is explicitly non-normative for FTS (unlike `similar`, where exact cosine/L2
     agrees within `1e-5`).
   - Pagination tie-breaking still uses Triplex's canonical total-order keyset so pages never drift.

## 4. Pre-filtering vs. post-filtering at scale

With millions of entities and historical versions, naive ANN post-filtering (`ANN top-K` → filter by
`recorded_position` and `valid_at` and graph predicates) can return fewer than `k` results if many
nearest neighbors are retracted or filtered out.

Mitigations:

1. **Live-only ANN index + historical fallback**: Maintain the HNSW/IVFFlat index over _live_
   embeddings (or partition by `is_retracted`), and use iterative over-fetching (e.g., PostgreSQL
   `pgvector` 0.8+ iterative index scans) when residual temporal or graph predicates filter rows.
2. **Cold Parquet vector scans**: For historical cuts (`recordedPosition <= W`), DuckDB scans the
   time-pruned Parquet row groups and computes exact SIMD vector distance over the surviving
   candidates.
3. **Cost-based choice**: When structured Datalog predicates are highly selective (e.g., 200
   entities in one project), filter first and compute exact vector distance over those 200 rows
   instead of hitting the global ANN index.

## 5. Sensitive values and security

- **Hard rejection at planning time**: Running `fts` or `similar` on any `Attribute.sensitive`
  attribute fails during query preflight with `SensitiveQueryError`.
- Sealed values are never inserted into FTS or vector sidecar tables. Embeddings can leak
  plaintext semantics (inversion attacks), so hosts that want semantic search over regulated data
  must explicitly opt into a separate, non-sensitive derived attribute under host policy.

## 6. Hybrid scoring (RRF / weighted fusion)

Once `fts` and `similar` bind numeric `?ftsScore` and `?vecScore` variables, agents can express
hybrid search directly in Datalog (or via a small helper in `@triplex-build/triplex/database` that
compiles Reciprocal Rank Fusion / weighted combinations over `or`/optional joins) without adding
bespoke search DSLs.

## 7. Open questions & decision gates

1. **Embedding generation boundary**: Triplex should **not** call external LLM/embedding APIs inside
   `Triples.transact`. Embeddings are supplied by the host or computed asynchronously by a durable
   `Derivation` / journal consumer (preserving deterministic, offline-safe transactions).
2. **Optional capability**: Backends without `pgvector` or `sqlite-vec` installed should fail
   cleanly with a typed `UnsupportedCapabilityError` during preflight rather than a raw SQL error.
3. **Derivation provenance**: Decide whether `fts`/`similar` clauses are allowed inside
   `Derivation` definitions (exact provenance is straightforward for `similar` with exact scan,
   harder for approximate HNSW; initial release can reject approximate clauses in deterministic
   derivations).
