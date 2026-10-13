---
"@triplex-build/triplex": minor
"@triplex-build/triplex-sql": minor
"@triplex-build/triplex-sqlite": minor
"@triplex-build/triplex-postgres": minor
"@triplex-build/triplex-testkit": minor
"@triplex-build/triplex-cli": minor
"@triplex-build/triplex-http": minor
---

Require the tested Effect 4.0.3 peer version and migrate SQL, HTTP, HTTP API, CLI,
and Base64Url encoding imports to Effect 4 stable. Upgrade the workspace dashboard
and embedded documentation explorer to Foldkit 0.168.0.

Use native branded-ID constructors, preserve closed runtime schemas with explicit
property-name checks, and normalize SQL numeric and timestamp values returned by
the new drivers. Refresh OpenAPI snapshots for stable Effect's schema generation.
