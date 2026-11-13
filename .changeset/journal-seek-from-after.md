---
"@triplex-build/triplex": patch
---

`Triples.transactions({ after })` without `entityIdPrefix` no longer reads the whole transaction
journal. It used to load and decode every transaction on each call and then drop the ones at or
before `after`, so polling "what changed since position N" slowed down as history grew. A page now
seeks straight to `after` and reads only the transactions it returns, on SQLite, PostgreSQL,
Cloudflare and KV. SQL backends use an existing index, so no migration is needed. Custom storage
adapters must implement the new `transactionIdsAfter(after, limit)`, which returns transaction IDs
and positions after `after` in position order.
