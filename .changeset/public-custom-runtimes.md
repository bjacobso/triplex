---
"@triplex-build/triplex": minor
"@triplex-build/triplex-sql": minor
"@triplex-build/triplex-sqlite": patch
"@triplex-build/triplex-postgres": patch
"@triplex-build/triplex-testkit": minor
---

Add a public runtime composition API with structured database scopes, explicit capability
dependencies, deterministic fixtures, and a testkit conformance helper. Separate SQL raw queries
from the portable storage contract and expose SQL snapshot and executor layers.

Move Cloudflare runtime composition to public APIs and add an additive snapshot-table migration.
Cloudflare convenience-layer pagination scopes now use the versioned identity encoding; clients
must restart pagination after upgrading. Snapshot capabilities now use committed journal changes
to materialize entities affected by broad pattern retractions.
