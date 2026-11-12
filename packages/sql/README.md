# @triplex-build/triplex/sql

Shared SQL migrations, database management, and Datalog execution for Triplex. Most applications
install this transitively through a concrete backend package.

Install `@triplex-build/triplex/sql` from npm when building a custom SQL runtime. Use Node.js 22+
and the compatible Effect 4 release candidate.

The public surface includes the ordered `migrations`, explicit `runMigrations`, SQL
query executors, and SQL-backed `DatabaseManager`/registry layers. Use
`@triplex-build/triplex/sqlite` or `@triplex-build/triplex/postgres` for a concrete client and adapter.

For [custom runtimes](../../docs/custom-runtimes.md), `makeSqlQueryExecutorLayer(runner, dialect)`
captures the SQL dialect without an ambient `CurrentDialect` requirement. The existing
`SqlQueryExecutorLive` retains ambient-dialect support for older compositions.

`SqlSnapshotsLive` provides snapshot readers and writers over the runtime's raw `Triples` and
`StorageAdapter`. Its adapter must implement the SQL-only `SqlStorageAdapterService.rawQuery`
refinement and have snapshot tables provisioned. The portable core storage contract does not
require raw SQL. Install this layer through `entitySnapshots(SqlSnapshotsLive)`; projection
failures occur after the source transaction commits and cannot roll it back.

Numeric Datalog ranges share a number/datetime expression index, installed by additive migration
v2 (including existing baseline v1 databases). Run `runMigrations` with the host's `SqlClient`
during provisioning/deployment, or apply the ordered definitions with host-owned tooling.
`NUMERIC_VALUE_INDEX_DDL` exposes the same definition used by migrations and index rebuilding.
This index includes history so snapshot-pinned pages can use it. Creation scans existing facts
and can block writes; see [migration rollout](../../docs/host-integration.md#host-controlled-migrations).
No application-specific index declaration is needed for actor due-work queries. Arbitrary portable
consumer index declarations remain outside this API; see [scope and query plans](../../docs/datalog-performance.md#numeric-ranges-and-actor-due-work).

MIT © 2026 Ben Jacobson.
