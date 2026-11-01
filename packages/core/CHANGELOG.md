# @triplex-build/triplex

## 0.3.0

### Minor Changes

- 023aecd: Require the tested Effect 4.1.1 peer and align the platform, SQL, and Vitest
  companions. Upgrade the dashboard and embedded documentation explorer to Foldkit
  0.170.0 and its Vite plugin to 0.29.0, removing the previous adapter overrides and
  peer exceptions now that Foldkit accepts Effect 4.1.

  Require Node.js 22.19.0 or newer for the CLI to match the Node platform adapters.

  Refresh served OpenAPI snapshots for Effect 4.1 schema deduplication and encoded
  query-parameter schema generation.

- dd72143: Require the tested Effect 4.0.3 peer version and migrate SQL, HTTP, HTTP API, CLI,
  and Base64Url encoding imports to Effect 4 stable. Upgrade the workspace dashboard
  and embedded documentation explorer to Foldkit 0.168.0.

  Use native branded-ID constructors, preserve closed runtime schemas with explicit
  property-name checks, and normalize SQL numeric and timestamp values returned by
  the new drivers. Refresh OpenAPI snapshots for stable Effect's schema generation.

### Patch Changes

- 405f798: Describe Triplex as the database that remembers why, and link the agent modeling guide and the
  `llms.txt` documentation index from the package README.
- 458d699: Update the published package READMEs to reflect npm availability and supported installation paths.
- 44892c4: Declare Effect and its platform and SQL companions as compatible peer ranges so
  applications can share one runtime. Keep exact development versions for repository
  tests. Consumers of the CLI, SQLite and PostgreSQL packages must provide their
  platform and SQL adapter peers alongside Effect.

## 0.2.0

### Minor Changes

- 34b16bb: Add a public runtime composition API with structured database scopes, explicit capability
  dependencies, deterministic fixtures, and a testkit conformance helper. Separate SQL raw queries
  from the portable storage contract and expose SQL snapshot and executor layers.

  Move Cloudflare runtime composition to public APIs and add an additive snapshot-table migration.
  Cloudflare convenience-layer pagination scopes now use the versioned identity encoding; clients
  must restart pagination after upgrading. Snapshot capabilities now use committed journal changes
  to materialize entities affected by broad pattern retractions.

## 0.1.0

### Minor Changes

- 8bd86f8: Add a backend-neutral HTTP package that derives runtime schemas, OpenAPI, versioned REST CRUD, and
  atomic handlers from persisted Triplex configuration. Add exact-cut entity pagination and
  entity-state transaction preconditions to the public core service.
- fb53ec6: Publish the initial Triplex package family.

  Triplex provides an Effect-native bitemporal fact database, portable Datalog, a causal transaction
  journal, content-addressed typed configuration, graph constraints, derivations with provenance,
  SQLite and PostgreSQL storage, reusable backend conformance tests, and an agent-oriented CLI.

### Patch Changes

- 313542f: Fix large in-memory KV range collection and all-`0xff` key increments, and make the CLI's pre-1.0
  status explicit in help output. Preserve typed HTTP responses when synchronous request validation
  rejects malformed temporal parameters or cursors.
