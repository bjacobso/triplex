---
"@triplex-build/triplex": minor
---

Add `Triples.liveFacts(entityId)`, an indexed read of unretracted assertions across all valid time, and use it for command `tx.get` entity-state observations. Sensitive and commit-validation decorators preserve sealed values through this read. Existing KV stores require the existing `KvTriples.migrateLiveFacts` backfill.

Custom `TriplesService` and `StorageAdapterService` implementations must implement the new `liveFacts` method.
