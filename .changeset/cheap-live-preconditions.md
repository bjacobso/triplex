---
"@triplex-build/triplex": minor
---

Add atomic `AttributeValue`, `AttributeAbsent`, and `EntityAbsent` transaction
preconditions. They check at most two unretracted facts across all valid times,
without loading unrelated attributes or retracted history. Value guards require
exactly one fact and compare canonical typed values; the sensitive decorator uses
blind equality for plaintext guards on sealed attributes.

Breaking pre-1.0 extension: custom `StorageAdapterService` implementations need
`livePreconditionFacts`, and exhaustive precondition switches need three variants.
PostgreSQL SQL migration v6 builds a live expression index and analyzes triples to
avoid historical skew in its query plans; SQLite records v6 without extra DDL and
Cloudflare needs no migration beyond v6. KV adds one live ID key per fact. Existing
KV stores must upgrade all writers and run bounded `KvTriples.migrateLiveFacts`
batches until complete before using these new guards. Existing APIs keep working
during that backfill, and historical indexes remain unchanged.
