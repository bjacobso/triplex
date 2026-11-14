---
title: Building Triplex on Datomic
description: A proposed Triplex adapter blueprint using Datomic assertion entities, immutable database values, and atomic compare-and-swap submission.
pageClass: backend-blueprint
---

<p class="blueprint-eyebrow">Backend blueprint / Datomic</p>

# Building Triplex on Datomic

<p class="blueprint-lead">A fact-oriented foundation for a TypeScript application that needs to remember which rules governed every decision.</p>

<p class="blueprint-status">Proposed blueprint · No adapter exists</p>

This page proposes an implementation to investigate. There is no Datomic package, running
integration, or compatibility claim. The mappings below are design choices to validate against
Triplex's public adapter contract.

<nav class="blueprint-actions" aria-label="Datomic blueprint actions">
<a href="#storage-mapping">Explore the mapping →</a>
<a href="#build-the-first-slice">Build the first slice →</a>
<a href="/backends">All blueprints →</a>
</nav>

## Why Datomic

Datomic offers datoms, Datalog, transaction entities, immutable database values, historical views,
and ordered log access. Those primitives are useful ingredients for a Triplex adapter.
[Datomic's best practices](https://docs.datomic.com/reference/best.html) describe their use for
consistent reads and audit queries.

On top of an adapter, Triplex would supply its TypeScript domain model, immutable configuration
releases, pinned command provenance, and derivation reconciliation. Datomic would own persistence
and native query execution. A TypeScript-to-JVM client boundary would be part of the deployment;
choose and document that bridge before promising an embedded integration.

## Storage mapping

The proposed starting point is **one Datomic entity per Triplex assertion**, with a fixed adapter
schema. A direct mapping from a domain triple to one native datom cannot by itself preserve
independent `TripleId`s and valid-time intervals for repeated assertions of the same value.

| Triplex contract             | Proposed representation                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| Stable entity and triple IDs | Original strings stored as adapter identity attributes; native entity IDs stay internal              |
| Fact value                   | Assertion entity with domain entity ID, attribute keyword, entity type, value tag, and typed payload |
| Assertion history            | Immutable assertion identity and payload; explicit assertion transaction and recorded position       |
| Retraction                   | Retraction metadata on the assertion entity, retaining the original payload and valid interval       |
| Valid time                   | Explicit `validFrom` / `validTo` fields filtered on every relevant read                              |
| Command receipt              | A scoped command identity claimed atomically without overwriting an earlier receipt                  |
| Commit order                 | A per-logical-database position counter advanced in the same transaction as facts and journal        |
| Causal journal               | Triplex transaction envelopes and typed changes stored atomically with the command                   |
| Query execution              | Translate validated Triplex Datalog to joins over assertion entities and shared temporal filters     |

Keep Triplex's recorded timestamp and commit position explicit. Datomic's native transaction
coordinate can help identify an exact database value, but it is not a drop-in implementation of
`nextCommitPosition()`, which Triplex calls before inserting the transaction's rows.

## Bridge the transaction models

Triplex's `StorageAdapter.withTransaction` accepts an Effect callback whose reads and writes must
share an atomic view, including pending changes. Datomic accepts declarative transaction data;
its transaction functions inspect `db-before` and return additional data, without seeing one
another's output. An arbitrary TypeScript callback cannot simply become a native transaction
function. [Datomic transaction functions](https://docs.datomic.com/transactions/transaction-functions.html)
define that boundary.

One candidate design is an optimistic staging adapter:

1. Acquire one immutable database value, read the logical database's position and existing receipt,
   and run the callback against that value plus an in-memory overlay of pending mutations.
2. Stage constraint checks, a new receipt, assertion/retraction metadata, the next position, and
   the complete journal. Reads during the callback must see the overlay consistently.
3. Submit the staged changes with a compare-and-swap from the observed position to the next one.
   Every writer of that logical database's source data must participate in this guard.
4. On a conflict, discard the staged result, acquire a fresh database value, and re-evaluate.
   For a duplicate, `appendTransaction` must return the original transaction ID so core raises
   `CommandAlreadyCommittedError`; callers can load its receipt with `transactionByCommand`.
   Publish a successful callback result only after confirmed commit.

This is a proposal, not an implemented algorithm. Test retries, typed failures, defects,
interruption, and uncertain submission outcomes before calling it conformant. Constraint queries
must read the same protected basis; direct writes that bypass the guard would invalidate the
design. A native transaction function could instead perform compatible checks, but translating
Triplex's enforcement logic would be additional work.

## Preserve both clocks and the query contract

For Maria's correction, stage a retraction of the March 1 assertion and a new March 5 assertion,
with distinct triple IDs, in the same command. Retain the old payload. The earlier recorded basis
must still expose the original training interval, while current knowledge exposes the gap on
March 3. Datomic's historical view alone does not implement the explicit valid-time filtering in
this proposed assertion schema.

Start with patterns, joins, and temporal filters, then implement the complete validated Triplex
query surface. Verify typed scalar comparisons, negation, aggregates, the constrained recursive
form, deterministic ordering, pagination, and `explain`. Identical-looking Datalog clauses do not
prove equivalent execution.

Pinned pages need the original query, temporal basis, database scope, and exact commit boundary.
Use retained assertion/retraction positions or a verified mapping to native database values;
later corrections must not change which rows an earlier cursor sees. Keep the Triplex journal's
typed changes and provenance even if native log access is used to locate commits.

## Build the first slice

1. Specify the JVM bridge, assertion schema, typed codecs, and physical database isolation.
2. Prototype the staged transaction boundary first: one correction, two competing writers, one
   duplicate command, and one rejected constraint. Establish that failures leave no partial state.
3. Implement `StorageAdapter` and `QueryExecutor`, then compose them with `Runtime.define` and
   `Capabilities.none`. See the [checked runtime skeleton](/custom-runtimes#runtime-definitions).
4. Run [runtime conformance](/custom-runtimes#correctness-contract-and-conformance) on a fresh
   database. Extend it with bridge disconnects, lost commit acknowledgements, process restarts,
   and schema upgrades.

Configuration and derivation services can then use the same `Triples` layer. Durable entity
snapshots and change emitters are separate capabilities to implement and verify.

[Open a Datomic design issue](https://github.com/bjacobso/triplex/issues/new) with a transaction
prototype and its test results, or compare the [working SQLite reference](/sqlite) and
[XTDB proposal](/xtdb).
