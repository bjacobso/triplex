# Operational Primitives

Triplex is a durable substrate for applications that need temporal facts, derivations, and audit.
This specification separates database/runtime guarantees that belong in Triplex from workflow and
product concepts that belong in a host application.

Read [Core concepts](/concepts) for the beginner-oriented model and [Host
integration](/host-integration) for application composition. This page is the low-level operational
contract.

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
heads use it. `TripleLive` cannot detect an insertion: a fact asserted between your read and your
write has no ID you could name. For that, use an `EntityState` precondition. The narrower
graph-constraint enforcement path also atomically protects declared required, cardinality,
uniqueness, and reference-target invariants by evaluating them inside the serialized commit
boundary.

`TransactionConflictError.isRetryable` is always true: reload the state used to
decide the command, then retry its complete transaction. PostgreSQL also uses this
type for native serialization and deadlock failures, with `reason` set to
`serialization` or `deadlock` and the original failure retained as `cause`.
`PgTriples.withTransaction` extends that typed boundary over host statements and
the host's outer commit. Other write failures are not reclassified as conflicts,
and Triplex does not choose retry/backoff policy for the host.

### Entity-state preconditions

`{ _tag: "EntityState", entityId, tripleIds }` is the check-then-write guard for one entity. After
the transaction enters the serialized commit boundary, Triplex compares the entity's complete set
of live (not retracted) fact IDs, across all valid time, with `tripleIds`. Any difference (an
assertion, retraction, or replacement by another writer since your read) fails the whole
transaction with `TransactionConflictError`; nothing commits. Unlike `TripleLive`, it needs no
matching `retract` operation, so it also guards an "assert only when nothing changed" write.

Observe the set from `history(entityId)`, which includes every valid time, keeping the facts whose
`retractedAt` is `None`. `entity(entityId)` applies a valid-time basis and would omit future or
expired facts, so its IDs can differ from the set the precondition compares.

```ts
const activate = Effect.gen(function* () {
  const triples = yield* Triples;
  const observed = (yield* triples.history(vendor)).filter((fact) =>
    Option.isNone(fact.retractedAt),
  );
  // Decide from `observed` (and any Datalog check) whether the command is allowed, then:
  yield* triples.transact(operations, {
    actor,
    commandId,
    preconditions: [
      { _tag: "EntityState", entityId: vendor, tripleIds: observed.map((fact) => fact.id) },
    ],
  });
});
```

On conflict, reload and decide again. The precondition guards only the named entity: a check that
reads other entities (such as a vendor's reviews) needs an `EntityState` precondition for each of
them, or graph-constraint enforcement. It is also not a declarative rule: a write that omits it is
not checked, and the passage of valid time can still make a guarded state invalid later.

### Attribute-value and absence preconditions

Use `AttributeValue` to compare one attribute without loading the entity or its history.
It requires **exactly one unretracted fact** for the entity/attribute, with the expected typed
value. JSON object key order is ignored through canonical encoding; scalar value types remain
separate. Two live facts conflict even when their values are equal. `AttributeAbsent` requires
no unretracted fact on one attribute; `EntityAbsent` requires none on the entity. A previously
used but fully retracted entity is absent.

Like `EntityState`, these guards consider every valid time: unretracted future and expired
facts count. They observe the pre-state before any operation in the transaction, within the
existing serialized commit boundary. They require no matching retract. A mismatch fails with
retryable `TransactionConflictError` and rolls back facts, journal, receipt, and position.
Unrelated attributes do not invalidate an attribute guard. Hosts must still guard every entity
or invariant their command depends on.

```ts check
import { Effect } from "effect";
import { EntityId, Triples, number } from "@triplex-build/triplex";

const createHome = Effect.gen(function* () {
  const triples = yield* Triples;
  const home = EntityId.make("home:alice");
  return yield* triples.transact(
    [{ op: "assert", entityId: home, attribute: ":home/version", value: number(1) }],
    { preconditions: [{ _tag: "EntityAbsent", entityId: home }] },
  );
});

const checkVersion = Effect.gen(function* () {
  const triples = yield* Triples;
  const home = EntityId.make("home:alice");
  return yield* triples.transact([], {
    preconditions: [
      { _tag: "AttributeValue", entityId: home, attribute: ":home/version", value: number(1) },
      { _tag: "AttributeAbsent", entityId: home, attribute: ":home/deleted" },
    ],
  });
});
```

The sensitive decorator rewrites plaintext value guards through the attribute's blind-token
policy. A codec without blind equality rejects that plaintext comparison with `WriteError`;
plaintext never enters the storage lookup or journal. Raw stored sealed envelopes can still be
compared exactly; envelopes with blind tokens compare their value type and token.

Lookups fetch at most two live facts for a value guard and one for absence. SQL uses partial
live indexes. PostgreSQL migration **v6** adds a length-framed entity/attribute expression index
and analyzes `triples`: its index-expression statistics describe live rows, avoiding the
historical attribute skew that made the planner scan old facts. Keep automatic analysis enabled
as data changes. SQLite and Cloudflare use their existing `(entity_id, attribute)` live index;
SQLite records migration v6 without extra DDL, and Cloudflare needs no additional migration.

KV retains its historical indexes and adds one live-only ID key per unretracted fact. Assertions,
batch assertions, and retractions update that key within the same transaction. Fresh empty stores
are ready automatically. An existing store keeps all existing APIs working, but the new cheap
guards return `ReadError` until its live index is backfilled. Upgrade **every writer** first;
old writers do not maintain the new index. Run bounded batches against the same backend until
complete:

```ts check
import { Effect } from "effect";
import { KvTriples } from "@triplex-build/triplex";

// Provide the existing database's KvBackend layer when running this effect.
const backfill = Effect.gen(function* () {
  for (;;) {
    const progress = yield* KvTriples.migrateLiveFacts({ batchSize: 500 });
    if (progress.complete) return;
  }
});
```

For FoundationDB, provide `makeFdbKvBackend(config)` with the same cluster and subspace
settings as the existing store.

Each batch atomically persists its cursor and ID keys. It is safe to resume after a crash;
upgraded transactional writers maintain the index while backfill proceeds. Retractions conflict
with overlapping source reads and remove live keys atomically, while new assertions before an
already processed cursor write their own keys. Historical keys remain unchanged. Batch sizes
are 1–1000 (default 500); reduce the size to fit the backend's transaction time/size limits.
Malformed source data aborts the batch. A completed backfill is a no-op on repetition; unknown
index versions are rejected. Mixing old writers or writing raw KV facts outside Triplex's
transaction/index protocol invalidates the guarantee.

Custom storage adapters must implement `livePreconditionFacts` as a bounded indexed lookup,
including all unretracted valid times. Exhaustive precondition switches must handle the three
new variants. Existing `TripleLive` and `EntityState` behavior is unchanged.

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
Datalog for application-specific audit queries. Their valid time starts at the commit instant, so
query them at the current valid time; a past `validAt` hides them (see
[Datalog](/datalog#query-shape)). A command ID is an atomically unique idempotency
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

### Entity-prefix transaction feeds

`transactions({ after, limit, entityIdPrefix })` selects the ordered subsequence
of the global journal touching any entity whose ID starts with the literal prefix.
Matching is case-sensitive; `%`, `_`, and backslashes have no wildcard meaning.
A transaction touching several matching entities appears once, with its complete
metadata and all changes, including changes to other entities. Assertions and
retractions both count. Omit the filter for the existing global feed. An explicit
empty prefix selects transactions with at least one fact change, so empty commands
and entry-only inbox/outbox commands do not match it.

```ts check
import { Effect } from "effect";
import { Triples } from "@triplex-build/triplex";

const followHomes = Effect.gen(function* () {
  const triples = yield* Triples;
  return yield* triples.transactions({
    entityIdPrefix: "home:",
    after: 0,
    limit: 200,
  });
});
```

Resume with the returned `next` as the next `after`; it remains an exclusive global
commit position, with gaps for non-matching commands. Limits keep their existing
1–1000 range and default 100. Empty pages return no `next`. Keep the same prefix
when resuming a consumer checkpoint; changing it intentionally changes the selected
subsequence after that global position. The tenant protocol's `Transactions`
operation accepts the same optional `entityIdPrefix` field.

Discovery uses changed-entity references before hydrating only matching command
records. SQLite/Cloudflare reuse the existing reference index. PostgreSQL SQL
migration **v7** adds a binary-collation covering prefix/position index and analyzes
triples; host-owned clients must migrate before layer acquisition. SQLite records
v7 without extra DDL, and Cloudflare needs no new migration beyond v6. KV uses its
existing AVET changed-entity prefix, pins the committed head for the scan, and
retains a bounded candidate set before reading complete envelopes. No KV feed
backfill is needed. Custom storage adapters implement `transactionIdsForEntityPrefix`.

The filter avoids unrelated transaction metadata. Work can still grow with the
matching prefix's history: KV scans those references and SQL can visit matching
index candidates before sorting/deduplicating. The page limit bounds returned
records, not a promise of history-independent candidate work. No entity-type
membership or type-change semantics are introduced by this prefix filter.

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
and Datalog accept the same `{ recordedAt?, recordedPosition?, validAt? }` basis, so every clause in a join,
negation, or rule sees one coherent cut. Historical corrections append new facts; they do not
rewrite the recorded history.

Supply at most one of `recordedAt` and `recordedPosition`. The latter selects an
exact committed fact cut and survives later assertions and retractions without a
history/transaction lookup loop. Positions must be non-negative safe integers;
zero selects no facts. Specify `validAt` too when replay must preserve the same
business-time instant. Facts returned at an explicit position cut omit later
retraction metadata, reproducing the earlier read. Full `history` and `get` audit
reads retain the stored retraction information.

```ts check
import { Effect } from "effect";
import { EntityId, KvTriples, Triples, string } from "@triplex-build/triplex";

export const replay = Effect.gen(function* () {
  const triples = yield* Triples;
  const entityId = EntityId.make("home:1");
  const original = yield* triples.transact([
    { op: "assert", entityId, attribute: ":home/status", value: string("draft"), validFrom: 0 },
  ]);
  yield* triples.transact([
    { op: "retract", id: original.triples[0]!.id },
    { op: "assert", entityId, attribute: ":home/status", value: string("ready"), validFrom: 0 },
  ]);
  return yield* triples.entity(entityId, { recordedPosition: original.position, validAt: 1 });
}).pipe(Effect.provide(KvTriples.layer));
```

The returned fact still has value `draft`. SQL migration v4 adds
`idx_entity_recorded_position` for selective entity replay; Cloudflare's equivalent
is migration v5. Host-owned SQL migrations must run before acquiring an unmigrated
Postgres layer. KV uses its existing temporal hexastore; no KV migration is needed.

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

`Inbox` and `Outbox` from `@triplex-build/triplex/operational` build operations for the
existing `Triples.transact` boundary. Facts, command receipts, entries, and acknowledgements
commit together. Delivery vendors, scheduling, leasing, and retry policy remain host concerns.

```ts check
import { Effect } from "effect";
import { EntityId, Triples, string } from "@triplex-build/triplex";
import { Outbox } from "@triplex-build/triplex/operational";

const home = EntityId.make("home:alice");
const commitIntent = Effect.gen(function* () {
  const triples = yield* Triples;
  yield* triples.transact(
    [
      { op: "assert", entityId: home, attribute: ":home/status", value: string("ready") },
      Outbox.append({
        scope: home,
        idempotencyKey: "command:123:send",
        payload: { destination: "worker", command: "refresh" },
      }),
    ],
    { commandId: "command:123" },
  );
  const page = yield* Outbox.pending(triples, { scope: home, limit: 25 });
  return page;
});

// Run this only after the host has successfully delivered the stored payload.
const acknowledge = Effect.gen(function* () {
  const triples = yield* Triples;
  yield* triples.transact([Outbox.acknowledge(Outbox.id(home, "command:123:send"))]);
  return yield* Outbox.get(triples, Outbox.id(home, "command:123:send"));
});
```

Identity is `(inbox or outbox, entity scope, idempotency key)`. Keys contain 1–1024 JavaScript
UTF-16 code units. Payloads use the existing canonical JSON encoding: object key order is
irrelevant, negative zero becomes zero, and unsupported or non-finite values fail with
`WriteError`. Appending an existing identity with the same canonical payload leaves its original
record unchanged, including after acknowledgement. A different payload fails with
`OperationalEntryConflictError` (`isRetryable: false`); the entire transaction rolls back.
Ordinary SQL serialization/deadlock conflicts retain their separate retryable error.

Omit `scope` from `pending` to drain a whole database. Inbox and outbox directions are separate.
Pages order entries by original append position, then ASCII content ID; this also disambiguates
several entries appended in one transaction. Pass `nextCursor` into the next `pending` call.
Limits default to 100 and must be integers from 1 to 1000. Cursors bind the database runtime scope,
entry direction, and entity filter. They remain valid if their last entry is acknowledged.
They are live pending cursors, with no pinned snapshot or ownership claim: another worker may
acknowledge an entry between reads. Exhaustion returns no `nextCursor`; start another drain
without a cursor to discover new work or retry unacknowledged deliveries.

Reading pending work does not claim or mutate it. A crash after commit or delivery and before
acknowledgement redelivers the exact canonical stored payload. Consumers must handle at-least-once
delivery; a cursor does not establish successful delivery. `acknowledge` retains the first
acknowledgement's transaction ID, position, and time, removes only the pending index entries,
and is idempotent. A missing or wrong-direction target fails with `WriteError`.
`get` retains both original append metadata and optional acknowledgement metadata as history.
An append followed by acknowledgement in one transaction is allowed and never becomes pending.

Each entry has its own record. SQL uses a primary-key lookup and separate partial pending indexes
for an entity scope and the whole database. KV uses primary records and separate global/scoped
pending ranges. Reads fetch at most `limit + 1` candidates; acknowledged history is absent from
those indexes. No operation materializes a home entity or scans acknowledged entries. Entries
link to their original and acknowledgement receipts; their payloads are not copied into
`:_tx/change`, which continues to describe fact changes. Transaction results still report only
asserted/retracted facts. Entry storage is a separate operational record store, so fact history,
Datalog, temporal cuts, and entity snapshots do not include these entries.

Entry payloads do not pass through attribute-based `Sensitive` policies: they have no attribute.
Hosts must encrypt sensitive payload contents before appending them and control who can read
operational records. The API adds no automatic decryption or transport authorization.

SQL migration **v5** and Cloudflare migration **v6** create the operational table and pending
indexes. Host-owned SQL clients must run `runMigrations` before acquiring the updated layer.
No KV data migration is required. Custom `StorageAdapterService` implementations must add the
four operational storage methods exported through the runtime contract. The `TriplesService`
read contract gains `operationalEntry` and `pendingOperationalEntries`; `TransactOp` gains two
variants and its error union gains `OperationalEntryConflictError`. Update custom service
implementations, exhaustive switches, and explicit transaction error annotations when adopting.

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
tests through a dedicated integration suite that runs in CI and is opt-in locally. PostgreSQL
remains a pre-1.0 production candidate pending operational validation. Cloudflare and FoundationDB
are experimental and are not covered by every guarantee above.

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
