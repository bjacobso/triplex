---
"@triplex-build/triplex": minor
---

Add `Sensitive.erase`, which completes an erasure: it destroys a subject's data keys through `KeyCustody` (one
key class or all), removes the blind token of every fact sealed under them, current or retracted, and records one
journaled erasure transaction with its actor and command ID that names the subject and key class but no
attribute or value. Afterwards opening fails with `key-destroyed`, presence still matches, and equality, joins
and uniqueness no longer do. Repeating the command ID resumes an interrupted erasure. `Triples` gains the optional
`scrubBlindTokens` maintenance operation, implemented by the in-memory KV, SQLite and PostgreSQL stores; on
Cloudflare and FoundationDB `Sensitive.erase` fails with `SensitiveErasureError` (`unsupported`). The testkit adds
`makeErasureSuite`, `erasureCases` and `erasureConformanceLayer`.
