# @triplex-build/triplex-sql

Shared SQL migrations, database management, and Datalog execution for Triplex. Most applications
install this transitively through a concrete backend package.

```bash
npm install effect@4.0.0-rc.112 @triplex-build/triplex@next @triplex-build/triplex-sql@next
```

The public surface includes the ordered greenfield `migrations`, explicit `runMigrations`, the
`SqlQueryExecutorLive` implementation of Triplex's internal query SPI, and SQL-backed
`DatabaseManager`/registry layers. It is infrastructure rather than a standalone database; use
`@triplex-build/triplex-sqlite` or `@triplex-build/triplex-postgres` for a concrete client and adapter.

Pre-1.0 canaries are published under the `next` tag.

MIT © 2026 Ben Jacobson.
