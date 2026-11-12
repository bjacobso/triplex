# @triplex-build/triplex/cloudflare

Cloudflare Durable Object SQLite storage support for Triplex.

This experimental, frozen backend ships as a subpath of `@triplex-build/triplex`.
Its implementation workspace remains private; new features target KV, SQLite and PostgreSQL.

Compose the complete service once in a Durable Object constructor and retain the resulting Effect
runtime for the object's activation:

```ts
import { CloudflareTriples } from "@triplex-build/triplex/cloudflare";

const layer = CloudflareTriples.layer({
  state: durableObjectState,
  scope: "prod:tenant_01:default:generation_01",
});
```

The layer wires storage, migrations, the shared SQL Datalog executor, and cursor scoping to the
same synchronous Durable Object SQLite handle. The `scope` must be the complete immutable database
identity; changing a generation invalidates old cursors.

This convenience layer explicitly selects `Capabilities.none`. To enable snapshots and change
emission, use the public runtime definition:

```ts check
import {
  Capabilities,
  DatabaseScope,
  entitySnapshots,
  changeEmission,
  type ChangeEmitterService,
} from "@triplex-build/triplex/runtime";
import { SqlSnapshotsLive } from "@triplex-build/triplex/sql";
import { makeCloudflareRuntime, type DOState } from "@triplex-build/triplex/cloudflare";

declare const state: DOState;
declare const emitter: ChangeEmitterService;

const layer = makeCloudflareRuntime(state).layer({
  scope: DatabaseScope.make({ env: "prod", tenant: "acme", database: "main", generation: 1 }),
  capabilities: Capabilities.of(entitySnapshots(SqlSnapshotsLive), changeEmission(emitter)),
});
```

The additive v2 migration creates snapshot tables when initializing an existing v1 database.
It does not backfill snapshots for existing entities; run `SnapshotWriter.backfill()` when that
projection is needed. The convenience layer now wraps its string scope in the versioned
`DatabaseScope` encoding, so restart pagination instead of reusing pre-upgrade cursors.

See [Custom runtimes](../../docs/custom-runtimes.md) for lifecycle ownership and capability errors.

All work inside a `Triples.transact` boundary must remain synchronous. Effects that yield to a
timer, network request, or other asynchronous service fail and roll back the native
`transactionSync` callback.

`pnpm --filter @triplex-build/triplex/cloudflare test` runs the shared backend corpus twice: once in a
fast native-SQL harness and once inside Cloudflare's workerd Vitest integration with a real
SQLite-backed Durable Object.

Status: experimental and frozen; shipped in the single Triplex package.

MIT © 2026 Ben Jacobson.
