---
---

Validate experimental FoundationDB through the shared Triples and sensitive-value corpora, native backfill and raw-key/value scan; repair stale native fixtures and add a native CI gate. Bind FdbTriples cursors to the configured cluster file and subspace instead of the shared default scope. Breaking cursor compatibility: existing opaque FoundationDB cursors must be restarted; stored data needs no migration. FoundationDB is private and remains experimental.
