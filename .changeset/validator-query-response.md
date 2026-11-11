---
"@triplex-build/triplex": minor
"@triplex-build/triplex-testkit": patch
---

Return `QueryResponse` from `CommitValidation.View.query`, matching the complete
`Triples.queryAll` read. This is a breaking change: validator callers must read
bindings from `response.results` instead of using the returned value as an array.
The read remains complete at its fixed commit cut and has no continuation cursor.
Update shared backend validator conformance to cover this response contract.
