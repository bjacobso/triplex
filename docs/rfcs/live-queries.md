# RFC: journal-driven live queries

Status: proposed for P4.3, awaiting owner approval before P4.4. This is a design,
not an implemented API. It changes no package source or public exports.

## 1. Recommendation and API

Add a browser-safe `LiveQuery` service on a proposed
`@triplex-build/triplex/live-query` subpath. Its `watch(query, options)` returns an
Effect `Stream` of complete result snapshots. Start with query re-execution, not
incremental maintenance. WorldVM can replace its displayed result atomically,
including after reconnecting, without keeping a durable diff base or inventing
row identities for aggregates. A snapshot is an observation, not a durable task
occurrence or an instruction to perform an external action.

The following are proposed contract fragments, deliberately ordinary `ts` fences.
Implementation must add checked examples against public exports.

```ts
type WatchOptions = {
  readonly validTime?: { readonly mode: "now" } | { readonly mode: "fixed"; readonly at: number };
  readonly resume?: string;
  readonly coalesceMs?: number; // default 0; finite integer 0..1000
  readonly maxRows?: number; // raw complete results: default 10_000, integer 1..100_000
};
type WatchSnapshot = {
  readonly version: 1;
  readonly watchId: string; // canonical query/options identity, scoped to this database generation
  readonly eventId: string;
  readonly position: number; // exact recorded cut, including internal maintenance positions
  readonly validAt: number | null; // null only for a future all-valid-time query
  readonly reason: "initial" | "resume" | "commit" | "time" | "coalesced";
  readonly coveredAfter: number | null; // exclusive journal coverage start; null for initial
  readonly result: QueryResponse | PagedQueryResponse;
  readonly nextTemporalBoundary: number | null;
  readonly resume: string;
};
interface LiveQueryService {
  readonly watch: (
    query: DatalogQuery | WrappedQuery,
    options?: WatchOptions,
  ) => Stream.Stream<WatchSnapshot, WatchError>;
}
```

The service requires `Triples`, Effect clock/scheduling, and a scoped shared feed
coordinator. Errors include existing read/query/cursor failures plus typed
`WatchOptionsError`, `WatchResumeError`, and `WatchResultTooLarge`. Invalid inputs
fail before registration; cancellation releases registrations, timers and pending
reads. A read failure ends the stream with its typed error; a caller may retry
from its last successfully handled token. Never advance delivery state on failure.

For a raw query, use `queryAll`, preserving the query's own ordering, aggregation
and explicit result restrictions. Do not call the default 100-row `query` and
present it as a complete relation. `maxRows` rejects oversize results, never
silently truncates them; an initial implementation can enforce it after execution
but must document that it is not a query-memory bound. Large relations should use
a wrapped window. Row order without an explicit order is not a consumer identity.

For a wrapped query, re-run `queryPage` for the same window, including filters,
ordering, offset/limit and requested count. Preserve existing defaults and the
1,000-row page maximum. A window may gain or lose rows because a row outside it
changes sort rank. Reject an input continuation cursor: it pins an older cut and
cannot define a moving window. A returned continuation cursor remains usable for
ordinary reads of that snapshot only. Following it does not create another live
page; start a separate watch for another window. Rows, count and cursors in one
emission must all use the envelope's exact basis, even if count is a second query.

Recorded time always follows committed positions. Reject explicit `recordedAt`
or `recordedPosition` embedded in a proposed watch input; use ordinary reads for
a frozen recorded view. `validTime` defaults to `now`. Resolve it once per
evaluation with Effect's clock, and pass that same `validAt` to every read. Fixed
valid time follows corrections to what is believed about that instant, without
expiry timers. Validate `at` against the existing timestamp domain.

If the [Datalog time RFC](datalog-time.md) is implemented, normalize its interval
patterns in dependency extraction. `validTime: "all"` queries need no valid-time
timer and emit `validAt: null`; reject an explicit point option. This RFC does not
make that syntax available ahead of owner approval. Literal predicate cutoffs
remain literal: a query containing “today plus 30 days” as a number does not
automatically move that number. Recreate the watch when those parameters change.

## 2. Journal correctness and restart

The authoritative inputs are `Triples.transactions`, `currentPosition`, and
position-pinned reads. `ChangeEmitter`, `SubscriptionManager` and network wakeups
are hints to check those inputs sooner. They cannot establish coverage or supply
the only copy of a change. Never label an unpinned latest query with a previously
read position.

Use this protocol:

1. Register with the shared coordinator, then capture `H = currentPosition()`.
   Execute the initial query and dependency schedule at
   `{ recordedPosition: H, validAt: T }`. Emit even an empty result. Writes racing
   registration or evaluation are either included at H or found after H.
2. Read the **unfiltered global** journal after the last scanned position in
   bounded pages. Process envelopes in increasing position order. A transaction
   is atomic: inspect all assertions and retractions, then evaluate at its
   position if possibly relevant. Never emit intermediate operations in a commit.
3. With the default `coalesceMs: 0`, emit once for each possibly relevant commit,
   even if the rows are identical. An irrelevant commit advances the internal
   scanned position without an emission. `coveredAfter` is the previous emitted
   position, so the next emission also covers intervening irrelevant commits.
4. At a captured head, ignore any later envelopes for this drain and retain them
   for the next drain. Exhausting a page alone does not prove the database head:
   compare with `currentPosition`. Positions may have gaps because checkpoint
   maintenance is intentionally unjournaled. Across any uncovered position gap,
   conservatively re-evaluate all watches at the gap's end. Do the same for a
   trailing gap through H, even when the feed is empty. An over-invalidation is
   preferable to hiding a queryable consumer-checkpoint change.
5. Re-arm the earliest temporal deadline and drain again after any wakeup. Also
   perform a configurable shared journal/head check (default at most one second
   while idle). Missing every emitter message must affect latency only. After
   every drain, check for newly arrived work before sleeping. Pending timer and
   journal work are serialized per watch.

The journal stores application changes, not every reserved metadata assertion.
Queries reading `:_tx/*` must invalidate on every journal envelope, including
empty and entry-only commands. Unknown/older envelope formats conservatively
invalidate rather than treating missing change metadata as proof of no effect.
Direct adapter mutations outside Triples' position protocol are unsupported.

Every result is exactly the query at `(position, validAt)`, not an assertion that
the database cannot already have advanced. Positions are safe integers, not
timestamps, and zero represents the empty recorded cut. Equal commit timestamps
must remain distinguishable. A timer can emit at the same position with a later
valid instant; position alone is therefore insufficient for deduplication.

Build `eventId` with the browser-safe canonical content hash over version,
database generation, canonical query/options, position and validAt. Exclude reason,
delivery attempt, coverage and scheduling metadata. Replaying the same basis has
the same event ID; later timer evaluations at a different instant have different
IDs even if the rows coincide. No result-equality suppression is required in v1.

The opaque, versioned resume token binds that identity, the emitted basis and
event ID. Validate its structure, database generation and full query/options
fingerprint; reject tampering, incompatible versions and changed parameters with
`WatchResumeError`. It is not an authorization credential. The host must still
authorize the query and resolve the same database. A restored/recreated database
needs a new generation. Reject a token ahead of the committed head or referencing
history that retention no longer supports; never silently reset to latest.

On restart, first re-evaluate and emit the token's **exact old basis** with reason
`resume` and the same event ID. Then drain after its position and evaluate new
commit cuts at the current valid instant (or the configured fixed instant).
Finally evaluate at the current head and current valid time to account for time
elapsed while offline, even if no transaction arrived. Consumers persist a token
only after processing its result; a crash before acknowledgement can redeliver it.
Use event ID for idempotency. Exactly-once external effects are not promised.

`ConsumerCheckpoint` is useful for a durable host's journal processing but stores
only a position: it cannot replace the watch token, which also binds query and
valid time. Persist the token in host storage together with application effects
where possible. Core does not write checkpoints on stream delivery, avoiding a
watch that recursively observes its own acknowledgements.

“No update lost” means every journal envelope after the starting cut is examined
or explicitly included in a coalesced coverage range, and every emitted snapshot
has a coherent basis. It does not mean this observation API reproduces every
historical wall-clock state after a process was stopped. Offline time edges are
collapsed into a current observation. Use a durable runner and application
occurrences when every business-time transition must be handled as work.

## 3. Conservative invalidation

Reuse `extract-dependencies.ts` to walk positive patterns, all negation clauses,
every disjunction alternative, and every definition of each reachable rule.
Visit recursive rule names once while walking all their bodies to closure.
Predicates, grouping, having and wrapper operations filter or transform those
reads; they do not remove dependencies. Wrapper dependencies come from its inner
query, including hidden sort/filter inputs.

`invalidation.ts` currently narrows by attribute-derived namespace, attribute and
bound entity IDs. Those sets are useful candidates, not a proof for every query
shape. The watch planner must record whether a narrowing is sound:

- Fixed attributes: a change to any read attribute may matter. Namespace names
  derived from attributes are not entity-type membership constraints.
- Only narrow by a constant entity when every reachable pattern reading that
  attribute is proven to use those constants. Mixed bound/unbound patterns must
  retain the unbound branch. Do not infer a rule argument's type from its ID prefix
  and use that heuristic to discard changes in a recursive join.
- Any dynamic attribute slot makes the watch database-wide. In particular, a
  mixed fixed/dynamic query must bypass **all** namespace and bound-ID filters;
  the current type-first filtering cannot safely certify that case.
- Facts inside negation are dependencies even when the query currently returns
  zero rows. Both adding suppressing evidence and retracting it may change output.
- Rule closure includes base relations reached indirectly, all same-named rule
  definitions, and negation/disjunction within them. Unknown clause forms,
  unresolved dependency analysis or incomplete journal data mean re-run. Invalid
  queries still fail shared query preflight; “unknown” is no permission to execute
  an invalid query.

Do not filter the journal by entity prefix just because the projected IDs share
a prefix. The [prefix feed](../operational-primitives.md#entity-prefix-transaction-feeds)
is a subsequence, not an attribute/dependency feed. A training assertion on a
worker can affect work projected for a placement. Only a future planner proof
covering every positive, negative and rule input could justify such filtering.
V1 uses the global feed for all watches.

## 4. Valid time without expiry polling

After each evaluation call `dependencyState(attributes, basis)` at the **same**
recorded cut and valid instant as the query. Its next temporal boundary includes
future `validFrom` and `validTo` of all currently recorded dependency facts,
including facts in negative clauses and facts supporting no current row. Never
derive the deadline only from returned rows or a page's visible members.

Sleep with Effect's clock until that boundary, wake, drain committed journal work,
resolve now once and re-evaluate. Half-open intervals include their start and
exclude their end. Recompute the next boundary after every commit-triggered run;
a correction can bring an earlier deadline forward or remove it. A late timer
evaluates at actual now and advances beyond elapsed boundaries, avoiding a busy
loop. A backward wall-clock jump triggers re-evaluation and deadline re-arming;
use an injected clock for tests and bounded wall-clock rechecks in the shared
coordinator. Timer delivery cannot promise an exact real-time latency while a
browser tab is suspended or a process is overloaded.

Dynamic attributes need an all-attribute form of this read; an empty attribute
array currently means **no dependencies**, not wildcard. Add an explicit public
`dependencyStateAll(basis)` with the same source-position/boundary semantics.
Until implemented, reject dynamic watches with a typed unsupported-capability
error; do not silently run them with no expiry schedule. The design supports
them by re-running for every commit and using this wildcard boundary read.
Fixed valid-time and future all-valid-time watches need no expiry schedule.

The shared idle journal check discovers remote commits when emitters are lost;
it is not expiry polling. Expiry uses one deadline scheduler, with no recurring
query or full dependency scan just to discover a known time boundary.

## 5. Cost, coalescing and backend behavior

Re-execution is the correctness baseline, including recursive rules, negation,
aggregates, optional projections and window membership. Incremental maintenance
is worthwhile only after WorldVM measurements show repeated evaluation dominates
cost for stable, high-fanout subscriptions, with a sufficiently narrow query
subset and explicit deletion, negation, aggregate and temporal-edge semantics.
Require differential tests against re-execution and measured CPU/memory savings
before adding another execution engine. The roadmap's incremental-update goal is
deferred, not claimed as delivered by this API.

`coalesceMs > 0` explicitly selects observation coalescing. Scan every intervening
envelope, union invalidations, and run once at the final captured position when
the bounded window closes. Emit reason `coalesced` with the exclusive previous
emitted position in `coveredAfter`. Intermediate states can disappear (assert then
retract may emit an empty result); the coverage range makes that deliberate.
Never postpone a pending temporal deadline to extend a burst window.

Default streams backpressure: keep at most one undelivered snapshot per watch,
pause its evaluation, and retain only a journal position and earliest due timer.
On demand, resume journal replay from that position. Do not retain an unbounded
queue of transaction bodies, and never silently switch a slow default consumer
into coalescing mode. With coalescing enabled, accumulate a bounded pending
coverage range while blocked and emit its final state on demand. A consumer whose
required history was pruned fails explicitly. Delayed temporal observations use
actual evaluation time; this remains a live observation contract, not a timer log.

One scoped coordinator per Triples database generation shares feed reads, idle
checks and a minimum-deadline queue across watches. Identical canonical query,
window and temporal options can share evaluation; each subscriber keeps its own
delivery/checkpoint state. Index watches by attributes, with a wildcard bucket.
Bound evaluation concurrency (proposed default four per database) and schedule
fairly so a costly query cannot starve expiry work. A lagging subscriber catches
up from storage independently rather than blocking all others. Scope shutdown
interrupts reads and releases timers. Export metrics for scanned head, delivered
position, evaluation duration, pending subscribers and timer lateness.

| Backend      | Initial strategy and limit                                                                                                                                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-memory KV | Share the one ordered journal and attribute-index dependency reads. Synchronous query work still consumes browser/event-loop time; bounded concurrency is not parallel CPU execution. In-memory data and resume tokens survive only while that database survives.                                     |
| SQLite       | Use position-pinned reads over public Triples APIs; avoid holding a long read transaction while waiting for demand. Share one coordinator per database handle and use shared idle checks for other writers/processes. Measure writer contention and historical-read costs.                            |
| PostgreSQL   | Share one coordinator per scoped database runtime; use position predicates for exact historical cuts across statements. Pool/concurrency limits bound simultaneous reads. NOTIFY, if a host supplies it, is only a wakeup hint; disconnected or other-process writers are recovered from the journal. |

Multiple processes can each coordinate their own watchers safely; this costs
duplicate reads, not lost updates. Hosts own query authorization, subscription
quotas, retention and retry policy. Cloudflare and FoundationDB remain frozen,
experimental backends: keep existing compilation/tests intact; no new watch
certification or backend-specific implementation is required by this RFC.

## 6. Core and runner boundary; missing public reads

Put the observation service in core because it is a generic read composition
over `Triples`, usable in a browser with Effect clock, Stream and scoped fibers.
Import no Node APIs, backend internals, SQL clients or sibling package source.
The settled runner remains its own package beside HTTP and CLI, using public
exports only. It owns durable derivation catch-up, `ConsumerCheckpoint`, host
handlers and scheduling across restarts. It can reuse the observation planner or
coordinator through public exports, but must not use a coalescing UI watch as a
durable per-transition task log. Do not make core depend on runner.

Existing public reads cover `currentPosition`, exact `recordedPosition` query
bases, `transactions`, `queryAll`, `queryPage` and fixed-attribute
`dependencyState`. No new head read or position allocator is needed. The missing
public read is `dependencyStateAll`, required for dynamic temporal dependencies.
The later implementation must also verify count/page basis parity, export the
new service, and strengthen conservative dependency analysis as above. These are
implementation requirements, not changes shipped by this document.

## 7. Agent access through P3.6 MCP

Do not make an ordinary MCP tool call wait indefinitely for a Stream. Initially,
the planned server keeps its existing bounded query tools; it exposes no watch
tool until a transport lifecycle is specified. Agents can issue snapshot reads
and use the journal/checkpoint APIs through an authorized host.

If WorldVM needs subscription access, add bounded `watch_open`, `watch_next` and
`watch_close` tools over this same service. Open returns a scoped opaque handle
and initial envelope; next accepts a bounded wait and returns at most one envelope
or a timeout with the unchanged resume token; close interrupts the scope. Bind
handles to authenticated session, database generation and query permissions; cap
idle lifetime and concurrent handles. Resume across server restarts uses the
snapshot token, not the ephemeral handle. Notifications may request a next call,
but never carry the only result or advance acknowledgement. Opening/reading is
read-only and needs no actor/command ID; host-side effects remain explicit writes
under P3.6's actor/command requirements. This extension awaits demonstrated need
and owner approval; no MCP source belongs in P4.3.

## 8. Worked site-safety observation

Use the model and open-work query in
[the site-safety application](../snippets/home/site-safety/app.ts). A placement
without training for its worker/site produces one open training-work row:

```ts
// Proposed watch call; query structure mirrors openWork in the checked snippet.
const query = {
  find: ["?worker", "?site"],
  where: [
    ...Placement.where("?placement", { worker: "?worker", site: "?site" }),
    Worker.not("?worker", { trainedFor: "?site" }),
  ],
};
const observations = liveQuery.watch(query); // validTime now, no coalescing
```

For this isolated fixture, the release and Maria/Harbor onboarding already exist
at captured position H. There are no other writes or checkpoints, so the next
three positions are H+1, H+2, H+3. This is a reordered variant of the homepage
story, not a claim that its generated timeline changes. All instants below are
UTC in 2026. The watch starts March 2, after placement validFrom becomes effective.

| Observation       | Recorded cut | Valid instant | Action / result                                                                                         | Next boundary |
| ----------------- | ------------ | ------------- | ------------------------------------------------------------------------------------------------------- | ------------- |
| Initial           | H            | March 2       | No placement yet: `[]`                                                                                  | none          |
| Commit 1          | H+1          | March 2       | Dana places Maria at Harbor from March 2: `[{ "?worker": "worker:maria", "?site": "site:harbor" }]`     | none          |
| Commit 2          | H+2          | March 2       | Trainer asserts Harbor training `[March 1, June 1)`: `[]`                                               | June 1        |
| Commit 3          | H+3          | March 6       | Auditor retracts that assertion and replaces it with `[March 5, June 1)`, as in `correctTraining`: `[]` | June 1        |
| Expiry, no commit | H+3          | June 1        | Training is no longer valid; Maria/Harbor reappears as open work                                        | none          |

The correction still emits because it may affect the query, even though both
evaluations are empty at their stated instants. Each envelope records the table's
position and actual millisecond validAt, its event ID and resume token. The last
two positions match but event IDs differ. At expiry, `dependencyState` wakes the
watch even though the prior result was empty and the expired fact was inside
negation. No transaction is invented to represent the passage of time.

A separate fixed-valid-time watch at March 3 would emit empty after commit 2,
then open work after commit 3: the correction changes what is believed about that
past instant. It would not schedule June 1. The now watch does not retroactively
emit a March 3 state when the auditor commits on March 6.

## 9. Conformance and owner questions

The later implementation must write each regression test first, observe failure,
then implement it. Add a shared corpus for in-memory KV, SQLite and PostgreSQL:

1. Initial empty/nonempty observations; commits racing registration, head capture,
   query, schedule read and sleep; lost/duplicate/reordered emitter hints and a
   write from another runtime. Verify journal recovery without emitter delivery.
2. Exact position cuts under concurrent writes and equal commit timestamps;
   atomic multi-operation transactions; raw results beyond 100 rows; wrapper
   count/window/cursor parity and concurrent reordering outside the visible page.
3. Assertions and retractions through joins, mixed bound/unbound entities, mixed
   fixed/dynamic attributes across namespaces, negation with zero output,
   disjunction, recursive rules and all same-named rule definitions. Unknown
   dependency metadata must re-run, never silently skip.
4. Metadata queries on empty/entry-only commands; unjournaled checkpoint gaps,
   including a trailing gap with an empty journal page. No recursive checkpoint
   writes from watch delivery. Position zero and gaps must not look like corruption.
5. Virtual-clock future starts, exact half-open expiry, negated/suppressed facts,
   expiry outside a watched page, corrected/removed deadlines, shared deadlines,
   timer/commit races, delayed wakeups and clock rollback. Include the worked
   three-commit/one-expiry sequence. No periodic query polling for known expiry.
6. `dependencyStateAll` parity with the union of all attributes at the same cut,
   including historical retractions and future starts. Empty fixed dependencies
   remain empty. Fixed valid-time watches get corrections but no timers.
7. Exact-token replay/deduplication, crash before/after handling, restart after
   offline expiry with no writes, changed query/options/database generation,
   malformed/version-mismatched/ahead tokens and unavailable retained history.
8. Coalescing assert/retract bursts with explicit coverage; default per-commit
   backpressure; slow consumers, bounded queues and independent catch-up;
   cancellation/error cleanup, fair concurrency and one shared idle feed reader.
9. Browser-safe public composition and existing sensitive-query rejection rules;
   typed size/options failures; no silent truncation. Exercise supported query
   forms regardless of exact derivation-provenance restrictions.

The orchestrator runs PostgreSQL integration; frozen-backend existing checks must
continue passing. This RFC adds no executable API test because it implements no
API. Owner approval gates the source changes, checked examples and release
Changeset; there is no breaking package change in this documentation-only item.

Owner questions for P4.4 / D6:

1. Approve full snapshots, per-relevant-commit delivery by default, explicit
   optional coalescing, and observation-time rather than historical timer replay?
   Recommendation: yes; use the runner for durable business transitions.
2. Approve the core service and shared coordinator, with durable handlers and
   checkpoints remaining in the separately settled runner package? Recommendation:
   yes; both use public APIs and core remains browser-safe.
3. Approve `dependencyStateAll` and conservative gap/dynamic-query invalidation?
   Recommendation: yes; accepting dynamic temporal queries without a complete
   boundary read would make expiry correctness impossible.
4. Are the proposed one-second idle discovery interval, four concurrent
   evaluations and raw-row limits suitable for WorldVM? Recommendation: start
   with these configurable limits and measure lag, evaluation cost and memory.
5. Does WorldVM need MCP subscriptions initially? Recommendation: defer handles
   until its agents demonstrate a need beyond bounded queries and runner events.

These questions do not reopen Effect-only APIs, backend policy, runner ownership
or the deferred position allocator. No implementation, package publication or
deployment is authorized by accepting this design item alone.
