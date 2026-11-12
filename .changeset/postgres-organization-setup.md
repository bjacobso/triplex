---
"@triplex-build/triplex": patch
---

Fix two PostgreSQL problems when a host creates many organization databases at once. Each
database schema is now created on a separate connection before its schema-bound pools open.
Before, a pooled connection that opened before the schema existed could create migration tables
in `pg_catalog` and fail with "permission denied to create pg_catalog.triplex_schema_migrations".
Closing the database manager now also closes every cached database's connection pools; before,
they stayed open until the process exited.
