---
"@triplex-build/triplex": minor
---

Add the browser-safe `live-query` subpath with scoped `LiveQuery.watch`, complete exact-cut snapshots, resume tokens, deadline scheduling, optional coalescing and pull backpressure. Export a shared KV/SQLite/PostgreSQL observation corpus from testkit.

Subscription invalidation now treats dynamic attributes as database-wide and uses proven per-attribute subject sets. Manually constructed `QueryDependencies` without this optional proof conservatively invalidate all subjects of a matching attribute; namespace/type heuristics no longer narrow dynamic reads.
