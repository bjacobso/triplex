# Current state

This document is the concise maturity contract for Triplex as of November 2026. The README
explains how to use the system, [Host integration](/host-integration) defines application
boundaries, [Custom runtimes](/custom-runtimes) defines adapter composition, and the roadmap tracks
work that is not complete.

## Delivered

- One `Triples` service for atomic writes, triple-pattern reads, batched entity reads, history,
  raw Datalog, stable query pages, fixed and all-attribute dependency state, indexed recorded-basis
  resolution, and the ordered transaction journal.
- First-class bitemporality. Facts have independent recorded and valid intervals, and direct reads
  and Datalog use one shared temporal basis.
- Atomically unique command receipts, causal metadata, typed assertion/retraction changes, commit
  positions, compare-and-retract preconditions, indexed snapshot-stable entity timelines, and
  durable consumer checkpoints.
- Backend-independent Datalog semantics for patterns, joins, predicates, negation, disjunction,
  aggregates, ordering, pagination, and the intentionally constrained binary recursive-rule form.
  Query preflight rejects unsupported or ambiguous programs before backend execution.
- Immutable entity snapshots as a projection, distinct from immutable configuration release
  snapshots.
- Public `Runtime.define` and `Runtime.fromKv` builders, structured `DatabaseScope` identities,
  typed capability providers, deterministic fixtures, and a testkit `runtimeConformance` helper.
  Snapshot and emitter providers are explicit requirements; base stores use `Capabilities.none`.
- A browser-safe canonical encoding and domain-separated SHA-256 `ContentId` foundation shared by
  entity snapshots, config graphs, derivations, validation observations, and decisions.
- Typed configuration nodes, catalogs, releases, refs, impact queries, reactors, evaluation proofs,
  an immutable in-memory reference store, and a transactional Triples-backed `ConfigStore`.
- An ontology DSL that separates global attribute identity/type from usage-local requiredness,
  cardinality, uniqueness, and reference-target constraints.
- Queryable validation observations plus opt-in atomic enforcement of required, cardinality,
  uniqueness, and reference-target constraints.
- [Commit validators](/commit-validators): host checks inside the transaction boundary over
  db-before and db-after views, with typed rejections, runtime-wide installation for every write
  path, and optional durable rejection records. Shared conformance covers KV, SQLite, PostgreSQL,
  and Cloudflare.
- Content-addressed Datalog derivations with explicit candidate identity, source provenance,
  immutable materialization runs, freshness positions, temporal wakeups, pure reconciliation, and
  read-only hypothetical overlays.
- Standalone demos for basic linked facts and the application-owned compliance/work boundary, plus
  a Foldkit/Tailwind browser dashboard that exercises facts, reflected entity-type tables,
  config-rendered form previews, raw Datalog, derivations, the journal, and full configuration
  object/revision/release history through one app-lifetime Effect layer.
- Opt-in sensitive attribute values. `Attribute.sensitive` marks an attribute in its
  content-addressed node. `Sensitive.layer` decorates any `Triples` so a pluggable `ValueCodec`
  seals values before storage: a reference AES-256-GCM codec over WebCrypto with a keyed
  blind index, or a non-confidential identity codec for development. Reads, the journal,
  snapshots, the CLI, the dashboard and HTTP return sealed values, and `Sensitive.open` is the only
  path to plaintext. Datalog, uniqueness and derivations support presence and blind equality; every
  other use of a sealed value fails during planning with `SensitiveQueryError`. SQL migration v3 and
  Cloudflare migration v4 add the ciphertext and blind-index columns. KV, SQLite, PostgreSQL and
  Cloudflare pass shared sealed-value conformance and raw-storage plaintext scans. See
  [Sensitive values](/sensitive-values).
- An Effect v4 agent CLI with schema-decoded commands and stable JSON output for SQLite and
  PostgreSQL. It explores entities, bitemporal facts, Datalog, causal history, configuration
  revisions/releases/refs/impact, applies attributed idempotent transactions, and moves refs.
- A backend-neutral configuration-derived HTTP package with exact-keyword runtime schemas, REST
  CRUD, OpenAPI, immutable version resolution, host authorization, bounded exact-cut pages, and
  atomic constraint-enforced writes over both in-memory KV and SQLite.
- A baseline SQL v1 migration, additive v2 numeric range index, host-owned migration entrypoints, Changesets configuration and
  release automation, dist-only exports, package tarball checks (including the installed CLI), and
  Effect dependencies aligned through the root pnpm catalog.
- Additive Cloudflare v2 snapshot and v3 numeric index migrations, and a Cloudflare runtime implementation
  using only public core and SQL exports. Existing facts are preserved; snapshot backfill is
  explicit, and pre-upgrade Cloudflare pagination cursors must be restarted.
- PostgreSQL layers for standalone pools, an ambient host-owned `SqlClient`, and validated
  database-scoped pools. Ambient composition shares Effect SQL's fiber-local transaction so host
  rows, Triplex facts/journal, command claims, commit positions, and host outbox rows commit or roll
  back together without an internal second pool.
- The VitePress documentation is published as a Cloudflare assets-only Worker through the
  repository's Effect-native Alchemy stack at <https://triplex.build>.
- A portable host subpath now defines immutable tenant database identity, authorization,
  CAS lifecycle contracts, route fencing, and a schema-decoded v1 data protocol. The Cloudflare
  package exposes a complete `CloudflareTriples` layer using one Durable Object SQLite handle for
  storage and Datalog, and passes the shared backend corpus both in its native-SQL harness and in
  workerd against a real SQLite-backed Durable Object.
- A private Cloudflare reference host wires an authenticated gateway, a durable CAS registry, one
  SQLite Durable Object per database, idempotent provisioning, suspension/resume/deletion fencing,
  request budgets, and a separately state-named Alchemy v2 stack with retention protection. Its
  default workerd test exercises two-tenant isolation, restart persistence, lifecycle fencing, and
  generation-safe recreation.

## Backend and API policy

New surface targets in-memory KV, SQLite and PostgreSQL. KV and SQLite are supported;
PostgreSQL remains a pre-1.0 production candidate. Cloudflare and FoundationDB are frozen,
experimental backends: they must keep compiling and their existing tests must keep passing,
but new features do not have to cover them.

Triplex is greenfield before 1.0. Breaking public API changes are allowed when they make the API
right. Update callers and record each break in a Changeset rather than retaining compatibility
shims, deprecations or opt-in flags for old shapes.

## Backend maturity

| Backend       | Bitemporal `Triples` | Shared conformance | Default CI | Intended use today             |
| ------------- | -------------------- | ------------------ | ---------- | ------------------------------ |
| In-memory KV  | Yes                  | Yes                | Yes        | Tests, browser, ephemeral data |
| SQLite        | Yes                  | Yes                | Yes        | Supported local persistence    |
| PostgreSQL    | Yes                  | Yes                | Yes        | Pre-1.0 production candidate   |
| Cloudflare DO | Yes                  | Harness + workerd  | Yes        | Experimental, frozen           |
| FoundationDB  | Yes                  | Native + shared    | Yes        | Experimental, frozen           |

PostgreSQL includes validated logical database IDs, deterministic safely quoted schema names, and
per-pool-connection schema binding. Its host-owned-client and database-scoped paths are covered by
Docker integration tests in CI, including rollback and concurrent multi-connection isolation. It
remains a pre-1.0 production candidate until operational use establishes its backup, migration,
observability, and scale characteristics.

Cloudflare now has the complete one-line `Triples` composition and passes the shared corpus against
both a fast Durable Object API-compatible native SQLite harness and Cloudflare's workerd runtime.
The reference host also passes its local workerd isolation and restart corpus. It remains
experimental until credentialed deployment, upgrade, retention, limit, and provider-failure gates
pass. The host and Alchemy stack have not been promoted or published. FoundationDB requires a
non-empty subspace by default and scopes clears to it, but still depends on native infrastructure
for local opt-in runs. CI now provisions a pinned client and runs the shared
Triples/sensitive corpora, native watches, cursor isolation and backfill tests.
It remains experimental; these tests do not establish production operations or scale.

## Honest limitations

- The single `@triplex-build/triplex` package replaces the original seven public packages.
  The GitHub repository is `bjacobso/triplex`; see [releasing](/releasing) for old-name deprecations.
- The superseded `@bjacobso` bootstrap packages are not the installation path for new consumers.
- `SubscriptionManager` discovers dependencies and reports possible invalidations. It does not
  push result deltas or automatically re-run queries.
- Entity snapshots, validation results, and derivation materializations are projections. Callers
  must inspect their source position and freshness; projection failure cannot roll back an already
  committed source transaction.
- Public runtime composition does not include automatic durable KV snapshot persistence. The
  shared Triples conformance suite does not certify capability behavior, crash durability,
  cross-process isolation, or migration safety.
- Exact derivation provenance currently supports patterns, predicates, and negation. Recursive
  rules, disjunction, aggregation, pagination, dynamic attributes, and transaction-binding clauses
  are rejected where a complete explanation cannot be preserved.
- Sensitive values: crypto-shredding is limited to key destruction; scrubbing an erased subject's
  blind tokens, rewrapping ciphertext under new keys and rotating the blind key are designed but
  not built. `KeyProvider.test` keys are for tests only; production hosts supply their own
  `KeyProvider`. Range, ordering, aggregation and comparison over sealed values are intentionally
  unsupported.
- Config decision verification proves internal content integrity given a trusted decision root. It
  does not independently prove that an external actor chose the right rule or answer.
- Constraint enforcement is opt-in and serialized through the commit-position boundary. Direct
  adapter writes, authorization, general Datalog invariants, inbox/outbox delivery, timers, retries,
  and application workflow lifecycle are host responsibilities. Hosts can enforce authorization and
  invariants atomically with commit validators, but Triplex ships no policy grammar. Validators run
  while the commit is serialized, and on Cloudflare they must be synchronous.
- The HTTP API intentionally omits PATCH, filters, relationship expansion, raw Datalog, writable
  historical schemas, automatic migrations, empty entities, and mutation of scheduled facts.
- The schema is intentionally greenfield. Databases created by pre-baseline development builds
  must be recreated or migrated by application-owned tooling.
- The Cloudflare host is a reference implementation, not a production support claim. Backup and
  restore, provider limit measurements, staged migration/rollout drills, credentialed Alchemy
  reconciliation, and lost-acknowledgement/node-failure exercises remain explicit gates.

## Release follow-up

1. Configure npm trusted publishing for the single package and verify a tokenless `next` publish.
2. Verify the single package in a clean registry-only consumer, including peer dependencies,
   provenance, CLI, and exports.
3. Deprecate the superseded `@bjacobso` canaries with migration guidance.

Cloudflare and FoundationDB ship as experimental, frozen subpaths in the single package.
Their implementation workspaces stay private and are excluded from Changesets.

The six pre-stable `@bjacobso` canary packages must be deprecated after the corresponding
single `@triplex-build/triplex` release is available. The old artifacts remain available so existing
canary installs receive a migration message instead of breaking.
