---
description: Durable derivation diffs, retries and temporal replay through scoped Effect handlers.
---

# Derivation runner

`@triplex-build/triplex/runner` follows the ordered journal and delivers candidate diffs to
Effect handlers. It persists prepared evaluations, immutable Outbox payloads and acknowledged
candidate snapshots. A materialization by another caller never becomes the delivered base.

Publish `Runner.schema` with your application's release before acquisition. The schema uses
ordinary `runner/control` entities, `runner:` IDs and `:runner/*` attributes. Host validators
must authorize these attributed infrastructure writes; the runner has no authorization bypass.

```ts check
import { Clock, Effect, Layer } from "effect";
import { KvTriples } from "@triplex-build/triplex";
import { ConfigStore } from "@triplex-build/triplex/config";
import * as Derivation from "@triplex-build/triplex/derivation";
import * as Runner from "@triplex-build/triplex/runner";
import { DatabaseScope } from "@triplex-build/triplex/runtime";

const application = Effect.gen(function* () {
  const config = yield* ConfigStore.ConfigStore;
  const release = yield* config.commit({
    label: "runner-example",
    objects: yield* Runner.schema,
    ref: "live",
  });
  const definition = yield* Derivation.make({
    name: "untrained-workers",
    configSnapshot: release.snapshot.id,
    identity: ["?worker"],
    query: {
      find: ["?worker"],
      where: [
        ["?worker", ":worker/active", true],
        ["not", ["?worker", ":worker/trained", true]],
      ],
    },
  });
  const handle = yield* Runner.start(
    [
      {
        key: "training",
        definition,
        onDiff: (delivery) =>
          Effect.log({
            batch: delivery.batchId,
            added: delivery.diff.added.length,
            removed: delivery.diff.removed.length,
            changed: delivery.diff.changed.length,
          }),
      },
    ],
    {
      scope: DatabaseScope.make({ env: "prod", tenant: "acme", database: "work", generation: 1 }),
      id: "requirements",
    },
  );
  yield* handle.await;
}).pipe(Effect.scoped);
const Store = ConfigStore.layer.pipe(
  Layer.provideMerge(KvTriples.layerWithClock(Clock.currentTimeMillis)),
);
const main = application.pipe(Effect.provide(Store));
void main;
```

The logging handler illustrates the envelope. Application handlers normally use
[Database commands](/database) with `delivery.commandId(kind, candidate.id)` as the command ID
and `delivery.batchId` as the correlation ID. Record outgoing integration intents inside that
command, then deliver them with an idempotent transport. See the complete
[compliance host](https://github.com/bjacobso/triplex/tree/main/examples/compliance-host).

## Delivery and recovery

Delivery is at least once and ordered per registration. Bootstrap captures the current journal
head and valid time, then compares current candidates with an empty set. Every relevant later
commit evaluates its exact recorded position; unchanged candidates produce no callback. Removed
candidates retain their old explanation, while `delivery.basis` identifies the cut that observed
absence. Hosts decide whether a removal means satisfaction or cancellation.

Batch identity includes the generation, runner ID, registration key, predecessor delivery,
definition and target basis. Attempts and retry times never change command IDs. A reopened
candidate receives a new batch identity even when its logical candidate ID is unchanged.
Handlers must remain replay-compatible across restarts and deployment.

Prepared and ready batches survive interruption. Acknowledgement atomically updates the control
head and acknowledges the Outbox entry; a separate completed-cut marker repairs a lagging consumer
checkpoint. No arbitrary application effect is atomic with runner acknowledgement.

## Time and supervision

Future starts and expiries, including empty results suppressed by negation, drive one minimum
deadline timer. Offline catch-up replays every recorded boundary at its exact instant. Commits
win ties with boundaries; equal or decreasing timestamps still follow journal position order.
The durable valid-time frontier never rewinds after clock rollback. A bounded head check
(default one second) discovers other-process writes and lost hints. This check does not poll
queries for expiry. Process suspension can delay callbacks.

`handle.status` reports scanned/delivered positions, lag, acknowledged runs, pending attempts,
retry deadlines, failures, evaluation duration and timer lateness. Typed handler failures retry
with jittered exponential backoff (eight attempts, one second to one minute by default).
Exhaustion pauses that registration; others continue, while the shared checkpoint remains at
the minimum delivered coverage. `handle.retryPaused(key)` starts another retry cycle for the
same batch. Defects and storage/scheduler failures reach `handle.await`. Scope closure and
`handle.stop` interrupt and join work without acknowledging an interrupted handler.

Acquisition rejects duplicate keys, unsupported definitions, changed database generations,
missing recovery definitions and malformed control records. Keep old definitions in
`recoveryDefinitions` while prepared or ready work still references them. After that work
finishes, a revised definition produces a definition-change evaluation at the captured current
cut. Drain before removing registrations or making incompatible handler/schema changes.

## Ownership and limits

Use one active process per world/database generation. Local acquisition rejects a second owner;
this registry is not a distributed lease. Hosts must stop or fence old processes before failover.
CAS detects conflicting control transitions but cannot prevent duplicate external effects.
There is no poison-discard API.

Evaluation concurrency defaults to four. Complete candidate snapshots default to a 10,000-candidate
and 16 MB payload budget. Exceeding a budget pauses the prepared batch before application delivery;
increase the budget and resume it after restart. Nothing is truncated. Compaction and chunked
payloads are not provided. Sensitive results in infrastructure snapshots are not automatically
encrypted; hosts control storage access and payload protection.

KV and SQLite are supported targets; PostgreSQL remains a pre-1.0 production candidate. In-memory
KV supports runner restarts while its backend remains alive, and does not promise process-crash
persistence. Persistent deployments need durable storage. Cloudflare and FoundationDB remain
experimental and are not certified for the runner.
