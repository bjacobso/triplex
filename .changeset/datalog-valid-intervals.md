---
"@triplex-build/triplex": minor
"@triplex-build/triplex-sql": minor
"@triplex-build/triplex-testkit": minor
"@triplex-build/triplex-sqlite": minor
"@triplex-build/triplex-postgres": minor
---

Add Datalog interval patterns (`{ pattern, valid: { from?, to? } }`) and query-wide
`validTime: "all"` on KV, SQLite, and PostgreSQL. Project assertion bounds directly in native
queries, with `null` for open ends, finite-only ordered comparisons, null-safe equality,
nullable aggregation, stable pagination, sensitive-value analysis, and shared conformance.
All-time mode rejects explicit `validAt` and optional projections. Exact derivation provenance
and hypothetical overlays reject the new temporal forms.

Breaking: Datalog rows with attributes beginning `:_tx/` now follow only the recorded cut,
including variable-attribute scans, negation, disjunction, and rules. Backdated assertions can
join their asserting transaction's actor at a past valid point in one query. Existing metadata
queries may gain rows, negation may remove rows, and counts can change. Direct fact reads keep
their point semantics. There is no legacy mode.

Breaking: query pagination cursors use version 2; restart existing cursors. The executor SPI
accepts a query basis with no valid point for all-time reads.

SQL migration 8 adds non-partial attribute/end and attribute/start history indexes. PostgreSQL
keeps its BIGINT interval columns, avoiding a table rewrite and a precondition-plan regression.
Breaking: assertion bounds and numeric interval-pattern bounds now require integer epoch
milliseconds on every backend; fractional bounds fail with `time.invalid-bound`. KV writers maintain history-preserving interval indexes; queries complete their
resumable backfill before using them. Upgrade all writers before enabling the new query engine.
Cloudflare and FoundationDB remain frozen experimental backends with no new certification.
