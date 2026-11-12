---
"@triplex-build/triplex": minor
---

Expose only the documented services from backend convenience layers. This is a breaking type and runtime change: SQLite's `layer`, `layerMemory`, and `layerMemoryWithScope`, and PostgreSQL's `layer` and `layerFromUrl`, now output only `Triples`. SQLite no longer exposes its SQL client, storage adapter, query executor, dialect, clock, or ID generator through these layers. PostgreSQL standalone layers no longer expose their SQL client or backend-specific client.

PostgreSQL's `layerForDatabase` and `layerForDatabaseMigrated` expose exactly `Triples | SqlClient`, retaining the schema-bound client for host transactions. The ambient-client constructors still require `SqlClient` and output only `Triples`. Compose SQL or implementation layers explicitly when their services are needed.
