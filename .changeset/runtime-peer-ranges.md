---
"@triplex-build/triplex": patch
---

Declare Effect and its platform and SQL companions as compatible peer ranges so
applications can share one runtime. Keep exact development versions for repository
tests. Consumers of the CLI, SQLite and PostgreSQL packages must provide their
platform and SQL adapter peers alongside Effect.
