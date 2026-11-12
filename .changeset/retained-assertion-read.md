---
"@triplex-build/triplex": minor
---

Add `Triples.assertion(id)` for retained assertions, including retraction metadata.
Breaking: KV `Triples.get(id)` now returns only unretracted assertions, matching
SQL. Use `assertion(id)` for the former historical lookup behavior. Custom
`TriplesService` implementations must add `assertion`; custom storage adapters
must honor the optional `includeRetracted` argument to `getById`.
