# @triplex-build/triplex-sqlite

The Node.js SQLite backend for Triplex, built on `@effect/sql-sqlite-node`.

```bash
npm install effect@4.0.0-rc.112 @triplex-build/triplex@next @triplex-build/triplex-sqlite@next
```

Requires Node.js 22 or newer.

```ts
import { SqliteTriples } from "@triplex-build/triplex-sqlite";

const TriplesLive = SqliteTriples.layer({ filename: "app.db" });
// For tests: SqliteTriples.layerMemory
```

The convenience layer applies Triplex's single v1 migration. Production hosts that own DDL can
compose `makeSqliteLayerUnmigrated` and `makeSqliteAdapter({ autoMigrate: false })` with the shared
`migrations`/`runMigrations` exports from `@triplex-build/triplex-sql`.

SQLite is part of the default shared conformance suite. Pre-1.0 canaries are published under the
`next` tag.

MIT © 2026 Ben Jacobson.
