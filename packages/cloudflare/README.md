# @triplex-build/triplex-cloudflare

Cloudflare Durable Object SQLite storage support for Triplex.

```bash
npm install effect @triplex-build/triplex @triplex-build/triplex-cloudflare
```

Compose the complete service once in a Durable Object constructor and retain the resulting Effect
runtime for the object's activation:

```ts
import { CloudflareTriples } from "@triplex-build/triplex-cloudflare";

const layer = CloudflareTriples.layer({
  state: durableObjectState,
  scope: "prod:tenant_01:default:generation_01",
});
```

The layer wires storage, migrations, the shared SQL Datalog executor, and cursor scoping to the
same synchronous Durable Object SQLite handle. The `scope` must be the complete immutable database
identity; changing a generation invalidates old cursors.

All work inside a `Triples.transact` boundary must remain synchronous. Effects that yield to a
timer, network request, or other asynchronous service fail and roll back the native
`transactionSync` callback.

`pnpm --filter @triplex-build/triplex-cloudflare test` runs the shared backend corpus twice: once in a
fast native-SQL harness and once inside Cloudflare's workerd Vitest integration with a real
SQLite-backed Durable Object.

Status: private experimental workspace package, held from the first npm release.

MIT © 2026 Ben Jacobson.
