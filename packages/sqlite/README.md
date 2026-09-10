# @triplex-build/triplex-sqlite

The Node.js SQLite backend for Triplex, built on `@effect/sql-sqlite-node`.

The `@triplex-build` packages are not yet published. Evaluate this workspace package from a source
checkout with Node.js 22+ and the repository's locked dependencies. See the
[quickstart](../../docs/getting-started.md#use-durable-sqlite).

```ts
import { SqliteTriples } from "@triplex-build/triplex-sqlite";

const TriplesLive = SqliteTriples.layer({ filename: "app.db" });
// For tests: SqliteTriples.layerMemory
```

The convenience layer applies Triplex's single v1 migration. Production hosts that own DDL can
compose `makeSqliteLayerUnmigrated` and `makeSqliteAdapter({ autoMigrate: false })` with the shared
`migrations`/`runMigrations` exports from `@triplex-build/triplex-sql`.

SQLite is part of the default shared conformance suite.

MIT © 2026 Ben Jacobson.
