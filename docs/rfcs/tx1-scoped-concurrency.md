# TX1.4: scope claims need an ordered-publication protocol

Status: **conditional design proposal; owner decisions required; no implementation**.
Read [the late-allocation diagnostic](./tx1-late-allocation) and the existing
[scoped-concurrency sketch](../operational-primitives#deferred-scoped-optimistic-concurrency).
The TX1.3 diagnostic is deliberately stronger than merely removing a timed hold:
the second writer updates the counter after the first writer has committed, yet
its older snapshot still fails.

## Recommendation

Approve a concrete, opt-in protocol design before adding `ConflictScope` or scope
head tables. Preserve the current runtime as the compatibility profile while the
new protocol is proved. The design must settle **both** scope authority and global
publication. Sharding business version heads while keeping the same mutable global
counter does not remove the measured allocation conflict.

Do not ship scope claims alone as completion of TX1. It would add public concepts
and maintenance work while leaving the proven shared updater unchanged. Do not
weaken absence/uniqueness enforcement or replace the counter with an uncoordinated
sequence. The strict ordered-position target remains a requirement, not an option
this proposal relaxes.

## What the roadmap already settles

The operational-primitives sketch requires a branded conflict identity, atomic
multi-scope claims, successor continuity, and claims/facts/journal in one transaction.
It correctly distinguishes a business conflict version from a global replay cursor.
An entity-only version is insufficient for cross-entity invariants.

An illustrative claim shape is:

```ts
interface ScopeClaim {
  readonly scope: ConflictScope;
  readonly expectedVersion: number;
}
```

This is a proposal fragment, not an exported API. A successful claim must compare
the current version and advance to exactly its successor inside the same atomic
boundary as every other claim and mutation. A unique `(scope, version)` record
alone is insufficient: it does not compare the complete predecessor state.

## Decision 1: who determines mandatory scopes?

All Triplex writers that can affect a checked invariant must participate. A caller
cannot opt out of backend-derived mandatory claims merely by omitting `enforce`
or naming only its own entity. Direct raw adapter/SQL writes remain outside the
existing Triplex enforcement guarantee, but ordinary `Triples` writes do not gain
a new silent bypass.

| Concern                 | Scope obligations that a concrete protocol must settle                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Entity/attribute state  | Claims for changed entities and guarded attributes; both old and new keys on replacement/retraction                |
| Absent entity/attribute | A claim that exists even when no fact exists, so an insertion races with the absence check                         |
| Required/cardinality    | Subject/type/attribute identity and relevant valid-time boundaries                                                 |
| Uniqueness              | Canonical value identity, type/rule applicability, old/new values, and changes to type membership                  |
| Sealed uniqueness       | Existing blind-token equality domains and codec/key scope; no plaintext scope identities                           |
| Reference targets       | Target existence/type/deletion and incoming references; entity-only locking cannot protect both ends automatically |
| Policy/config changes   | Scope identity and participation across pinned rule versions and activation changes                                |
| Maintenance             | Unjournaled operations must still maintain any affected scopes/indexes atomically                                  |

The present API supplies plain versioned constraint rules per command. It does
not install a database-wide authoritative active-constraint registry. That leaves
a material choice:

- **Database-registered invariant participation** (recommended for investigation):
  all writers derive required keys from a versioned database policy, and policy
  activation/change is itself guarded. This can support narrow value scopes but
  introduces an authority/lifecycle contract not present today.
- **Conservative always-derived scopes:** derive enough entity/type/attribute/value
  keys without such a registry. This avoids trusting caller lists, but common
  attributes/values may become new database-wide hot spots. It needs a proof of
  completeness and contention measurements before being called fine-grained.
- **Caller-only scopes:** insufficient for built-in invariant guarantees; not an
  admissible replacement for existing serialization. Explicit application read
  dependencies may add claims, but cannot remove mandatory ones.

Scope enumeration that reads facts must also validate that its source state did
not change before all claims are acquired. Deterministic acquisition order avoids
one class of deadlocks, but is not a substitute for validating predecessor versions
or claiming a previously absent scope atomically.

## Decision 2: how is the global commit cut published?

Two disjoint sets of scope heads do not change a later upsert of the same global
counter. The TX1.3 diagnostic already models that separation with independent
host version rows followed by one final counter update. At higher isolation the
global updater can still reject an older snapshot.

The owner must choose a concrete publication protocol/profile to investigate:

| Candidate                                             | Possible direction                                                                                                                                                                                          | Proof or contract still missing                                                                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep the current native ambient profile               | Retain final positions in mutation calls and typed full-transaction retries                                                                                                                                 | Safe compatibility baseline, but the allocation-contention target remains unmet                                                                                                  |
| Staged mutations plus a short ordered commit gate     | Mutate independent business scopes in parallel, finalize positions/journal near commit; investigate a non-MVCC reservation source with serialized commit admission and immutable committed-position records | A complete commit-order protocol, crash/savepoint behavior, all-writer participation, and visibility to the host's older snapshot; an ordinary sequence alone is insufficient    |
| Explicit host-coordinated preparation/publication API | Prepare from an observed cut outside the final transaction, then validate scopes and perform a short atomic host/Triplex commit                                                                             | New host composition contract; an already-open arbitrary host snapshot cannot silently be replaced; short serialized mutation work still needs measured throughput               |
| Post-commit ordered publication                       | Investigate an authoritative backend commit record and ordered publication of facts already durably committed                                                                                               | A nested call cannot return its final commit-order position before that order is known; acknowledgement, read visibility, recovery, and adapter parity need a different contract |

**Recommend investigating staged mutations/ordered admission first**, with the
current profile retained. This is an investigation recommendation, not a claim
that the candidate already satisfies the invariants. It must include immutable
committed-position discovery rather than just moving the same MVCC counter row.
Do not assume that PostgreSQL-specific machinery automatically supplies a portable
KV/SQLite/Durable Object implementation.

### The older writer's own view is an explicit gate

External readers are not the only case. A host transaction may have an old snapshot,
write its own facts, and read them again before its outer commit. If a proposed
protocol lets that writer obtain N+1 after another transaction commits N, its own
native snapshot may include its new writes while omitting N.

A publication proposal must specify how `currentPosition`, transaction feeds,
explicit position reads, default Datalog pages, and read-your-writes behave in
that situation. Returning an apparently complete N+1 cut with N missing is forbidden.
It must provide a coherent cut or a deliberate typed failure/profile restriction,
and keep existing behavior in the compatibility profile. This cannot be left as an
implicit exception to the goal's "any snapshot reader" invariant.

Likewise, a nested Triplex call currently returns a position before the host commits.
If a candidate changes when that value becomes final or how long admission is held,
the public receipt and ambient transaction contracts must say so. Ordering an
internal journal separately from host commit order is not an equivalent guarantee.

## Cross-backend proof required before implementation is accepted

Any selected protocol must demonstrate all of the following:

1. Initial scope creation and claims cannot be split from record insertion or
   publication; partial multi-scope success rolls back completely.
2. Predecessor comparison is atomic and successor versions cannot skip or fork.
3. Two absent-value claimants, insertions racing with absence guards, and mixed
   enforcing/non-enforcing Triplex writers cannot evade built-in guarantees.
4. Unique values and reference targets remain correct across types, retractions,
   replacements, policy versions, and relevant valid-time intervals.
5. Old readers, current readers, and older writers reading their own changes never
   receive a purported global cut with a missing committed predecessor.
6. Savepoint rollback, failed outer commit, cancellation, connection loss, and
   process failure leave neither orphan claims nor falsely published positions.
7. Command receipts and host rows/outgoing intents retain their atomic boundary.
8. Shared KV/SQLite/Postgres conformance covers the protocol; Cloudflare's native
   Durable Object transaction behavior is tested. FoundationDB's native coverage
   must be run where the client is available, not inferred from in-memory KV alone.
9. The original 1/4/16-writer matrix is rerun. Report allocation failures, other
   serialization/deadlock causes, waits, latency, and throughput. Moving contention
   to a new lock or renaming the failure does not satisfy the goal.

## Owner decision and present status

The decisions are (1) mandatory invariant-scope authority and (2) the concrete
ordered-publication profile to prototype, including older-writer visibility.
Approve or revise those directions before public scope/staging APIs or migrations
are implemented. Until then TX1.4 is **blocked on design**, TX1.3 remains coupled
to it, and the allocator performance objective remains unmet.

This proposal changes no public API, data format, backend implementation, or
consumer migration. Its before/after behavior is identical. Evidence is the
existing 54-cell benchmark and the new deterministic TX1.3 diagnostic; no scoped
concurrency implementation or new scoped benchmark has been run. The empty
Changeset records a documentation checkpoint without versioning private packages.

Other requested work can use the current safe transaction boundary and proceed
independently, including inbox/outbox, cheap preconditions, filtered feeds, and
the host-sealing RFC.

Validation: `pnpm check` passes, including formatting, lint, TypeScript, the shared
backend suites/workerd, package builds, and the docs build with 37 local llms links.
No runtime changed in this checkpoint, so no new scoped-concurrency benchmark or
adapter migration has been executed. The preceding TX1.3 Postgres diagnostic/full
suite remains the evidence for the unchanged counter protocol.
