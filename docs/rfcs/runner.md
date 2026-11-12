# RFC: durable derivation runner

Status: proposed for P4.2; owner approval is required before implementation. This
RFC changes no package source or existing exports. All runner names and code
below are proposed API fragments, not runnable examples of a shipped package.

## 1. Recommendation, API and compliance host

Add `@triplex-build/triplex-runner` beside HTTP and CLI. It follows the global
ordered journal, materializes affected definitions, delivers pure candidate diffs
to Effect handlers, and schedules dependency boundaries. It owns catch-up and
wakeups; the host still decides what a task means. It must never infer that a
removed candidate means cancellation rather than satisfaction.

Use one scoped runner per database generation, with several named registrations.
Choose one diff handler per registration rather than three callback variants:
host code can keep additions, removals and revisions in one application module.
There is no Promise interface.

```ts
import * as Runner from "@triplex-build/triplex-runner";

type Delivery = {
  readonly version: 1;
  readonly batchId: string;
  readonly registration: string;
  readonly definitionId: string;
  readonly configSnapshot: string;
  readonly previousRunId: string | null;
  readonly runId: string;
  readonly position: number; // exact evaluation cut, not the materialization write
  readonly sourcePosition: number; // latest dependency-relevant write
  readonly basis: { readonly recordedPosition: number; readonly validAt: number };
  readonly reason: "initial" | "commit" | "time" | "definition";
  readonly diff: Derivation.Reconciliation;
  readonly attempt: number; // diagnostic only; excluded from identity
  readonly commandId: (kind: "added" | "removed" | "changed", candidateId: string) => string;
};
type Registration<E, R> = {
  readonly key: string; // durable identity; unique inside this runner
  readonly definition: Derivation.Definition;
  readonly onDiff: (delivery: Delivery) => Effect.Effect<void, E, R>;
};
type Handle<E> = {
  readonly await: Effect.Effect<never, RunnerError | E>;
  readonly stop: Effect.Effect<void>;
  readonly status: Effect.Effect<RunnerStatus>;
  readonly retryPaused: (registration: string) => Effect.Effect<void, RunnerError>;
};
// start<E, R>(registrations: readonly Registration<E, R>[], options: Options)
//   : Effect<Handle<E>, RunnerError, Triples | Scope | R>
```

`start` validates and recovers durable state before returning; its scoped fibers
continue processing afterward. Required options are a server-resolved
`DatabaseScope` and stable runner `id`. Retry options default to eight attempts
per delivery cycle, exponential delays from one second to one minute, with
injected randomness for jitter. `stop` stops admission, interrupts and joins
in-flight fibers, and releases timers. Scope closure does the same. Interrupted
work remains pending; stopping never acknowledges a handler. `handle.await`
supervises fatal read, state-corruption and scheduler failures. Exhausted handler
retries pause a registration and appear in `status`, rather than killing the
other registrations. Defects fail supervision; interruption is not a poison
candidate. No background failure is silently swallowed.

`status` reports scanned and delivered positions, acknowledged run per
registration, pending batch/attempt/error, next deadline, lag, evaluation time
and timer lateness. `retryPaused` durably starts another retry cycle for the same
batch; it does not invent a new delivery identity. Acquisition rejects duplicate
keys, unsupported derivations, a changed database generation, missing deployed
definitions needed for recovery, and malformed persisted records with typed
`RunnerError` diagnostics. Handlers' typed failures remain inspectable in status.

The [compliance host](https://github.com/bjacobso/triplex/tree/main/examples/compliance-host)
keeps its release publication, definition and requirement-occurrence functions.
Replace `scheduled`, `materializeAt`, `consumeTransactions`, `runDueWakeups` and
all `ConsumerCheckpoint` calls with this composition:

```ts
import { Effect } from "effect";
import * as Database from "@triplex-build/triplex/database";
import * as Runner from "@triplex-build/triplex-runner";

// Fragment inside the host's scoped Effect, after deployment and definition creation.
const serve = Effect.gen(function* () {
  const db = yield* Database.Database;
  const handle = yield* Runner.start(
    [
      {
        key: "site-safety",
        definition, // task.site-safety-training, pinned to the deployed release
        onDiff: (delivery) =>
          Effect.gen(function* () {
            const meta = (kind, candidate) => ({
              actor: "demo/requirement-reconciler",
              commandId: delivery.commandId(kind, candidate.id),
              correlationId: delivery.batchId,
            });
            for (const candidate of delivery.diff.added) {
              yield* db.command(meta("added", candidate), (tx) =>
                openRequirement(tx, candidate, delivery),
              );
            }
            for (const candidate of delivery.diff.removed) {
              yield* db.command(meta("removed", candidate), (tx) =>
                satisfyRequirement(tx, candidate, delivery),
              );
            }
            for (const { before, after } of delivery.diff.changed) {
              yield* db.command(meta("changed", after), (tx) =>
                reviseRequirement(tx, before, after, delivery),
              );
            }
          }),
      },
    ],
    { scope: worldScope, id: "compliance", retry: { maxAttempts: 8 } },
  );
  yield* handle.await;
}).pipe(Effect.scoped);
```

These three host helpers are domain command builders, not runner exports. They
retain the example's logic: load prior occurrences, allocate the next occurrence
only when none is open, satisfy the latest open occurrence, and replace an open
occurrence's revision. Their reads use guarded `tx.get`/`tx.fact` and their writes
use `tx.create`/temporal verbs. They record candidate ID, revision, definition,
config snapshot, run ID, source position and `delivery.basis.validAt` in the
requirement model. The full occurrence schema must be published and supplied to
the Database layer; the existing status-only demo schema is insufficient for
these typed helpers. Source commands and read-only overlay preview remain host
code. Integration delivery uses outgoing intents, not network calls in command
builders. A later implementation must provide a checked, complete rewrite of the
example and retain its self-verifying open → satisfied → reopened scenario.

With training valid on `[120, 200)`, the source commit at valid instant 150
removes the candidate and satisfies occurrence 1. The empty materialization still
schedules 200. At 200, without a source write, an added candidate opens occurrence 2. Advancing Effect TestClock replaces manual host calls to `runDueWakeups` in
the demo test. Its application module contains handlers and no scheduler or
checkpoint code: this is the Phase 4 gate.

## 2. Delivery semantics and failure protocol

Delivery is **at least once**, ordered per registration, with no automatic
coalescing. Every relevant recorded commit produces an evaluation at an exact
cut; only a nonempty diff invokes the handler. Unchanged candidates need no
callback. A handler receives full added/removed candidates and changed
`{ before, after }` pairs, preserving each candidate's stable logical ID,
revision, result, provenance, definition/config identity and original basis.
Removed candidates retain their old explanation; the delivery envelope supplies
the new cut at which absence was observed. Absence is not positive evidence.

Hash version, database generation, runner ID, registration key, predecessor
delivery head, definition ID and target basis into `batchId` with public
canonical content hashing. Include the predecessor even when a later transition
returns to an earlier revision. `commandId(kind, candidateId)` hashes batch ID,
kind and candidate ID into a bounded string. A candidate ID or revision alone is
not an occurrence/idempotency key: expiry may legitimately reopen the same
candidate. Attempts, errors and wall-clock retry time never enter either ID.

The durable protocol for one registration is:

1. Read its acknowledged delivery head, not the latest materialization. Persist
   a **prepared batch** containing the predecessor, exact target basis, definition
   and reason before evaluation. Use `EntityAbsent` for initialization and
   `EntityState` plus retract-and-replace for later control transitions. Every
   control write has an idempotent command ID. Once prepared, a crash cannot
   change the evaluation instant or predecessor.
2. Call public `Materialization.materialize` at that basis. Compute
   `Derivation.reconcile(acknowledgedCandidates, run.candidates)` explicitly.
   Ignore `run.reconciliation` for delivery: it compares materialization history,
   which may include an unhandled run or another caller's speculative run.
3. Atomically append one Outbox entry containing the immutable batch payload and
   move control to **ready** using `Triples.transact`. The payload binds both
   candidate sets, run ID, next boundary and all delivery metadata except the
   runtime `commandId` function/attempt counter. The append key is `batchId`.
   A payload conflict is corruption, not permission to overwrite it.
4. Persist the attempt count before invoking `onDiff`, then call it. On success,
   atomically acknowledge the entry and replace the registration's delivery head
   with the new run, candidates, basis, temporal frontier and deadline. An empty
   diff follows the same head transition without invoking application code.
5. Only after every registration affected by a journal cut has completed may the
   runner advance its shared `ConsumerCheckpoint` through that cut. Checkpoint
   advancement is a separate idempotent operation, not falsely claimed atomic
   with the handler or outbox acknowledgement. Persist the completed-cut marker
   first; recover a lagging checkpoint from it before admitting later work.

If evaluation succeeds but the process dies before step 3, the prepared batch
re-evaluates the same retained basis. If a handler partly succeeds, fails or dies,
the entire batch is redelivered with identical diff and IDs. If success occurs
but acknowledgement does not, it is redelivered too. If acknowledgement commits
but its response is lost, recovery reads the advanced delivery head and does not
call that batch again. If a checkpoint call has an uncertain outcome, reread it;
never rewind it or derive success from an in-memory cursor.

The host makes effects idempotent. `Database.command` returns a prior receipt for
the same command ID; for external effects, append an application outbox intent
inside that command and have a separate idempotent transport deliver it. Runner
acknowledgement and arbitrary host effects cannot share a portable transaction.
An inbox can record an incoming integration's deduplication key, but is not a
runner lease. External exactly-once execution is not promised.

On typed handler failure, persist the failure summary and next retry instant,
then retry the same batch with bounded backoff. Exhaustion marks it **paused**
and leaves the Outbox entry pending: no skip, acknowledgement or checkpoint
advance. A poison candidate pauses its whole batch/registration, including later
diffs for that registration. Other registrations may continue with their own
durable coverage markers; the shared checkpoint stays at the minimum completed
cut. Restart must honor paused state and persisted attempts/retry deadlines.
`retryPaused` after a host fix resumes the same batch. V1 has no discard API;
administrative abandonment requires a separately reviewed future contract.

## 3. Durable state and public capability audit

Use existing storage operations, with no new backend primitives or migrations.
Runner-owned control records use ordinary, versioned `runner/*` entity types,
`runner:` entity IDs and `:runner/*` attributes, never reserved `_triplex/` or
`:triplex/*` writes. The package supplies their schema nodes for the host to
publish and recognizes its own maintenance attributes during invalidation.
Control data is internal application infrastructure, not user task state.

| State                                    | Durable representation                                                                                                                                   | Recovery rule                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Global delivered journal position        | Existing `ConsumerCheckpoint`, name derived from generation and runner ID                                                                                | Resume the unfiltered feed exclusively after it; repair from completed-cut marker if needed.                              |
| Registration coverage and delivered base | Guarded ordinary control entity containing schema version, definition/config, acknowledged run, complete candidate snapshot, basis and coverage position | This is the authoritative reconciliation base even if `Materialization.current` reports a newer run.                      |
| Prepared/ready/paused batch              | Control entity plus existing Outbox entry scoped to this runner                                                                                          | Recreate a ready payload only from its pinned prepared basis, or redeliver the stored ready payload unchanged.            |
| Last materialization                     | Existing immutable materialization runs/candidate facts                                                                                                  | Audit and provenance; never imply handler success.                                                                        |
| Next temporal wakeup                     | `nextTemporalBoundary` in immutable run and acknowledged control head, including empty runs                                                              | Reconstruct the minimum deadline queue on startup; a prepared batch is finished before installing its successor schedule. |
| Retry attempts, failure and wakeup       | Guarded control state with `retryAt`, attempt count and paused marker                                                                                    | Respect on restart; diagnostics exclude sensitive result bodies.                                                          |
| Host occurrences and outgoing effects    | Host facts, receipts and application inbox/outbox entries                                                                                                | Host lifecycle and retention policy.                                                                                      |

Use explicit `validFrom: 0` for control facts and guarded `liveFacts` reads, so
clock rollback cannot hide the control record. Version and schema-decode records
and canonical payloads; validate their content hashes and generation before use.
Reject an ahead checkpoint, inconsistent predecessor, missing pending batch or
missing required history. Do not silently rebuild from latest state. Plain
in-memory KV survives runner restarts only while its backend survives: a process
crash guarantee needs persistent KV storage or SQLite/PostgreSQL.

Large candidate sets are an explicit limit, not truncation: proposed default
10,000 candidates per evaluation, configurable within a host memory budget.
Persisting full delivery snapshots duplicates candidate storage but avoids a new
core run decoder contract. Exceeding the configured candidate/payload budget
pauses before delivery and leaves the prepared basis intact. Chunking, retention
compaction and dead-letter queues wait for measured WorldVM requirements.

The runner can already use these public exports:

- Core: `Triples` journal/head, exact position-basis reads, `liveFacts`, ordinary
  guarded `transact`, command receipts and indexed `dependencyState`.
- `/derivation`: definition/evaluation, materialization and pure reconciliation.
- `/operational`: `ConsumerCheckpoint`, `Outbox.append/get/pending/acknowledge`
  and corresponding Inbox operations for hosts.
- `/content`, `/runtime`, `/subscriptions`: canonical hashing, `DatabaseScope`
  and conservative dependency extraction. `/database` is available to handlers.

No new public store read/write is required for the proposed protocol. In
particular, checkpoint advancement cannot currently join an arbitrary caller
transaction; the completed-cut repair protocol deliberately works without that
extension. There is no public content-verified `Materialization.getRun(id)`:
`runsQuery` is an audit query, not a complete run loader, and can omit empty-run
membership. Storing complete acknowledged/pending snapshots avoids requiring
one. Such a read would be an optional later storage optimization.

The live-query coordinator is currently private inside `LiveQuery.layer`; its
feed cache and deadline registrations are not public services. V1 can reuse the
public dependency planner and scheduling algorithm but cannot import that private
implementation. If sharing one physical coordinator with `watch` is required,
the missing export is a browser-safe scoped coordinator supporting independent
journal cursors, deadline registration/cancellation and wakeup hints. That is a
separate core change requiring conformance tests, not an assumed existing API or
a new durable store primitive. Do not export a UI snapshot stream as that seam.

## 4. Time, ordering and restart

Use a single minimum-deadline queue per database for every registration's
temporal and retry deadlines. One Effect Clock sleep waits for its earliest
deadline; earlier commits or registrations cancel/re-arm that sleep. Derivation
evaluation and dependency reads use exactly the same `(recordedPosition,
validAt)`. `nextTemporalBoundary` considers future `validFrom` and `validTo`
across dependency attributes, including negation and empty results. Never infer
the schedule from positive candidate expiry alone. Half-open intervals become
effective at their start and cease at their end.

Choose durable transition replay, including elapsed boundaries during downtime,
rather than the observation stream's collapse-to-now policy. Define the replay
timeline precisely:

1. Initial registration captures head H and wall time T, persists that bootstrap
   basis and evaluates from an empty acknowledged set. It emits current work,
   not every transition before registration. A restart resumes that persisted
   bootstrap; it never chooses a new H/T for an unfinished initial batch.
2. Subsequently scan every journal envelope in position order, bounded by a
   captured head. Let F be the last durably processed valid-time frontier. For
   the next commit at position P, set C to `max(F, commit.instant)`. At the prior
   recorded cut, evaluate every scheduled boundary strictly before C, in order.
   Then evaluate definitions affected by the commit **or due at C** at `(P, C)`.
   A commit exactly at an expiry wins the tie: apply the commit and evaluate once at C, avoiding a transient
   expiry/reopen when replacement evidence arrives at that same instant.
3. After draining the captured journal head, process remaining boundaries through
   `max(F, Clock.now)`, at that head, evaluating each boundary at its exact instant.
   A late wakeup or restart therefore does not erase an intermediate candidate
   that both appears and disappears while the process is offline. Recompute the
   next boundary after each evaluation until caught up, with bounded work turns
   for fairness. Preserve the target/head in prepared state when interrupted.
4. A clock rollback never rewinds the durable frontier or repeats completed time
   transitions. Clamp to F and report clock skew; future deadlines wait until wall
   time catches up. Commit order is always position order, including equal or
   decreasing commit timestamps. This deliberately differs from a live UI's
   current-wall-time observation after rollback.

Even an otherwise irrelevant envelope can advance the replay clock and make a
deadline due. Relevant corrections recompute the schedule at their cut. Historical
corrections are new recorded transitions, not instructions to undo delivered
external effects or retroactively create every business state before registration.
Application compensation remains a handler decision. Recorded history and
definitions must be retained through the oldest pending replay basis; if future
retention removes it, stop with a typed history-unavailable error.

Use the global feed: entity-prefix filtering can miss training facts on a worker
that suppress a placement candidate. Gaps, including unjournaled checkpoint
positions, conservatively invalidate definitions at the gap end. Unknown change
formats invalidate all. Ignore known runner control/materialization maintenance
only after proving it touches none of a definition's dependencies. V1 rejects
definitions depending on runner control, checkpoints, materialization metadata
or transaction-journal attributes, preventing self-triggered delivery loops.
Ordinary handler writes are never blanket-ignored by actor: if they affect source
dependencies they legitimately trigger another run; hosts must avoid oscillation.

Scanned coverage is not a second stream of maintenance writes. Persist/advance
coverage only when crossing source journal work or completing a real time or
definition transition; keep irrelevant runner-only tail positions in memory until
the next such transition. In particular, do not write a control update merely to
record scanning the preceding control update. Capture a finite head per drain
and recheck afterward so concurrent commits cannot be missed before sleep.

No recurring query or dependency scan discovers expiry: known boundaries drive
timers. A shared bounded journal/head check (default one second) remains necessary
for other-process commits or lost emitter hints. Its clock sample can also detect
rollback and re-arm the timer. This liveness check is not expiry polling. The
public API has no reliable cross-process blocking journal subscription today;
promising zero periodic head reads would require another capability. Process
suspension and overload can delay delivery; durable catch-up preserves ordering,
not a real-time deadline guarantee.

## 5. Live queries, client and definition deployment

[Live queries](../live-queries.md) and the
[live-query RFC](live-queries.md#6-core-and-runner-boundary-missing-public-reads)
provide the same foundations: exact position cuts, unfiltered feed coverage,
conservative dependencies, indexed boundary discovery, bounded feed caching and
one scheduler. Reuse public dependency extraction and its sound attribute-wide
invalidation; share backend handles, not sibling source imports. V1 may own a
second feed reader/timer alongside `watch` until the public coordinator seam is
approved. One runner still shares those resources among all its definitions.

Do not implement durable delivery by calling `watch`, even with coalescing off.
It returns observations without candidate identity/provenance, can collapse
offline time boundaries, has subscriber demand semantics and never acknowledges
application work. The runner durably pins predecessors and pending deliveries,
replays boundaries, retries handlers and advances checkpoints. Core remains
browser-safe and never depends on runner. No MCP subscriptions are added here.

Handlers normally use the [Database client](../database.md) for guarded,
schema-bound commands and outgoing intents. The runner itself uses public
`Triples` for infrastructure records; it never calls the private reserved-system
write capability. Hosts publish the runner schema before acquisition and ensure
their runtime validators authorize attributed maintenance commands. Runner
attribution is not an authorization bypass. `Database.command` pins its own
admission-time release, which may differ from the derivation's evaluation pin;
retain both in the audit record. Drain before an incompatible release promotion
rather than pretending that delivery metadata forces the client to use an old
schema. Sensitive candidate payloads receive
no automatic attribute-based encryption in operational entries; hosts must secure
the store and explicitly protect sensitive application payloads.

A registration key survives a definition revision. On redeployment, finish any
old pending batch using its stored payload before preparing a definition-change
batch at the current captured cut. Compare the acknowledged candidates with the
new definition, preserving stable candidate identities by name/key. The old
handler implementation must remain replay-compatible, or deployment must drain
and stop before replacing it; changing code does not invalidate idempotency keys.
Reject a changed definition name under the same key. Removing a registration
with unfinished work fails acquisition; v1 requires a drain before removal and
does not manufacture removals for undeclared definitions. A distinct key starts a
new subscription with bootstrap semantics, not a migration of occurrence state.

## 6. Concurrency, backends and WorldVM

V1 requires a **single active runner process per database generation**. The host
supervisor assigns ownership and must stop/fence the previous owner before
failover. No automatic cross-process leases or active-active handlers are
promised. In-process acquisition rejects a second runner for the same scope;
this registry is not a distributed lock. Control CAS/checkpoint conflicts detect
stale progress but cannot prevent two processes from calling external handlers
before either acknowledges. Idempotency is still required under accidental
overlap. A future lease needs fencing tokens honored by every side effect;
expiration alone is insufficient and is deferred.

Serialize each registration's batches and callbacks. Bound evaluation concurrency
across independent registrations (proposed default four); never process a later
batch for the same registration before its predecessor completes. The global
checkpoint is the minimum durable coverage across registrations. Ready snapshots
and per-registration coverage permit others to progress while one is paused;
recovering from the minimum skips their already completed cuts. Keep only bounded
journal pages in memory, rereading retained history for laggards. Configure a
maximum pending payload budget; backpressure a registration rather than drop or
coalesce work. Report retained-history lag and poison blockage to the host.

| Backend    | Composition and limits                                                                                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KV         | Public `Triples` and operational APIs only. In-memory KV is suitable for deterministic corpus tests; persistent restart claims require a durable KvBackend. Bounded Effect concurrency does not parallelize synchronous CPU work. |
| SQLite     | One runner using the database's existing Triples handle; source writers may be other processes. Keep reads short and position-pinned, and never hold a SQL transaction across a callback or sleep.                                |
| PostgreSQL | Same public protocol and database scope, with a host-owned pool/runtime. Other processes may write sources; only the designated owner runs handlers. NOTIFY can accelerate a head check but cannot replace the journal.           |

WorldVM's reference deployment is one database per world and 16 runners for 16
worlds, rather than 16 workers competing over one database. Each world has its own
generation, checkpoint, registration state and deadline queue. A shared process
may host several world scopes, subject to host-wide pool/CPU budgets. Start with
these boundaries and measure contention, replay lag, candidate sizes and timer
lateness before adding leases or sharding one world's runner. KV and SQLite are
supported targets; PostgreSQL remains a pre-1.0 production candidate. Cloudflare
and FoundationDB remain frozen and experimental; existing compilation/tests must
continue to pass, but this RFC adds no certification for them.

## 7. Package and implementation gate

The package is `@triplex-build/triplex-runner`, directory `packages/runner`.
Runtime dependencies are public exports of `@triplex-build/triplex` and Effect
only, with versions in the root catalog and Effect's peer range matching core.
No dependency on HTTP, CLI, host, SQL or backend internals is needed. It can stay
browser-safe itself: use Effect Scope, Clock, fibers and scheduling, with no
Node-only imports. Node process signals and shutdown orchestration belong to the
embedding host; a future Node adapter would be an explicit separate subpath.

Implementation must add package exports/build wiring, the runner schema and
acquisition checks, durable protocol/recovery tests, a complete compliance-host
rewrite, checked documentation and a Changeset. None is shipped by this design
item. An implementation that needs another public core capability must specify
and test it rather than import internals or weaken delivery semantics.

## 8. Conformance corpus and owner questions

Add a reusable runner corpus parameterized by a public `Layer<Triples>`, persistent
store fixture and injected Effect Clock. Run it on KV and SQLite in the default
suite; the orchestrator runs the same corpus on PostgreSQL with deterministic
clock wiring. KV tests restart the runner over the same backend, while SQLite
also closes/reopens the store. Add separate process-crash tests for any claimed
durable KV adapter. Tests must observe committed effects and checkpoints, not
only internal scheduler counters.

Required cases for implementation:

1. Bootstrap empty/nonempty relations, added/removed/changed/unchanged diffs,
   merged provenance, exact recorded basis and stable candidate/revision/event
   identities. Distinguish two commits in the same millisecond.
2. Crash at every protocol boundary: prepared, materialized but unqueued, ready,
   mid-handler, after handler success before acknowledgement, after atomic head
   update before checkpoint, and after a successful checkpoint with lost response.
   Verify identical redelivery payload/command IDs and no lost diff.
3. Partial batch success using `Database.command`: retry returns earlier command
   receipts, completes remaining work and opens no duplicate occurrence. Test
   application outbox intent deduplication and payload-conflict failure.
4. A newer unhandled or manually materialized run cannot erase pending removals
   or become the delivered base. Include an empty run with a future boundary.
5. Poison failure persists attempts/backoff, pauses without advancing coverage,
   survives restart, leaves other registrations progressing, and resumes the same
   batch after `retryPaused`. Shutdown interrupts without acknowledgement.
6. Training `[120, 200)` produces open → satisfied → reopened, including expiry
   without a commit, future `validFrom`, negation suppressing every candidate,
   earlier corrected deadlines and retracted schedules.
7. Restart past several boundaries reproduces every post-bootstrap transition.
   Commit-at-boundary tie, late wakeup, equal/decreasing commit timestamps and
   clock rollback obey the specified frontier without duplicate occurrences or
   tight timer loops. Multiple definitions share/re-arm the minimum timer.
8. Lost emitter hints and other-process commits are recovered by head checks;
   paged global feed coverage, checkpoint gaps, concurrent commits during drain
   and worker facts outside projected entity prefixes cannot lose changes.
   Maintenance-only idle tails terminate without recursively writing checkpoints.
9. Definition deployment, changed config pin, pending old batch, registration
   removal, corrupt payloads, missing history, wrong generation and ahead cursors
   fail or recover exactly as specified. Validate schema/validator rejection of
   infrastructure writes without acknowledging work.
10. Second local runner rejection, simulated overlapping processes/CAS conflict,
    per-registration ordering, fair evaluation, payload limits/backpressure and
    16 isolated world scopes prove the ownership limits. No test may claim that
    CAS alone provides distributed exactly-once delivery.

Owner approval should settle these proposed policies before implementation:

- Approve durable offline boundary replay with commit-first ties and a monotonic
  valid-time frontier after clock rollback. This can create and satisfy overdue
  work immediately during catch-up; live-query observations intentionally differ.
- Approve single active process per world with host-supervised failover, and no
  distributed leases or poison-discard API in v1.
- Approve ordinary published runner control schema plus full acknowledged and
  pending snapshots, rather than new reserved core records/run-loader APIs.
- Approve one diff handler, bootstrap-at-current semantics, drain-before-removal
  and replay-compatible handler deployments. Confirm the proposed retry and
  candidate limits against WorldVM; measure rather than promise a throughput SLA.
- Decide whether sharing one physical coordinator with live queries is required
  immediately. Recommendation: reuse public planning now; defer coordinator
  extraction until duplicate feed/timer cost is measured. This does not reopen
  the settled separate-package/core-browser-safety decision.

These are approval questions for the subsequent implementation, not claims that
the RFC or the runner has already been approved. The Phase 4 gate remains the
working compliance host and shared conformance evidence, not this document alone.
