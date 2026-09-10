# Operational Primitives

Triplex is a durable substrate for applications that need temporal facts, derivations, and audit.
This specification separates database/runtime guarantees that belong in Triplex from workflow and
product concepts that belong in a host application.

## Implemented foundation

### Atomic transactions

`Triples.transact` is the authoritative portable command boundary. `assert`, `assertBatch`,
`retract`, and `retractByPattern` delegate to it, so every supported write receives one commit
position and causal envelope. SQL adapters execute it in a native SQL transaction. KV
implementations create a transaction-scoped hexastore over `KvBackend.transact`; all index and
metadata writes commit or roll back together. The in-memory backend serializes transactions and
buffers their writes. A completed KV transaction clears the shared decoded-datom cache so reads
observe its result.

### Compare-and-retract

A transaction may declare `TripleLive` preconditions. Each condition must identify an explicit
`retract` operation in the same transaction. Retraction is the atomic comparison: exactly one
writer can retract the expected live fact. A stale writer receives `TransactionConflictError` and
all of its writes roll back.

This intentionally small primitive covers moving pointers and state machines without pretending
that a read followed by an arbitrary write is compare-and-set. Config refs and entity-validation
heads use it. There is no generic public "assert when no value exists" precondition. The narrower
graph-constraint enforcement path does atomically protect declared required, cardinality,
uniqueness, and reference-target invariants by evaluating them inside the serialized commit
boundary.

### Causal transaction envelopes

Every successful `transact` persists an `_Transaction` entity with:

- `:_tx/position`;
- `:_tx/instant`;
- `:_tx/actor`;
- `:_tx/command-id`;
- `:_tx/correlation-id`;
- `:_tx/causation-id`;
- `:_tx/config-snapshot`; and
- one indexed `:_tx/changed-entity` reference per changed application entity; and
- one `:_tx/change` JSON fact for every asserted or retracted application fact.

`Triples.transaction(txId)` reconstructs the typed envelope. The same facts remain available to
Datalog for application-specific audit queries. A command ID is an atomically unique idempotency
identity within one Triplex database. Concurrent attempts acquire a backend-local claim inside the
same transaction as the facts and envelope; exactly one commits. A loser receives
`CommandAlreadyCommittedError` with the original transaction ID, and
`Triples.transactionByCommand(commandId)` loads that durable receipt.

`Triples.transactionsForEntity(entityId, request)` uses the changed-entity references to read a
bounded newest-first audit page without replaying or decoding the global journal. It deduplicates
transactions that changed several facts on the entity, then hydrates their authoritative complete
envelopes. The first page returns a `snapshotPosition`; continuation requests combine it with the
exclusive `nextBeforePosition`, so concurrent later commits do not enter an in-progress timeline.
Invalid limits and positions fail with `ReadError`, and an unknown entity returns an empty page.

### Ordered transaction feed

The backend allocates a monotonically increasing commit position inside the same atomic boundary
as the application facts and causal envelope. `Triples.transactions({ after, limit })` returns
envelopes in that order and exposes the last position as the next durable resume cursor. Failed
transactions publish neither facts nor a position. This avoids treating timestamps or
client-generated ULIDs as commit order under concurrency.

The feed covers every successful application fact write. Delivery built on repeated page reads is
at least once, so consumers retain a checkpoint and deduplicate by command or transaction identity.
`ChangeEmitter` remains a best-effort wake-up mechanism and never replaces catch-up reads.

### Consumer checkpoints

`@triplex-build/triplex/operational` stores one reserved, queryable checkpoint entity per named
consumer. `ConsumerCheckpoint.advance` accepts the position read before processing and the final
position whose effects completed. Moving it uses compare-and-retract, never moves backwards, and
returns a typed conflict to a stale worker. The initial write is protected by the same atomic
command-claim mechanism, so concurrent initialization cannot create two live positions.

Checkpoint maintenance is atomically persisted but intentionally omitted from the transaction
feed. Otherwise an idle consumer would observe its own cursor update, advance past it by writing
another cursor update, and repeat forever. These unjournaled system writes still allocate commit
positions, so recorded snapshot ordering remains total; application commands remain fully
journaled.

### Snapshot-stable Datalog pages

`Triples.queryPage` returns an opaque, versioned keyset cursor. Its content-addressed fingerprints
bind the canonical query, filters, complete deterministic projected-row ordering, temporal basis,
and database scope. The first page captures the backend's latest committed position; assertion and
retraction positions keep every later page on that exact recorded snapshot, including when two
transactions share the same recorded millisecond. Cursor decoding and reuse failures are typed as
`PaginationCursorError`.

### Bitemporal query basis

Facts carry separate recorded and valid intervals. Direct matching, entity reads, batched reads,
and Datalog accept the same `{ recordedAt?, validAt? }` basis, so every clause in a join,
negation, or rule sees one coherent cut. Historical corrections append new facts; they do not
rewrite the recorded history.

### Portable derivations and pure reconciliation

`@triplex-build/triplex/derivation` provides a content-addressed `Definition` that pins a complete
structural Datalog query, optional result `TypeExpr`, canonical identity projection, discovered
attribute dependencies, and configuration snapshot. Evaluation returns `Candidate` values with:

- a stable logical identity derived from the definition name and declared result key;
- a revision covering the exact definition, config pin, result, and explanation;
- the pinned bitemporal basis;
- merged source triple IDs and assertion transaction IDs/positions from every positive graph path;
  and
- the earliest future `validTo` among supporting facts, when one is known.

The complete `Evaluation` also exposes a conservative `nextTemporalBoundary` across the current
recorded view of every dependency attribute. It includes both future `validFrom` and `validTo`
edges, including facts inside negated clauses that currently suppress every candidate. This lets a
host wake exactly when evidence may expire or become effective without a daily full scan.
`Triples.dependencyState` derives both the dependency-relevant source position and this schedule
through backend attribute indexes. It can produce harmless extra wakeups for unrelated entities
that share an attribute, but it does not omit a recorded boundary.

`reconcile` is a pure diff that classifies candidates as `added`, `removed`, `changed`, or
`unchanged`. A host can translate that diff into durable requirement occurrences, tasks, or other
governed work without coupling those concepts to Triplex. Conflicting outputs for the same
declared identity fail with a typed error rather than being selected arbitrarily.

`Derivation.Materialization` persists candidate revisions and complete evaluation runs as
immutable Triples system entities. Each run atomically binds its definition, config snapshot,
bitemporal basis, candidate set, and latest dependency-relevant transaction position. There is no
mutable first-writer checkpoint race: the current run for a definition is selected by source
position and then materialization commit position. A newly deployed definition has its own stream,
while reconciliation can still compare its stable logical candidate identities with the preceding
run for the same name.

`current` returns explicit `current`, `stale`, or `unmaterialized` state and retains the last
durable candidates when stale. Relevant transaction positions are derived from the definition's
discovered attributes; materializer and unrelated transactions do not create false lag. Persisted
candidate bodies are schema-decoded and content-verified. Immutable run membership can be queried
with ordinary Datalog for audit and composition. Versioned run identities content-bind and expose
the evaluation's `nextTemporalBoundary`, including runs with zero candidates. Triplex does not own
timer delivery: a host scheduler wakes the materializer at that instant and persists the next run.

`Derivation.Overlay.evaluateOverlay` applies temporary assertions and visible-triple retractions
at a pinned basis in a fresh private in-memory KV store. It seeds only the definition's discovered
fixed attributes and delegates to the same structural Datalog evaluator, then translates source
facts back to durable IDs or deterministic hypothetical content commitments. The source Triples
store and transaction journal are never mutated. This supports collect-versus-reuse and proposed
relationship planning with the same candidate identity and explanation shape as committed data.

Assertions whose `validFrom` is omitted begin at the overlay's `validAt`. Retractions must identify
facts visible at that basis, and duplicate or irrelevant patch operations fail explicitly. Dynamic
attribute queries and transaction-binding clauses are rejected because a bounded copy could not
preserve their semantics honestly.

The initial provenance contract supports patterns, predicates, and negation. Recursive rules,
disjunction, aggregation, and pagination are rejected until their exact provenance semantics are
implemented.

## Delivered extensions and next primitives

### Deferred: scoped optimistic concurrency

The global commit position is an ordering and checkpoint token, not an application-wide expected
version. Today, however, allocating that position uses one backend-wide contention point, and graph
constraint enforcement deliberately relies on the same serialization to prevent absence and
uniqueness write skew. This is simple and safe, but it may serialize commands whose business state
is independent.

A future design may separate these responsibilities, following the distinction described in
[Basic principles of record storing](http://systema10.org/posts/basic-principles-of-record-storing.html):

- every successful transaction still receives one global position for replay, temporal snapshots,
  subscriptions, and consumer checkpoints;
- optimistic concurrency claims versions for explicit conflict scopes rather than the complete
  journal;
- a scope may identify an entity or a cross-entity invariant such as a uniqueness key, movable ref,
  compliance scope, or reference target;
- one transaction atomically claims every affected scope, writes its facts, and appends its journal
  envelope, or commits none of them; and
- append-only operations with no lost-update risk may explicitly request no conflict check.

An entity-only `(record, entity, version)` index is not sufficient for Triplex because graph
constraints can couple otherwise distinct entities. A general branded `ConflictScope`, an atomic
scope-head compare-and-advance operation, and indexed transaction-to-scope/entity facts are the
more promising shape. Multi-scope claims must verify successor continuity, not merely rely on a
unique `(scope, version)` pair. Record insertion and scope materialization must never be separate
commits.

This remains deferred. Do not weaken the current global graph-constraint serialization until a
KV/SQLite/PostgreSQL conformance suite proves atomic multi-scope claims, cross-entity invariant
protection, and unchanged global journal ordering. A reusable Effect fold or stream over
`Triples.transactions` can be considered independently; ordinary reads should continue to use
indexed triples, Datalog, and checkpointed projections rather than replaying the complete journal.

### Inboxes and outboxes

Define conventional first-class inbox and outbox records without embedding delivery vendors or
retry policy in core. Command receipts and consumer checkpoints now provide the atomic identities
and durable resume positions beneath them.

### Graph constraints

`TypeExpr` remains local and decidable. Separately content-addressed `GraphConstraint` nodes now
cover cardinality, uniqueness, required relationships, and reference target kinds. The ontology DSL
generates them from usage-local declarations, and `EntityValidation` writes their findings as
first-class violations with stable codes and constraint identities. Read-only evaluation accepts a
bitemporal basis. Opt-in transaction enforcement accepts those same plain versioned rules alongside
the pinned config snapshot. It projects the whole command, evaluates every post-state valid-time
boundary, and rejects new or worsened findings atomically. Commit-position serialization provides
backend-portable absence and uniqueness protection across Triplex writers. Observation mode remains
available for migration and audit, while direct adapter writes, authorization, and general Datalog
invariants remain outside this guarantee.

### Projection ownership

Indexed dependency state and durable consumer checkpoints now let long-running materializers avoid
a full journal replay. Triplex should not turn an added candidate into a Task or a removed candidate
into a cancellation; applications own durable occurrences, assignment, evidence disposition,
conversations, and retry policy.

### Content-addressed blobs

Define a browser-safe `BlobStore` service that streams bytes, computes the shared SHA-256
`ContentId`, verifies reads, and leaves metadata and references in Triples. Durable adapters such
as S3 or R2 stay outside core. Garbage collection follows reachability and retention policy.

### Configuration migrations

Connect release diffs to affected-entity queries, typed transformations, checkpointed batches,
validation observations, and completion facts. Triplex owns provenance and resumability; domain
transformations remain application code.

## Runtime and backend boundary

These guarantees are in the shared `Triples` contract and are exercised by in-memory KV and
SQLite in the default suite. PostgreSQL passes the same conformance and multi-database isolation
tests through an opt-in integration suite, but remains a production candidate until those tests run
in CI. Cloudflare and FoundationDB are experimental and are not covered by every guarantee above.

PostgreSQL additionally exposes three composition boundaries. `PgTriples.layer` and
`layerFromUrl` own a pool and migrate it for standalone use. `layerFromSqlClient` consumes an
ambient host-owned `SqlClient`, creates no pool, and runs no DDL; both host statements and nested
`Triples.transact` therefore resolve Effect SQL's same fiber-local transaction connection.
`layerForDatabase` creates a pool whose every connection is bound at startup to the schema derived
from a validated, server-resolved `DatabaseId`, and provides both that scoped client and `Triples`.
The `*Migrated` variants are explicit provisioning conveniences. Production migration execution
remains host-controlled through the ordered exports in `@triplex-build/triplex-sql`.

Subscriptions remain conservative invalidation hints rather than an automatic live-query runtime.
Entity snapshots, validation observations, and derivation runs remain checkpointed projections;
their freshness/source positions are part of their correctness contract. See
[`current-state.md`](current-state.md) for the complete maturity matrix.

## Boundary

Triplex should not define Threads, routine step DSLs, timers, integration catalogs, tenancy, or HR
permissions. It should provide the atomicity, concurrency, history, constraints, temporal queries,
content identity, and durable derivation mechanics those systems require.
