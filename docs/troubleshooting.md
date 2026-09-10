# Troubleshooting and FAQ

## Why does npm return 404 for `@triplex-build/*`?

The package namespace has moved to `@triplex-build`, but the new package family has not yet been
published. As of September 10, 2026, registry lookups for core, SQLite, and the CLI return `404`.
Use the [source-checkout quickstart](/getting-started) until the release gates are complete. Do not
switch new examples back to the superseded `@bjacobso` namespace.

After publication, keep every Triplex package on one coordinated release and use the exact Effect
peer version declared by that release. The current source tree targets Node.js 22+ and
`effect@4.0.0-rc.112`; Effect 3 is incompatible. Multiple Effect copies or an RC mismatch can make
service tags and runtime types disagree even when imports look correct.

## Why is `Triples` (or another service) missing?

An Effect program describes requirements until a layer provides them. Supply a backend layer at
the application boundary:

```ts
await Effect.runPromise(program.pipe(Effect.provide(KvTriples.layer)));
```

`ConfigStore.layer` itself requires `Triples`, so compose it over the same database:

```ts
const AppLayer = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));
```

Construct that layer once per intended database lifetime. Reconstructing an in-memory layer creates
a new empty database; constructing per-request SQLite/PostgreSQL layers also defeats connection and
runtime sharing.

## Why is a query empty?

Check these in order:

1. **Identity and value type:** direct entity/reference APIs require branded `EntityId`/`TripleId`
   values; raw Datalog terms are decoded by the query schema.
2. **Temporal basis:** omitted `validAt` means now. A future-effective or expired fact will be
   absent even if it exists in history.
3. **Retraction:** `entity` and `match` show visible facts; `history(entityId)` also shows retracted
   assertions.
4. **Join variables:** a spelling difference such as `?site` versus `?siteId` prevents clauses from
   joining.
5. **Negation safety:** variables in `not` must already be bound outside it; invalid programs fail
   preflight instead of producing a partial answer.

Use `triples.explain(query)` or CLI `query explain`, then run with debug output to inspect the
compiled plan without changing the query.

## Why are only 100 query rows returned?

`Triples.query` and `queryPage` are bounded and default to 100 rows. This is not evidence that only
100 matches exist. Follow `nextCursor` using the same canonical query, page size, temporal basis,
and database scope. Cursors are opaque, versioned, and snapshot-stable; do not decode or edit them.

Use `queryAll` only for trusted internal/batch work that deliberately needs an unbounded complete
result. Pagination bounds result transfer, not necessarily all database work, especially for joins,
aggregation, or counts.

Entity timelines use a different newest-first contract: preserve the first page's
`snapshotPosition` and pass its `nextBeforePosition` as `beforePosition` on the next request.

## Which historical clock should I set?

`recordedAt` asks what the database knew; `validAt` asks what was true in the domain. Setting only
`recordedAt` still uses the current valid time, and setting only `validAt` still uses the latest
recorded knowledge. For “what did we believe then about what was true then?”, set both explicitly.

Both are non-negative epoch milliseconds. Valid intervals are `[validFrom, validTo)`, so a fact is
not visible exactly at its `validTo`. For exact transaction order, use journal positions; multiple
commits can share one millisecond. Read [the dated example](/concepts#recorded-time-and-valid-time).

## What should happen on a duplicate command ID?

Command IDs are atomically unique within one Triplex database. Reusing a committed ID raises
`CommandAlreadyCommittedError` with the original transaction ID; Triplex does not apply the write
again. Treat the original transaction as the durable idempotency receipt and retrieve it with
`transactionByCommand(commandId)` or CLI `journal receipt`.

Do not generate a replacement ID until you know you are issuing a genuinely new domain command.
Command IDs must contain 1–1024 characters.

## Why did invalid data commit?

Configuration metadata and enforcement are separate. `meta.configSnapshot` records which release
governed a write, but constraints are enforced only when the command also passes
`meta.enforce.constraints`. The built-in atomic rules cover requiredness, cardinality, uniqueness,
and reference-target kinds.

Always derive or collect rules from the exact immutable snapshot you pin. Existing violations can
remain during unrelated writes or repairs; enforcement rejects a new or worsened violation. Direct
adapter writes, commands without `enforce`, authorization, and general Datalog invariants are
outside this guarantee. Use validation observations when auditing or migrating existing data.

## Why is a projection stale or empty?

Entity validation and derivation materialization are projections over already committed source
facts. A projection failure cannot roll back the source transaction. Their read APIs expose
freshness explicitly:

- `current` means the stored run matches the relevant current source position and basis;
- `stale` returns last-known results, which must not be presented as current truth; and
- `unmaterialized`/`unvalidated` means no run exists, so an empty result is not proof that no work or
  violation exists.

Run the materializer/validator after relevant journal changes, persist consumer checkpoints only
after downstream effects complete, and schedule the next derivation run at
`nextTemporalBoundary`. In-process change signals are wake-up hints; journal catch-up is the durable
source.

## Does moving a config ref roll back data?

No. `setRef` only points a name such as `live` at another existing immutable configuration
snapshot. Operational facts, command receipts, configuration pins on old transactions, migrations,
and external side effects remain unchanged. See the [worked rollback
example](/configuration-versioning#understand-rollback).

## Where should authentication, authorization, and delivery live?

In the host application. Authenticate and authorize before selecting a trusted database mapping or
providing `Triples`. The host also owns HTTP contracts, task lifecycle, inbox/outbox delivery,
timers, retries, monitoring, retention, backup, recovery, and higher-order business invariants.
Triplex supplies database primitives, not those operational guarantees. Continue with [Host
integration](/host-integration).
