---
"@triplex-build/triplex": minor
---

Check the current schema version when acquiring an unmigrated PostgreSQL adapter
or Triples layer. The exported `SchemaVersionError` includes expected and actual
versions and directs hosts to `runMigrations`. Missing histories report version 0;
older and newer schemas are rejected without running DDL. Other SQL failures stay
SQL failures.

This is a pre-1.0 breaking change to acquisition behavior and its typed error
channel: hosts must run migrations before building an unmigrated layer, rather
than inside the application receiving it. No new migration is required; apply
the existing migrations. Auto-migrating conveniences retain their behavior.

Add `postgresSchemaLayer` in `@triplex-build/triplex-testkit/postgres`. It creates,
migrates, and cleans up a per-acquisition schema and supplies a schema-bound pool
and the caller's Triples layer. Install the compatible optional `@effect/sql-pg`
peer when using this subpath; other testkit consumers do not need the driver.
