---
"@triplex-build/triplex": minor
"@triplex-build/triplex-sql": minor
"@triplex-build/triplex-sqlite": minor
"@triplex-build/triplex-postgres": minor
"@triplex-build/triplex-testkit": minor
"@triplex-build/triplex-cli": minor
"@triplex-build/triplex-http": minor
---

Require the tested Effect 4.1.1 peer and align the platform, SQL, and Vitest
companions. Upgrade the dashboard and embedded documentation explorer to Foldkit
0.170.0 and its Vite plugin to 0.29.0, removing the previous adapter overrides and
peer exceptions now that Foldkit accepts Effect 4.1.

Require Node.js 22.19.0 or newer for the CLI to match the Node platform adapters.

Refresh served OpenAPI snapshots for Effect 4.1 schema deduplication and encoded
query-parameter schema generation.
