# @triplex-build/triplex-sql

Shared SQL migrations, database management, and Datalog execution for Triplex. Most applications
install this transitively through a concrete backend package.

The `@triplex-build` packages are not yet published. Evaluate this workspace package from a source
checkout with the repository's locked Node.js, pnpm, and Effect versions.

The public surface includes the ordered greenfield `migrations`, explicit `runMigrations`, SQL
query executors, and SQL-backed `DatabaseManager`/registry layers. Use
`@triplex-build/triplex-sqlite` or `@triplex-build/triplex-postgres` for a concrete client and adapter.

For [custom runtimes](../../docs/custom-runtimes.md), `makeSqlQueryExecutorLayer(runner, dialect)`
captures the SQL dialect without an ambient `CurrentDialect` requirement. The existing
`SqlQueryExecutorLive` retains ambient-dialect support for older compositions.

`SqlSnapshotsLive` provides snapshot readers and writers over the runtime's raw `Triples` and
`StorageAdapter`. Its adapter must implement the SQL-only `SqlStorageAdapterService.rawQuery`
refinement and have snapshot tables provisioned. The portable core storage contract does not
require raw SQL. Install this layer through `entitySnapshots(SqlSnapshotsLive)`; projection
failures occur after the source transaction commits and cannot roll it back.

MIT © 2026 Ben Jacobson.
