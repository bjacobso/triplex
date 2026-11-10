# TX1.4 investigation: database-owned invariant scope authority

Status: **synthetic mechanism evidence and proposed design; no public scope API,
registry, migration or allocator change**. The owner selected database-owned
invariant scopes. This follows that direction while the receipt/read-boundary
choice in [ordered publication](./tx1-ordered-publication-investigation) is pending.
Scopes do not repair that candidate's older-writer snapshot hole.

## Native experiments

Seven PostgreSQL tests use synthetic policy, scope-head and host tables:

1. An older repeatable-read writer establishes its snapshot before policy epoch 2
   replaces epoch 1. A plain SELECT still returns the old policy and lets it commit.
   The initial safety assertion failed. Replacing the policy read with `FOR SHARE`
   raises a native serialization failure and rolls its host write back.
2. The same sequence at serializable also fails under plain SELECT, then rejects
   the stale writer with a shared row lock. Serializable alone does not require a
   concurrent transaction to adopt newly committed policy authority.
3. Sixteen serializable transactions simultaneously hold shared locks on epoch 1
   and create distinct scope heads. A separate `FOR UPDATE NOWAIT` activation
   attempt fails while they are active. All 16 claims commit; activation succeeds
   afterward. This avoids a per-command update to one policy row.
4. Initial scope creation advances absence to version 1. An exact predecessor
   update advances 1 to 2; asking for version 7 of an absent scope cannot create
   version 8. After one successful claim followed by a second stale claim, the
   entire transaction rolls back the first claim and its host write.
5. Two writers observing an absent mandatory scope cannot both create its first
   version. At read committed the second receives an explicit predecessor mismatch.
6. At repeatable read it receives a native serialization conflict.
7. At serializable it receives a native serialization conflict. The rejected
   host mutation rolls back in all three cases; the scope remains version 1.

The first two plain-policy reads were tested before changing the helper. Exact
command:

```sh
pnpm --filter @triplex-build/triplex-postgres exec vitest run test/integration/invariant-scopes.test.ts
```

These experiments establish lock/claim mechanisms, **not a complete scope planner**.
The “registered-unique” test identity is deliberately fixed. No test pretends to
derive every required scope from actual Triplex graph rules, or to enforce a full
uniqueness predicate merely by claiming a version. A claim serializes a decision;
the correct invariant must still be checked afterward.

## Proposed authority and lifecycle

The new profile needs an installed database-owned registry of active invariant
rules, a canonical policy identity and activation epoch. A caller may add read-set
claims but cannot remove mandatory scopes, submit an alternate active rule set,
or disable participation by omitting today's optional `enforce` field. This is
an opt-in database profile; the compatibility profile retains existing semantics.
The registry is not a loose cache of whichever caller last supplied rules.

Each eligible writer locks the registry epoch row **for share** before deriving
policy-dependent plans, and holds it through outer commit. Readers of a stable
policy share this lock. Activation locks/updates it exclusively, so it cannot
change authority under active writers. A writer with an older native snapshot is
rejected if that row has changed. A plain snapshot read plus an advisory gate is
insufficient, as the red tests establish. Policy changes can legitimately force
all stale writers to retry; ordinary disjoint commands must not update the epoch.

Registration and activation are privileged host operations, with explicit policy
version/configSnapshot compatibility. Activation must define validation of existing
data, accepted violations and observe/enforce rollout; it cannot silently turn
call-local enforcement into a different database policy. Concurrent old/new runtime
versions must be excluded through schema/profile admission and a coordinated
upgrade. A library flag alone cannot stop an older client ignoring the registry.
Direct adapter/SQL writers are already outside Triplex's invariant guarantees;
new runtime roles and privileged maintenance procedures must make that boundary
explicit rather than advertising arbitrary SQL as participating automatically.

Deleting a scope head or resetting a version is forbidden while historical
expectations can be presented. Scope garbage collection needs durable lifetime/
generation semantics. Scope identities are canonical and domain separated; never
use delimiter concatenation that aliases IDs or expose sensitive plaintext in
scope keys. Sealed equality scopes use the actual token domain/family identity,
not ciphertext or an invented cross-vault equality relation.

## Claim protocol and plan validation

A claim compares an observed predecessor and advances exactly once inside the
same transaction as all other claims, facts, retractions, journal, host writes and
entries. Missing predecessor with expected version greater than zero is conflict,
not permission to invent a new chain. Native serialization/deadlock failures use
the existing retryable TransactionConflictError boundary. Multi-scope success is
all-or-nothing, including failed outer COMMIT and savepoint rollback.

Mandatory planning needs at least these phases:

- Claim always-required entity/dependency scopes for input entities and relevant
  targets before deriving scopes from their state. Validate every source version;
  an old snapshot must not omit a newly added value/type/ref and derive too few keys.
- Derive old and projected new value keys from the authoritative rules and the
  validated entity state, including retractions and type membership changes.
- Acquire all remaining keys in deterministic phase/key order, then check the
  projected invariant. If discovery introduces an earlier-phase dependency,
  restart or validate a complete fixed point; do not acquire ad hoc keys in a
  conflicting order and call it deadlock-free.
- Freeze the plan before ordered publication. Finalization must not discover a
  previously unclaimed invariant. Validate pinned policy identity throughout.

A possible implementation can use transactional head rows with conditional updates
and absence inserts, as tested. It is not yet a public ConflictScope or ScopeClaim
contract. Version granularity for multiple staged commands in one outer commit
must be settled together with pending/final receipt semantics. SQL predicate-lock
false positives can still produce native serialization conflicts even on different
business keys; the synthetic tests do not establish zero production SSI retries.

## Required coverage of actual graph invariants

| Rule/input                              | Mandatory dependencies and decision                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Entity/attribute preconditions, absence | Entity/attribute revision even when no fact exists; all writers touching it participate                               |
| Cardinality and required attributes     | Subject, attribute and type membership; every valid-time boundary in projected state                                  |
| Uniqueness                              | Registered rule applicability, canonical old/new typed values, membership transitions and overlapping valid intervals |
| Sealed uniqueness                       | Blind domain/family/token identity, scrub barriers and token rotation; no plaintext scope keys                        |
| Reference targets                       | Target existence/type/deletion and incoming-reference decisions; both ends cannot be protected by source entity alone |
| Policy activation                       | Exclusive authority epoch, existing-data/violation rollout and pinned config identity                                 |
| Maintenance                             | Erasure, rewrap, compaction, backfill and index changes must preserve affected claims/authority atomically            |

Current full-graph evaluator scans cannot simply be left in place and labeled
fine-grained: their read dependencies and native predicate locks may couple unrelated
writers. A production change must replace or validate those reads using exact
indexed dependencies. The planner must prove soundness for every supported built-in
rule. General caller-defined Datalog invariants do not acquire a false guarantee
from a branded scope type.

## Relationship to ordered positions

Business version heads are not replay positions. They may advance independently
only when the corresponding graph decisions are independent. Global publication
still needs the pending-receipt/committed-reader contract and proof in the separate
investigation. Nothing here replaces the mutable production counter, changes its
commit order or allows a reader to see N+1 without N. The original allocator
benchmark target remains unmet.

Scope correctness invariant: for any two commands whose projected effects can
change the outcome of a checked invariant, their validated mandatory scope sets
must overlap at a predecessor protected by the same database policy. A committed
change to that dependency after the other's observed cut causes mismatch or native
snapshot conflict before the invariant decision is accepted. Scope enumeration,
not the conditional-update syntax, is the missing substantial proof.

## Remaining work and review boundary

No runtime code or consumer API changes in this checkpoint. PostgreSQL 17.8 supplies
seven diagnostic cases; SQL/SQLite/Cloudflare and KV/FoundationDB keep their current
safe transaction boundary. Adapter-independent public scope planning, native
FoundationDB transaction tests, Cloudflare workerd coverage, policy migration and
actual graph/cheap-precondition conformance remain required for a future implementation.

The owner direction settles registry authority over caller-only scopes; it does
not settle the new staged API or constitute proof of the planner. Recommendation:
settle the pending receipt/read profile, then review a concrete registry/planner
contract before introducing public types or migrations. Keep #63/#64 as design
history and link this evidence; do not mark TX1.3/4 implemented.

Validation: focused seven-case diagnostic passes. `pnpm check` passes (40 documentation links);
`pnpm test:postgres:integration` passes all 45 tests across three files. The focused
seven-case suite also passes after strengthening the activation assertion to
SQLSTATE 55P03. `pnpm pack:check` verifies 11 tarballs and a clean consumer.
The default PostgreSQL test command now quotes its exclusion glob (fixed in the
preceding investigation PR), retaining six unit tests and keeping native tests
only in the explicit integration gate. Empty Changeset records this design/test checkpoint,
with no package version, adoption or migration requirement.
