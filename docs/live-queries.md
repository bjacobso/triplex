---
description: Observe complete Datalog snapshots at exact commit positions and valid-time boundaries.
---

# Live queries

`LiveQuery` from `@triplex-build/triplex/live-query` observes complete Datalog snapshots.
Install one scoped layer per database runtime, using the same server-resolved `DatabaseScope`
as the store. Its generation must survive a process restart and change after a database restore.
Hosts authorize queries and own quotas, retention and token persistence.

```ts check
import { Effect, Stream } from "effect";
import { KvTriples } from "@triplex-build/triplex";
import { DatabaseScope } from "@triplex-build/triplex/runtime";
import { LiveQuery } from "@triplex-build/triplex/live-query";

const scope = DatabaseScope.make({
  env: "dev",
  tenant: "demo",
  database: "safety",
  generation: 1,
});
const observations = Effect.gen(function* () {
  const live = yield* LiveQuery;
  return yield* live
    .watch({
      find: ["?worker", "?site"],
      where: [
        ["?placement", ":placement/worker", "?worker"],
        ["?placement", ":placement/site", "?site"],
        ["not", ["?worker", ":worker/trained-for", "?site"]],
      ],
    })
    .pipe(Stream.take(1), Stream.runCollect);
}).pipe(
  Effect.provide(LiveQuery.layer({ scope })),
  Effect.provide(KvTriples.layerWithScope(scope)),
  Effect.scoped,
);
```

The initial emission includes an empty relation. Each possibly relevant commit then emits one
complete snapshot, even if its rows are unchanged. A multi-operation transaction emits once.
Raw watches use `queryAll`, preserving query ordering, aggregation and explicit restrictions.
`maxRows` defaults to 10,000 (range 1–100,000): exceeding it fails with `WatchResultTooLarge`.
This check occurs after execution and is **not a query-memory bound**.

Use a wrapped query for a large relation. The watch calls `queryPage` for that moving window,
including its filters, ordering, count and limit (default 100, maximum 1,000). Input continuation
cursors are rejected. Returned cursors remain ordinary continuations of that exact snapshot;
they do not create another live page. Rows outside the visible window can change membership.

Each version-1 envelope contains `watchId`, `eventId`, exact `position`, `validAt`, `reason`,
`coveredAfter`, `result`, `nextTemporalBoundary` and `resume`. Coverage starts exclusively after
the preceding emission; initial coverage is null. Journal gaps conservatively invalidate,
including internal checkpoint maintenance that has no journal envelope. Watches never write
checkpoints. The global ordered journal is authoritative; emitter delivery is unnecessary.

## Valid time and restart

The default `validTime: { mode: "now" }` resolves Effect's clock once per evaluation.
One shared deadline scheduler wakes queries at the earliest dependency boundary, including
future starts, expired negated facts, and facts outside a visible window. The interval is
half open. A late observation uses actual evaluation time. Idle journal checks discover remote
writes; they do not repeatedly query results to discover expiry.

`validTime: { mode: "fixed", at: timestamp }` follows recorded corrections to a fixed business
instant without timers. Queries with Datalog `validTime: "all"` emit `validAt: null` and have no
temporal timer; explicit point options are rejected. Literal predicate cutoffs stay literal.
Recorded bases in watch inputs are rejected: use ordinary reads for a frozen recorded view.

```ts check
import { Effect, Stream } from "effect";
import { LiveQuery } from "@triplex-build/triplex/live-query";

const reconnect = (resume: string) =>
  Effect.gen(function* () {
    const live = yield* LiveQuery;
    return yield* live
      .watch(
        {
          find: ["?name"],
          where: [["?person", ":person/name", "?name"]],
        },
        { resume },
      )
      .pipe(Stream.take(1), Stream.runCollect);
  });
```

Persist `resume` only after handling the corresponding result. Restart first replays the exact
old basis with reason `resume` and the same `eventId`, catches up commits at current valid time,
then observes elapsed time at the current head. Tokens bind the complete query, window, options
and database generation. Malformed, modified, incompatible, changed-query and ahead tokens fail
with `WatchResumeError`. They are not authorization credentials. Position alone cannot deduplicate
a timer observation: two events may have the same position and different valid instants.

## Scheduling and limits

Default delivery backpressures: each pull evaluates at most one snapshot, retaining a journal
position rather than queuing transaction bodies. Slow consumers replay storage independently.
`coalesceMs` (default 0, integer 0–1,000) allows an explicit burst window: all envelopes are
scanned, then one `coalesced` snapshot covers the range. Assert/retract intermediates can disappear.
A temporal deadline bounds the coalescing wait. Offline temporal boundaries collapse into a
current observation; this stream is not a historical timer log or an exactly-once task runner.

The layer accepts `idleCheckMs` (default 1,000, range 1–1,000) and `evaluationConcurrency`
(default four). Cancellation releases registrations and pending pulls. With no consumer demand,
reads and deadlines wait for demand. The coordinator retains at most one 1,000-envelope cache
page; a lagging subscriber catches up directly from the journal. `live.metrics` reports scanned
head, last delivered position, last evaluation duration, subscriber count and timer lateness.

Dependency analysis includes negation, every disjunction alternative and reachable rule body.
Dynamic attributes use `dependencyStateAll`; fixed attributes use indexed `dependencyState`.
Conservative invalidation may emit unchanged rows. Sensitive-query restrictions continue to apply.

KV and SQLite run the shared conformance cases. PostgreSQL uses the same public composition;
its integration gate remains opt-in. Cloudflare and FoundationDB remain experimental.
For durable candidate reconciliation and business work, see [Derivations](/derivations) and
[Operational primitives](/operational-primitives).
