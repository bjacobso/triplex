---
"@triplex-build/triplex": minor
---

Consolidate all published APIs into one package. Install `@triplex-build/triplex effect`
and the driver for your backend. Replace imports as follows:

- `@triplex-build/triplex-sql` → `@triplex-build/triplex/sql`
- `@triplex-build/triplex-sqlite` → `@triplex-build/triplex/sqlite`
- `@triplex-build/triplex-postgres` → `@triplex-build/triplex/postgres`
- `@triplex-build/triplex-cloudflare` → `@triplex-build/triplex/cloudflare`
- `@triplex-build/triplex-foundationdb` → `@triplex-build/triplex/foundationdb`
- `@triplex-build/triplex-host` → `@triplex-build/triplex/host`
- `@triplex-build/triplex-http` → `@triplex-build/triplex/http`
- `@triplex-build/triplex-testkit` → `@triplex-build/triplex/testkit`
- `@triplex-build/triplex-testkit/postgres` → `@triplex-build/triplex/testkit/postgres`
- `@triplex-build/triplex-mcp` → `@triplex-build/triplex/mcp`

The `triplex` bin replaces installation of `@triplex-build/triplex-cli`.
Run the former `triplex-mcp` executable as `triplex mcp`; run the prebuilt explorer
with `triplex dashboard`. CLI library exports are internal; MCP's `tools` and
`registrations` are available from `/mcp`. Drivers and Node platform adapters are
optional peers loaded only by their backend subpath or executable. Existing root
and core subpaths retain their paths. Cloudflare and FoundationDB ship as frozen,
experimental backends. Only the unified package is versioned and published.
