# @triplex-build/triplex-sqlite

## 0.1.2

### Patch Changes

- 458d699: Update the published package READMEs to reflect npm availability and supported installation paths.
- Updated dependencies [458d699]
  - @triplex-build/triplex@0.2.1
  - @triplex-build/triplex-sql@0.2.1

## 0.1.1

### Patch Changes

- 34b16bb: Add a public runtime composition API with structured database scopes, explicit capability
  dependencies, deterministic fixtures, and a testkit conformance helper. Separate SQL raw queries
  from the portable storage contract and expose SQL snapshot and executor layers.

  Move Cloudflare runtime composition to public APIs and add an additive snapshot-table migration.
  Cloudflare convenience-layer pagination scopes now use the versioned identity encoding; clients
  must restart pagination after upgrading. Snapshot capabilities now use committed journal changes
  to materialize entities affected by broad pattern retractions.

- Updated dependencies [34b16bb]
  - @triplex-build/triplex@0.2.0
  - @triplex-build/triplex-sql@0.2.0

## 0.1.0

### Minor Changes

- fb53ec6: Publish the initial Triplex package family.

  Triplex provides an Effect-native bitemporal fact database, portable Datalog, a causal transaction
  journal, content-addressed typed configuration, graph constraints, derivations with provenance,
  SQLite and PostgreSQL storage, reusable backend conformance tests, and an agent-oriented CLI.

### Patch Changes

- Updated dependencies [8bd86f8]
- Updated dependencies [fb53ec6]
- Updated dependencies [313542f]
  - @triplex-build/triplex@0.1.0
  - @triplex-build/triplex-sql@0.1.0
