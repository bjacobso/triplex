# Custom runtimes

`@triplex-build/triplex/runtime` is the public adapter-authoring surface in this source checkout.
It provides `Runtime.define`, `Runtime.fromKv`, `DatabaseScope`, and declarative capabilities.
These APIs are pre-1.0; their availability here does not imply a published stable release.

For application-level database composition, see [Host integration](/host-integration). This page
describes implementing a storage or execution backend. Workflows, authorization, routing, timers,
and external effects remain host responsibilities.

## Runtime definitions

A definition supplies Effect layers. Binding a database identity produces a layer providing the
existing `Triples` service:

```ts check
import { Effect, Layer } from "effect";
import { EntityId, Triples } from "@triplex-build/triplex";
import {
  Runtime,
  DatabaseScope,
  Capabilities,
  StorageAdapter,
  QueryExecutor,
} from "@triplex-build/triplex/runtime";

declare const storage: Layer.Layer<StorageAdapter>;
declare const queries: Layer.Layer<QueryExecutor>;

const CustomRuntime = Runtime.define({ name: "custom", storage, queries });
const DatabaseLive = CustomRuntime.layer({
  scope: DatabaseScope.make({
    env: "prod",
    tenant: "acme",
    database: "main",
    generation: 3,
  }),
  capabilities: Capabilities.none,
});

const program = Effect.gen(function* () {
  const triples = yield* Triples;
  return yield* triples.entity(EntityId.make("customer:alice"));
}).pipe(Effect.provide(DatabaseLive));
```

The declared layers stand for your implementations. Already-built services can be supplied with
`Layer.succeed`; the builder accepts layers only.

Backend acquisition errors and external requirements are preserved. A layer needing an ambient
`SqlClient` leaves that dependency on the database layer. `Runtime.define` also exposes
initialization's `MigrationError`. Capability-provider errors propagate, and invalid capability
dependencies produce `CapabilityError`. Unexpected exceptions in custom wrappers remain defects.

### Public contracts

| Service              | Responsibility                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `StorageAdapter`     | Atomic transactions, commit positions, command receipts, triple reads/writes, initialization |
| `QueryExecutor`      | Validated Datalog execution, pagination, explain                                             |
| `TripleStoreRuntime` | Database scope, clock, triple IDs, transaction IDs                                           |

The runtime subpath exports their service interfaces, `TripleRow`, `TripleInput`, `QueryPattern`,
query result types, adapter errors, snapshot and emission contracts, and `StoreCapability`.
`TriplesLive`, SQL compilation functions, and hexastore key encoders remain implementation details.

`StorageAdapterService` has no `rawQuery` requirement. SQL adapters can implement the separate
`SqlStorageAdapterService` refinement exported by `@triplex-build/triplex-sql`.

For SQL execution, `makeSqlQueryExecutorLayer(runner, dialect)` captures the dialect at construction.
Custom runtime authors do not need `CurrentDialect`. The older `SqlQueryExecutorLive` retains its
ambient-dialect behavior for existing callers.

### KV backends

Implement ordered key-value operations and let Triplex supply the hexastore query engine:

```ts check
import { Layer } from "effect";
import { Runtime, KvBackend, DatabaseScope, Capabilities } from "@triplex-build/triplex/runtime";

declare const backend: Layer.Layer<KvBackend>;
const CustomKvRuntime = Runtime.fromKv({ name: "custom-kv", backend });
const DatabaseLive = CustomKvRuntime.layer({
  scope: DatabaseScope.test("custom-kv"),
  capabilities: Capabilities.none,
});
```

This supports the `KvBackend` contract and shared `Triples` behavior. It does not make the hexastore
byte encoding a public API or promise that independently implemented engines can share its
persisted keys. Rehearse upgrades against persistent KV data. `KvTriples.layerBackend` remains
available for existing low-level compositions.

## Database identity

`DatabaseScope.make` requires nonempty environment, tenant, and database strings, plus a
nonnegative safe-integer generation. A versioned JSON tuple avoids collisions from concatenating
strings with separators. Every field participates in the cursor identity.

There is no implicit scope. The builder validates JavaScript callers as well as enforcing the
brand in TypeScript. `DatabaseScope.test(name)` is repeatable, not globally unique: use it only
for isolated fixtures. Older internal helpers retain legacy string defaults; the public builder
does not use them as database identities.

The host must map an authorized caller to the correct physical database and identity. A scope
binds pagination cursors; it neither creates a tenant partition nor authorizes access. Never reuse
an identity for different databases, and advance generation when replacing a database.

## Capabilities

Omitting `capabilities` selects `Capabilities.default`: entity snapshots and change emission.
**The default requires `SnapshotService`, `SnapshotWriter`, and `ChangeEmitter`.** Missing
providers remain visible in the Effect layer's requirements. The builder does not silently
substitute an in-memory snapshot database or discard change events.

Configure persistence and emission explicitly when constructing them against the raw store:

```ts check
import { Effect } from "effect";
import {
  Capabilities,
  DatabaseScope,
  entitySnapshots,
  changeEmission,
  type ChangeEmitterService,
} from "@triplex-build/triplex/runtime";
import { SqlSnapshotsLive } from "@triplex-build/triplex-sql";
import { makeCloudflareRuntime, type DOState } from "@triplex-build/triplex-cloudflare";

declare const state: DOState;
declare const emitter: ChangeEmitterService;

const DatabaseLive = makeCloudflareRuntime(state).layer({
  scope: DatabaseScope.make({ env: "prod", tenant: "acme", database: "main", generation: 3 }),
  capabilities: Capabilities.of(entitySnapshots(SqlSnapshotsLive), changeEmission(emitter)),
});

// The builder supplies its adapter and raw Triples to the snapshot layer.
// This layer provides Triples, SnapshotService, and SnapshotWriter.
const ready = Effect.void.pipe(Effect.provide(DatabaseLive));
```

`entitySnapshots(layer)` receives the raw `Triples` and the definition's backend services during
construction. `Runtime.define` makes its `StorageAdapter` and `QueryExecutor` available there;
`Runtime.fromKv` makes its `KvBackend` available. Snapshot persistence must belong to that same
database. Other requirements stay on the returned layer.

`SqlSnapshotsLive` uses the SQL adapter's snapshot tables. KV authors must provide their own
snapshot reader/writer layer, use only `changeEmission`, or explicitly select `Capabilities.none`.
An automatic durable KV snapshot implementation is not included.

Additional options:

- `Capabilities.none`: expose the base store with no snapshot or emission wrappers.
- `Capabilities.of(...)`: combine providers, retaining their output, error, and dependency types.
- `Capabilities.custom(...wrappers)`: install `StoreCapability` implementations. Names must be
  unique, dependencies must exist, and higher priorities wrap lower priorities.
- `NoopChangeEmitter`: explicitly discard invalidation hints when appropriate.

Snapshots are post-commit projections. A snapshot failure returns a `WriteError` even though
the source facts have committed; use command receipts to resolve retries. Change emission runs
inside the snapshot wrapper, and emission failures are swallowed because the journal is the
durable source of truth. An emitted event does not prove the snapshot is already current.

Snapshot transaction wrappers use the committed journal's actual changes, including broad
pattern retractions. Custom capability behavior needs separate tests.

## Deterministic fixtures

```ts check
import { Layer } from "effect";
import { Runtime, KvBackend, DatabaseScope, Capabilities } from "@triplex-build/triplex/runtime";

declare const freshBackend: Layer.Layer<KvBackend>;
const TestRuntime = Runtime.fromKv({ name: "test-kv", backend: freshBackend });
const TestDatabase = TestRuntime.layer({
  scope: DatabaseScope.test("checkout"),
  capabilities: Capabilities.none,
  deterministic: { startTime: 0, seed: "checkout" },
});
```

This reuses Triplex's deterministic clock and ID generator. `startTime` is a fixed clock value,
not an automatically advancing clock. Counters restart on a fresh build. Use a fresh isolated
backend too: restarting deterministic IDs against existing data is unsafe. Determinism covers
runtime-owned metadata; migrations and custom providers may have their own clocks.

## Lifecycle and ownership

1. Supplied layers acquire resources through Effect's scoped acquisition APIs.
2. `Runtime.define` calls `adapter.initialize()` before installing capabilities. Initialization
   failures remain typed and release scoped resources.
3. Capability providers receive the same raw store; snapshot materialization cannot recursively
   invoke the decorated store through the builder.
4. Closing the runtime's Effect scope runs the supplied layers' finalizers, including when
   initialization or capability construction fails.

The builder **does not call `adapter.close()`**. The adapter layer owns release and should register
it through `Effect.acquireRelease` if it owns the connection. Calling both a layer finalizer and
`close()` could close a shared host connection twice. Existing SQL adapters leave connection
ownership to their SQL-client layer.

Initialization is not necessarily migration: host-managed adapters can supply a check or a no-op
after a separate deployment migration. `Runtime.fromKv` relies on its backend layer for
initialization. Keep each database runtime alive for its intended lifetime; repeatedly constructing
an ephemeral backend creates new databases.

## Correctness contract and conformance

Adapter authors must preserve these guarantees:

- `withTransaction` rolls back facts, retractions, journal metadata, command claims, and commit
  position allocation together on typed failures, defects, or interruption. Concurrent writers
  cannot observe partial commits or invalidate enforced preconditions.
- `nextCommitPosition` allocates an ordered position inside that transaction. Committed positions
  strictly increase; allocation participates in rollback. `currentCommitPosition` identifies a
  consistent committed read boundary.
- `claimCommand` reserves a command identity atomically. A competing duplicate sees the original
  transaction ID; an aborted claimant cannot leave a durable receipt.
- Temporal reads honor the resolved recorded/valid basis, assertion and retraction boundaries,
  and commit positions used for pagination. Results cannot drift while traversing a pinned page.
- Query executors validate inputs and preserve typed-value, join, ordering, and pagination
  semantics. Use the exported Datalog validation helpers before backend execution.
- KV scans use lexicographic byte ordering, inclusive start and exclusive end bounds, and the
  requested direction and limit. Transaction callbacks operate on one atomic view.

Run the shared suite in one expression using testkit:

```ts check
import { Effect } from "effect";
import { DatabaseScope, Capabilities } from "@triplex-build/triplex/runtime";
import { makeCloudflareRuntime, type DOState } from "@triplex-build/triplex-cloudflare";
import { runtimeConformance } from "@triplex-build/triplex-testkit";

declare const isolatedState: DOState;
await Effect.runPromise(
  runtimeConformance(makeCloudflareRuntime(isolatedState), {
    scope: DatabaseScope.test("cloudflare-conformance"),
    capabilities: Capabilities.none,
  }),
);
```

The helper belongs to testkit rather than `Runtime.conformance`, so core has no dependency on its
own tests. It runs `makeTriplesConformanceSuite` against the supplied definition and options. Use a
fresh database: the suite writes fixtures and does not provision or clear storage.

The corpus covers atomic writes, temporal reads, Datalog, pagination, the journal, receipts,
checkpoints, derivations, and graph constraints. **Passing is not full compliance.** It does not
establish production crash durability, cross-process isolation, resource ownership, migration
safety, or complete snapshot/emitter correctness. This repository also tests runtime cleanup and
types, Cloudflare snapshot persistence and pattern retractions, projection failure after commit,
and change events. Test those boundaries for each new adapter.

## Existing backends and release sequencing

`makeCloudflareRuntime` is the executable example: the Cloudflare package now uses public core
and SQL exports. Its additive v2 migration creates snapshot tables for existing v1 databases.
It does not backfill existing entities; use `SnapshotWriter.backfill()` if those projections are needed.
`CloudflareTriples.layer` remains a convenience API with an explicit `Capabilities.none`; its old
string scope is wrapped in the new versioned identity format. Previously issued Cloudflare cursors
must be restarted after upgrading.

SQLite and PostgreSQL convenience layers retain their existing behavior. The SQL database manager
still supplies its existing snapshots and emitter. The builder makes capability selection explicit
for new compositions; it does not enable capabilities on every legacy entry point.

See [Roadmap](/roadmap) for remaining release gates. Public composition support does not promote
experimental Cloudflare or FoundationDB deployments to production-ready backends.
