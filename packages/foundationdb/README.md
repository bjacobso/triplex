# @triplex-build/triplex/foundationdb

An ordered-KV and subscription backend for Triplex using FoundationDB.

This experimental, frozen backend ships as a subpath of `@triplex-build/triplex`.
Its implementation workspace remains private; new features target KV, SQLite and PostgreSQL.

Requires Node.js 22 or newer and compatible FoundationDB client libraries.

Triplex requires a non-empty FoundationDB subspace by default because clearing
an unscoped backend would clear the entire cluster keyspace:

```ts
const backend = makeFdbKvBackend({
  subspace: Buffer.from("triplex/my-database/"),
});
```

An isolated disposable cluster can opt into root access with
`allowUnsafeRootSubspace: true`.

The package exposes `FdbTriples.layer(config)` and FoundationDB watch helpers. Native integration
tests remain opt-in locally; CI provisions a pinned client and runs the shared
Triples, sealed-storage and sensitive-value corpora plus native watch/backfill tests.
The package remains experimental.

`FdbTriples.layer` binds opaque cursors to the configured cluster-file path and
subspace bytes. Keep that configuration stable when resuming a cursor. Restart
existing cursors created with the old shared default identity; stored data needs
no migration. Build different database layers in fresh Effect memoization scopes.

Run `pnpm test:foundationdb:integration` with Docker and a compatible client library
on the loader path. On macOS, the client can be extracted from the official package
without running its installer. Invoke Node directly with `DYLD_LIBRARY_PATH` set
when system shell shims strip that variable; see the repository
`test/evidence/foundationdb-native.md` report for exact verified commands. The
fixture requires a route to Docker container IPs (Linux and OrbStack provide it);
its connectivity probe reports failure rather than claiming a skipped native pass.

Status: experimental and frozen; shipped in the single Triplex package.

MIT © 2026 Ben Jacobson.
