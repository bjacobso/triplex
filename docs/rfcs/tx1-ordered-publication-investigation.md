# TX1.3 investigation: staged ordered publication

Status: **experimental evidence and proposed profile; no production allocator
change**. The owner selected staged ordered publication with database-owned
invariant scopes after the independent packages. This follows that direction,
without interpreting it as approval to weaken the snapshot invariant.

## Candidate mechanism and observed result

A synthetic PostgreSQL candidate stages disjoint host-table writes first, then:

1. Acquires one transaction-owned advisory publication gate.
2. Uses a separate client's fresh read-committed statement to find the maximum
   committed position in an immutable publication table.
3. Inserts the successor position into the writer's original transaction.
4. Commits immediately, releasing admission only when that native transaction ends.

No ordinary sequence or shared mutable position row is used. On abort, the
publication row and host writes roll back; the next admitted writer reuses the
successor. The fresh client has a distinct fiber-local transaction service and
pool, so its read does not accidentally inherit the writer's older snapshot.
This auxiliary resource must be reserved independently: allowing every writer to
occupy the same finite pool while waiting for another connection can deadlock.

The experiment uses only synthetic tables; it does not install a Triplex profile,
change its allocator or migrate a consumer. Its public before/after API is identical.

Four native tests establish:

- At repeatable read and serializable, an older disjoint writer can commit position
  2 after another writer commits position 1, without a shared-counter update error.
  **Before its own commit, that older writer sees `[2]`, not `[1,2]`.** Both native
  transactions commit. A second experimental view excludes rows whose stored
  writer xid8 equals the current transaction ID: the older writer sees no final
  positions there, while fresh readers see [1,2] after commit. This tests the
  smallest committed-only read filter, not all fact/journal paths or role isolation. The complete-cut assertion was run first and failed in
  both cases; the retained diagnostic pins the counterexample rather than blessing it.
- An external reader cannot see an uncommitted publication; a repeatable-read
  snapshot pinned before publication remains empty after two commits, and a fresh
  reader sees `[1,2]`. The gate rejects another transaction's try-lock while held.
  Aborting position 1 leaves no row; the next publisher receives 1, then 2.
- Separate batches of 1, 4 and 16 simultaneously prepared writers succeed at each
  of read committed, repeatable read and serializable: 63 native transactions in
  nine cells, no retries, all successful and contiguous external positions. Each
  writer has its own host table; a 32-connection pool permits all 16 to reach the
  preparation barrier. No writer queries or host callbacks run after finalization.

The last item is a **mechanism diagnostic**, not the original throughput benchmark:
there is no Triples journal, sensitive policy, shared fact index, scoped invariant
checking, long command body or production allocator integration. It cannot satisfy
TX1's required rerun or establish production zero-failure throughput. The other
three tests include the reader counterexample that rules out ambient substitution.

Exact command:

```sh
pnpm --filter @triplex-build/triplex-postgres exec vitest run test/integration/staged-publication.test.ts
```

The candidate matches PostgreSQL's documented snapshot behavior: repeatable reads
retain their snapshot while seeing their own writes. Transaction advisory locks
supply admission, not a refreshed snapshot.
[Isolation documentation](https://www.postgresql.org/docs/17/transaction-iso.html),
[locking documentation](https://www.postgresql.org/docs/17/explicit-locking.html).
Serializable does not require serialization order to equal commit order for
concurrent native transactions. Our stronger Triplex position contract must be
implemented explicitly.

## Why the existing ambient API cannot adopt this transparently

A nested `Triples.transact` currently returns a final position while the host's
native transaction stays open. If its snapshot precedes another committed
position, exposing its own successor makes that native snapshot incomplete.
Neither a database-owned business scope nor an advisory gate makes predecessor
rows visible in an old snapshot. An automatic second connection for Triplex reads
would split atomic host state from Triplex state and lose coherent read-your-writes.
Silently changing isolation level or retrying only a nested savepoint is not a fix.

This is a counterexample to this candidate under the unchanged ambient contract,
not a proof that every possible database implementation is impossible. A design
that aborts every such older writer preserves safety but reintroduces the very
allocation-driven retry rate the goal seeks to remove.

## Proposed commit-owned staged profile

Recommend an **opt-in, commit-owned staged transaction API**, retaining today's
ambient profile as the compatibility path. Names below describe semantics, not
proposed exports ready to implement:

- The outer staged runner owns the native transaction and its commit. Reject entry
  from an already active ambient native transaction, rather than accidentally
  treating a nested savepoint as commit ownership.
- Its callback may perform host SQL and stage Triplex commands. It receives a
  pending command identity, never a provisional final commit position. Read APIs
  expose a coherent preparation cut plus explicitly unpositioned local overlays,
  or reject unsupported queries with a typed error. They must not label that
  overlay as a complete global recorded-position cut.
- The callback finishes before finalization. The runner validates mandatory scopes
  and frozen staged plans, acquires publication admission, obtains a fresh committed
  successor, writes final fact/retraction/index/journal/entry positions and commits.
  No user callback or native read runs after finalized positions become visible to
  that writer. Final receipts are returned only after successful native COMMIT.
- Abort/savepoint/cancellation cleanup is atomic. A failed commit yields no final
  receipt. Connection loss has an indeterminate outcome and requires command-ID
  reconciliation, not blind retry. Multiple staged commands need explicitly settled
  one-position-per-command versus one-position-per-outer-commit semantics.
- The invariant applies to published cuts and ordinary snapshot readers. A reader
  cannot obtain N+1 through the supported profile before predecessors are visible.
  **Direct host SQL must also be addressed**: a trigger executing during finalization
  could read the writer's incomplete native publication view. Disallowing callbacks
  alone is not a proof about arbitrary host triggers, deferred constraints or direct
  SQL against finalizing tables. Admission needs restricted database access/trigger
  rules or a committed-only read surface that makes such readers safe. The experimental view suggests excluding the current writer’s final publication
  records, with pending overlays handled separately. Every fact/journal/position
  read must use equivalent filtering, and runtime roles must lack direct private-
  table access (including through host trigger functions). Those permissions and
  complete query-path coverage are not implemented here. This remains a
  design gate, not an implicit exception to “any snapshot reader.”

The recommended next design must specify that last boundary precisely. Exposing
finalizing rows to arbitrary native host triggers is incompatible with the observed
counterexample. A separate post-commit visibility layer can hide staged positions,
but then atomic host visibility, crash recovery and receipt acknowledgement become
new contracts; do not claim it preserves the old ambient semantics automatically.

## Owner choice required before production implementation

| Choice                                                                           | Consequence                                                                                                                                                      |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Design a restricted commit-owned staged profile (recommended next investigation) | Pending receipts inside callbacks, final receipts after commit, explicit limits on native finalization readers/triggers; requires a precise proof and API review |
| Require arbitrary ambient/native snapshot readers to retain the current API      | Keep the proven allocator and typed full-transaction retries; this candidate cannot meet the zero-allocation-conflict target under that contract                 |
| Investigate post-commit publication instead                                      | Different visibility/recovery/acknowledgement contract, no immediate final position from nested calls; must be designed separately                               |

The owner selected the overall direction, but has not yet selected these material
receipt and native-reader restrictions. Record that choice before implementing a
public staging API or schema. Database-owned invariant scopes are investigated
separately; they solve conflict authority, not this snapshot issue.

## Remaining proof and adapter coverage

External-reader prefix proof for this synthetic mechanism: admission is exclusive
until native transaction completion; the fresh head query therefore observes the
previous admitted commit or its rollback before choosing a successor; publication
and business rows commit atomically. A snapshot after successor commit includes
its already committed predecessors; a snapshot before it omits the successor.
The proof assumes all publishers use this gate and no publication records are
removed or altered. It does not cover the older writer's own snapshot, as shown.

No adapter ships this mechanism. PostgreSQL 17.8 supplies the diagnostic evidence.
KV/FoundationDB, shared SQL/SQLite and Cloudflare keep their current allocator;
no cross-adapter public interface has changed. SQLite/DO serialization may supply
a simpler commit-owned implementation; KV/FDB require native conflict/order and
snapshot proofs, including native FDB infrastructure currently unavailable here.

A production proposal still needs staged read/write/index semantics, policy epoch
and scope claims, all graph invariants, old/new writer profile exclusion, commit
failure/savepoint/crash recovery, sensitive journal copies, operational entries,
replay/page/host-read parity and the original 1/4/16 benchmark matrix. The existing
allocation target is **unmet**. No migration or consumer adoption is available.

Validation of this checkpoint: focused diagnostic passes four tests. `pnpm check` passes (39 documentation links), `pnpm pack:check` verifies 11
tarballs and a clean consumer, and `pnpm test:postgres:integration` passes all
38 tests across the existing suite and this four-case diagnostic.
The native integration script now selects the whole integration directory, so
this diagnostic runs in the existing integration gate rather than only manually.
An empty Changeset records this non-publishable experiment and design.
