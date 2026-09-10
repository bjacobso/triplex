# @triplex-build/triplex-sql

Shared SQL migrations, database management, and Datalog execution for Triplex. Most applications
install this transitively through a concrete backend package.

The `@triplex-build` packages are not yet published. Evaluate this workspace package from a source
checkout with the repository's locked Node.js, pnpm, and Effect versions.

The public surface includes the ordered greenfield `migrations`, explicit `runMigrations`, the
`SqlQueryExecutorLive` implementation of Triplex's internal query SPI, and SQL-backed
`DatabaseManager`/registry layers. It is infrastructure rather than a standalone database; use
`@triplex-build/triplex-sqlite` or `@triplex-build/triplex-postgres` for a concrete client and adapter.

MIT © 2026 Ben Jacobson.
