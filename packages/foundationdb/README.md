# @triplex-build/triplex-foundationdb

An ordered-KV and subscription backend for Triplex using FoundationDB.

```bash
npm install effect @triplex-build/triplex @triplex-build/triplex-foundationdb
```

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
tests are opt-in and the backend is not in the default shared conformance matrix.

Status: private experimental workspace package, held from the first npm release.

MIT © 2026 Ben Jacobson.
