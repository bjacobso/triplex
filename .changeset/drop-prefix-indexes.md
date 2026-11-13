---
"@triplex-build/triplex": patch
---

SQL migration v13 drops two `triples` indexes that were prefixes of others serving the same reads:
`idx_attribute` (of `idx_attribute_temporal` and `idx_attribute_history`) and `idx_recorded_position` (of
`idx_dependency_all`). On SQLite this saves about 96 bytes per asserted triple and about a tenth of write time;
`idx_entity` is kept because entity reads would otherwise move to an index that includes retracted rows.
Existing SQLite and PostgreSQL databases run the migration on start, or with `runMigrations`.
