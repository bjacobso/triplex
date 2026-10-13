# @triplex-build/triplex-cli

## 0.2.0

### Minor Changes

- dd72143: Require the tested Effect 4.0.3 peer version and migrate SQL, HTTP, HTTP API, CLI,
  and Base64Url encoding imports to Effect 4 stable. Upgrade the workspace dashboard
  and embedded documentation explorer to Foldkit 0.168.0.

  Use native branded-ID constructors, preserve closed runtime schemas with explicit
  property-name checks, and normalize SQL numeric and timestamp values returned by
  the new drivers. Refresh OpenAPI snapshots for stable Effect's schema generation.

### Patch Changes

- 458d699: Update the published package READMEs to reflect npm availability and supported installation paths.
- Updated dependencies [405f798]
- Updated dependencies [dd72143]
- Updated dependencies [20bc2a4]
- Updated dependencies [458d699]
  - @triplex-build/triplex@0.3.0
  - @triplex-build/triplex-sql@0.3.0
  - @triplex-build/triplex-sqlite@0.2.0
  - @triplex-build/triplex-postgres@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [34b16bb]
  - @triplex-build/triplex@0.2.0
  - @triplex-build/triplex-sql@0.2.0
  - @triplex-build/triplex-sqlite@0.1.1
  - @triplex-build/triplex-postgres@0.1.1

## 0.1.0

### Minor Changes

- 57e1868: Add `db create`, `list`, `get`, `update`, `clear`, and `delete` commands for managed SQLite and
  PostgreSQL databases. Allow `--database-id` to select managed SQLite databases and document direct
  execution with `npx @triplex-build/triplex-cli`. Pin the compatible Effect Node runtime prerelease so a
  fresh npm install can execute the packaged binary.
- fb53ec6: Publish the initial Triplex package family.

  Triplex provides an Effect-native bitemporal fact database, portable Datalog, a causal transaction
  journal, content-addressed typed configuration, graph constraints, derivations with provenance,
  SQLite and PostgreSQL storage, reusable backend conformance tests, and an agent-oriented CLI.

### Patch Changes

- 313542f: Fix large in-memory KV range collection and all-`0xff` key increments, and make the CLI's pre-1.0
  status explicit in help output. Preserve typed HTTP responses when synchronous request validation
  rejects malformed temporal parameters or cursors.
- Updated dependencies [8bd86f8]
- Updated dependencies [fb53ec6]
- Updated dependencies [313542f]
  - @triplex-build/triplex@0.1.0
  - @triplex-build/triplex-postgres@0.1.0
  - @triplex-build/triplex-sql@0.1.0
  - @triplex-build/triplex-sqlite@0.1.0
