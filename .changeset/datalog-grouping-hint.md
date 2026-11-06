---
"@triplex-build/triplex": patch
---

Explain `and` grouping and multi-clause `or` alternatives in Datalog preflight errors. Queries such
as `["or", [[c1, c2], [c3]]]` or `["not", ["and", ...]]` now fail with a message naming the clause
and the supported shape instead of a schema union dump.
