# Triplex roadmap

This document outlines strategic enhancements to make `@triplex-build/triplex` a world-class, open-source triple store and Datalog engine.

For the implemented surface, backend maturity, and release status, start with
[`current-state.md`](current-state.md). Items below are future work unless explicitly marked
delivered.

The operational foundation and its ordering constraints are specified in
[`operational-primitives.md`](operational-primitives.md). Atomic KV transactions,
compare-and-retract conditions, causal transaction envelopes, and per-transaction change journals
are implemented, including a backend-issued commit cursor and resumable transaction pages. The
portable derivation candidates and their immutable, freshness-aware materialization runs are also
implemented, including durable temporal wakeups for future-effective and expiring evidence. The
wrapped Datalog API now has typed, scope-bound, commit-position-stable keyset cursors. Fixed
attribute dependency sets now have indexed freshness positions and temporal schedules across KV,
SQLite, and PostgreSQL. Graph constraints are content-addressed, produce durable queryable
observations, and can be enforced atomically across their full valid-time intervals. Command
receipts are atomically unique and durable consumer checkpoints are available through the
`operational` subpath. Indexed entity transaction timelines and PostgreSQL composition over an
ambient host-owned `SqlClient` or validated database-scoped pool are also delivered; relational
host rows, Triplex facts/journal, and outbox writes can share one Effect SQL transaction.

## Immediate release gate

- Delivered: a Changesets v3 GitHub workflow maintains the version PR, publishes stable releases,
  and can manually publish `next` snapshots without committing snapshot versions.
- Delivered: package checks install all tarballs and exercise the CLI as an external consumer.
- Delivered: the PostgreSQL multi-connection isolation and shared conformance suite run in CI.
- Delivered: Cloudflare and FoundationDB are private experimental workspace packages and cannot be
  included in the first release accidentally.
- Delivered: the GitHub repository cutover to `bjacobso/triplex`.
- Delivered: the protected GitHub environment and trusted publishers are configured for all six
  public packages; a registry-only consumer and a provenance-bearing GitHub OIDC `next` canary
  passed.
- Remaining: review and merge the initial version PR, approve the environment deployment, and
  verify the coordinated stable `0.1.0` release.

## Immediate correctness gate: backend parity

- The conformance corpus now runs identical typed projections, scalar joins, predicates, negation,
  booleans, ref joins, recursive transitive closure, grouped aggregation, bitemporal reads, and
  snapshot-stable pagination against KV, SQLite, and PostgreSQL. Grow it with every query-engine
  bug.
- Datalog conjunctions are clause-order independent across engines: positive relations establish
  outer bindings and patterns inside negation establish local bindings before predicates run.
- Runtime query shape, truly unbound variables, result/aggregate target collisions, empty
  disjunctions, undefined rules, unsupported recursive bodies, and wrapper projection references
  now fail through one backend-neutral typed preflight. Projection and joins cover all seven stored
  value types, and aggregate duplicate, distinct-count, and empty-input semantics are differential
  tested. Wrapped filters now validate operand arity and use typed projection columns so numeric,
  text-family, boolean, and null behavior agrees across backends. Direct ordering and keyset
  pagination now share a typed total order for mixed scalar families, including null placement and
  deterministic ties. Raw ordered predicates now accept only numeric-capable value bindings and
  numeric constants, rejecting backend-dependent text and identity coercions during typed
  preflight. Equality keeps entity, attribute, transaction, and rule identities string-typed rather
  than leaking SQL coercion. Group-key equality in `having` uses those same scalar families, while
  aggregate equality is numeric-only and optional projections are rejected before SQL compilation.
  Pattern constants now use the same scalar-family identity through positive patterns, negation,
  and disjunction, while typed refs remain exact. Pattern identity positions now reject non-string
  constants before backend execution. The `?` prefix is reserved for schema-valid variables, and
  constant projections retain typed primitive values through direct and wrapped execution.
  Continue expanding hostile schema-valid input.
- SQL projection now carries hidden canonical scalar-family columns through execution, so strings
  such as `"007"`, numeric-looking entity IDs and refs, datetimes, booleans, and JSON are decoded
  without guessing. Distinctness, grouping, counts, and page boundaries use that same flattened
  public identity across KV, SQLite, and PostgreSQL.
- Recursive SQL rule definitions, applications, optional projection attributes, and depth bounds
  are parameterized; validated rule names are quoted identifiers. The portable recursive shape is
  binary and identity-only. Same-named definitions union, repeated variables unify, and unsupported
  recursion fails during typed preflight.
- Keep PostgreSQL labelled as a pre-1.0 production candidate while its now-required CI corpus gains
  operational history. Keep FoundationDB and Cloudflare private and experimental until each passes
  the shared conformance and differential suites.

## 1. Schema-Aware Constraints & Enforcement

**Goal:** Move from a "bag of facts" to a reliable, structured database.

- Delivered: independently content-addressed required, cardinality, uniqueness, and reference-target
  nodes generated by the ontology DSL.
- Delivered: bitemporal read-only evaluation and immutable first-class findings through
  `EntityValidation`, with shared KV/SQLite/PostgreSQL conformance coverage.
- Delivered: opt-in transaction enforcement that rejects new or worsened post-state violations at
  every valid-time boundary and serializes concurrent absence/uniqueness decisions across KV,
  SQLite, and PostgreSQL.
- Delivered: indexed constraint candidate loading by source entity type and referenced target type,
  with batched subject expansion instead of a full live-fact scan.
- Graph constraints remain separate from value-local `TypeExpr` definitions.
- Next: explicitly modelled general Datalog invariants. Observation mode remains available for
  migrations and audit.

## 2. Reactive "Live" Queries (Watch API)

**Goal:** Power real-time, reactive user interfaces.

- Delivered foundation: dependency extraction, `SubscriptionManager.checkAffected`, indexed
  dependency positions, an ordered transaction feed, durable consumer checkpoints, and
  best-effort wakeup transport.
- Provide a `watchQuery` function that emits new results when relevant facts change.
- Enable incremental result updates to minimize re-computation.
- Build reliable invalidation on the ordered transaction feed; `ChangeEmitter` remains a
  best-effort wake-up mechanism.

## 3. Application-level tenancy and authorization

**Goal:** Native, safe isolation for SaaS applications.

- Delivered foundation: explicit database scope, branded `DatabaseId`, scope-bound cursors, and
  PostgreSQL schema-per-database isolation. SQLite hosts use one file/layer per database and KV
  callers use an explicitly named scope.
- Keep authenticated account-to-database selection and authorization above raw `Triples` until
  there is a complete threat model and a backend-portable query/write policy contract.
- Do not add an ambient `tenantId` column that silently changes query semantics.

## Delivered foundation: Bitemporality (Valid Time)

**Goal:** Distinguish between when a fact was recorded and when it became true.

- Implemented across KV, SQLite, and PostgreSQL with a shared recorded/valid basis for direct reads
  and Datalog.
- Differential tests cover historical corrections, future-effective facts, retractions, joins, and
  negation.
- Structural derivations expose the earliest recorded future `validFrom` or `validTo` across their
  dependency attributes. Immutable materialization runs persist and content-bind that schedule,
  including zero-candidate runs suppressed by negated evidence. A host scheduler can therefore
  reopen expiry-driven projections without a daily full scan. Fixed attribute sets use backend
  dependency indexes; dynamic-attribute definitions retain an explicit journal fallback.

## 4. Integrated Full-Text Search (FTS)

**Goal:** Seamlessly combine graph traversal with text search.

- Expose a `(fts ?entity "search term")` predicate within Datalog.
- Support relevance scoring and highlighting in query results.
- Leverage underlying SQL engine FTS capabilities (SQLite FTS5, Postgres GIN/GiST).

## 5. Performance & Query Optimization

**Goal:** Handle millions of triples with sub-millisecond latency.

- **Cost-Based Optimizer:** Reorder Datalog clauses based on attribute cardinality.
- **JSON Indexing:** Optimize `value_json` lookups for complex data types.
- **Recursive Rule Performance:** Optimize CTE generation for deep graph traversals.
- **Scoped concurrency (deferred):** Separate global journal ordering from entity and invariant
  conflict scopes only after the atomic multi-scope design in
  [`operational-primitives.md`](operational-primitives.md#deferred-scoped-optimistic-concurrency)
  has cross-backend conformance coverage.

## 6. Client-Side Sync & Offline-First

**Goal:** Enable seamless data replication to edge devices and browsers.

- Develop a sync protocol for replicating filtered triple subsets to a client.
- Provide a lightweight browser-side Hexastore for local querying.
- Implement conflict resolution strategies for offline writes.

## 7. Developer experience and tooling

**Goal:** Make the database "inspectable" and easy to use.

- **Database Studio:** A web-based UI for exploring entities, history, and snapshots.
- **OpenTelemetry Integration:** Built-in tracing for query execution and performance bottlenecks.
