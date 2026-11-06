# @triplex-build/triplex-testkit

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

- cb4a12c: Add opt-in sensitive attribute values. `Attribute.sensitive` marks an attribute in its
  content-addressed config node. The new `@triplex-build/triplex/sensitive` entrypoint provides
  `Sensitive.layer`, a `Triples` decorator that seals sensitive values through a pluggable
  `ValueCodec` before storage. It ships an AES-256-GCM reference codec over WebCrypto with a keyed
  blind index, a non-confidential identity codec for development, and test-only `KeyProvider` keys
  with rotation and destruction. Reads, the journal and snapshots return sealed values, and
  `Sensitive.open` is the only path to plaintext. Datalog, uniqueness and derivations support
  presence and blind-token equality; projections, ordering, predicates, aggregates, rules and joins
  with plaintext fail during planning with `SensitiveQueryError`.

  `TripleValue`, `ValueType` and `Triple["value"]` gain the `sealed` variant, and Datalog typed
  constants gain `{ type: "blind" }`. Code that switches exhaustively over `value.type` must handle
  `sealed`. SQL migration v3 adds `value_sealed`, `value_blind` and `idx_attr_blind`. PostgreSQL
  widens its value-type check in place; SQLite rebuilds the `triples` table, which takes time
  proportional to its size. `Migration` gains optional per-dialect statements, and `runMigrations`
  applies each migration atomically. HTTP renders sensitive fields as a `$sealed` marker and refuses
  sensitive writes without the decorator. The CLI prints sealed values without ciphertext or blind
  tokens. The testkit exports sealed-value conformance cases and plaintext-scan helpers.

### Patch Changes

- 20bc2a4: Provision a shared numeric/datetime expression index through an additive SQL migration, enabling
  Datalog range scans for live and snapshot-pinned actor due-work queries without application DDL.
  Preserve numeric comparison semantics and add shared backend conformance coverage for due-work
  ordering, limits, temporal visibility, and continuation after retraction. Existing SQL databases
  must apply migration v2; creating the index scans existing numeric history and can block writes.
- 458d699: Update the published package READMEs to reflect npm availability and supported installation paths.
- 44892c4: Declare Effect and its platform and SQL companions as compatible peer ranges so
  applications can share one runtime. Keep exact development versions for repository
  tests. Consumers of the CLI, SQLite and PostgreSQL packages must provide their
  platform and SQL adapter peers alongside Effect.
- Updated dependencies [405f798]
- Updated dependencies [b26bfb2]
- Updated dependencies [bfe0d2e]
- Updated dependencies [108196e]
- Updated dependencies [023aecd]
- Updated dependencies [dd72143]
- Updated dependencies [458d699]
- Updated dependencies [44892c4]
- Updated dependencies [cb4a12c]
  - @triplex-build/triplex@0.3.0

## 0.2.0

### Minor Changes

- 34b16bb: Add a public runtime composition API with structured database scopes, explicit capability
  dependencies, deterministic fixtures, and a testkit conformance helper. Separate SQL raw queries
  from the portable storage contract and expose SQL snapshot and executor layers.

  Move Cloudflare runtime composition to public APIs and add an additive snapshot-table migration.
  Cloudflare convenience-layer pagination scopes now use the versioned identity encoding; clients
  must restart pagination after upgrading. Snapshot capabilities now use committed journal changes
  to materialize entities affected by broad pattern retractions.

### Patch Changes

- Updated dependencies [34b16bb]
  - @triplex-build/triplex@0.2.0

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
