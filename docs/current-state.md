# Current state

This document is the concise maturity contract for Triplex as of September 2026. The README
explains how to use the system, the architecture document defines dependency boundaries, and the
roadmap tracks work that is not complete.

## Delivered

- One `Triples` service for atomic writes, triple-pattern reads, batched entity reads, history,
  raw Datalog, stable query pages, dependency state, and the ordered transaction journal.
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
- A browser-safe canonical encoding and domain-separated SHA-256 `ContentId` foundation shared by
  entity snapshots, config graphs, derivations, validation observations, and decisions.
- Typed configuration nodes, catalogs, releases, refs, impact queries, reactors, evaluation proofs,
  an immutable in-memory reference store, and a transactional Triples-backed `ConfigStore`.
- An ontology DSL that separates global attribute identity/type from usage-local requiredness,
  cardinality, uniqueness, and reference-target constraints.
- Queryable validation observations plus opt-in atomic enforcement of required, cardinality,
  uniqueness, and reference-target constraints.
- Content-addressed Datalog derivations with explicit candidate identity, source provenance,
  immutable materialization runs, freshness positions, temporal wakeups, pure reconciliation, and
  read-only hypothetical overlays.
- Standalone demos for basic linked facts and the application-owned compliance/work boundary, plus
  a Foldkit/Tailwind browser dashboard that exercises facts, reflected entity-type tables,
  config-rendered form previews, raw Datalog, derivations, the journal, and full configuration
  object/revision/release history through one app-lifetime Effect layer.
- An Effect v4 agent CLI with schema-decoded commands and stable JSON output for SQLite and
  PostgreSQL. It explores entities, bitemporal facts, Datalog, causal history, configuration
  revisions/releases/refs/impact, applies attributed idempotent transactions, and moves refs.
- A backend-neutral configuration-derived HTTP package with exact-keyword runtime schemas, REST
  CRUD, OpenAPI, immutable version resolution, host authorization, bounded exact-cut pages, and
  atomic constraint-enforced writes over both in-memory KV and SQLite.
- One greenfield SQL v1 migration, host-owned migration entrypoints, Changesets configuration and
  release automation, dist-only exports, package tarball checks (including the installed CLI), and
  Effect dependencies aligned through the root pnpm catalog.
- PostgreSQL layers for standalone pools, an ambient host-owned `SqlClient`, and validated
  database-scoped pools. Ambient composition shares Effect SQL's fiber-local transaction so host
  rows, Triplex facts/journal, command claims, commit positions, and host outbox rows commit or roll
  back together without an internal second pool.
- The VitePress documentation is published as a Cloudflare assets-only Worker through the
  repository's Effect-native Alchemy stack at <https://triplex.build>.
- A private portable host package now defines immutable tenant database identity, authorization,
  CAS lifecycle contracts, route fencing, and a schema-decoded v1 data protocol. The Cloudflare
  package exposes a complete `CloudflareTriples` layer using one Durable Object SQLite handle for
  storage and Datalog, and passes the shared backend corpus both in its native-SQL harness and in
  workerd against a real SQLite-backed Durable Object.
- A private Cloudflare reference host wires an authenticated gateway, a durable CAS registry, one
  SQLite Durable Object per database, idempotent provisioning, suspension/resume/deletion fencing,
  request budgets, and a separately state-named Alchemy v2 stack with retention protection. Its
  default workerd test exercises two-tenant isolation, restart persistence, lifecycle fencing, and
  generation-safe recreation.

## Backend maturity

| Backend       | Bitemporal `Triples` | Shared conformance | Default CI | Intended use today             |
| ------------- | -------------------- | ------------------ | ---------- | ------------------------------ |
| In-memory KV  | Yes                  | Yes                | Yes        | Tests, browser, ephemeral data |
| SQLite        | Yes                  | Yes                | Yes        | Supported local persistence    |
| PostgreSQL    | Yes                  | Yes                | Yes        | Pre-1.0 production candidate   |
| Cloudflare DO | Yes                  | Harness + workerd  | Yes        | Experimental reference hosting |
| FoundationDB  | Yes                  | Native opt-in      | No         | Experimental                   |

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
outside the normal test matrix.

## Honest limitations

- The seven public packages are prepared for coordinated publication under the `@triplex-build`
  organization scope. Stable `0.1.0` has not been published. The GitHub repository is
  `bjacobso/triplex`, and the local `origin` uses that canonical URL.
- npm assigned the package family's first bootstrap snapshot to `latest` as well as `next`, and the
  registry rejects removing the only `latest` tag. Consumers must request `@next` explicitly until
  stable `0.1.0` replaces it.
- `SubscriptionManager` discovers dependencies and reports possible invalidations. It does not
  push result deltas or automatically re-run queries.
- Entity snapshots, validation results, and derivation materializations are projections. Callers
  must inspect their source position and freshness; projection failure cannot roll back an already
  committed source transaction.
- Exact derivation provenance currently supports patterns, predicates, and negation. Recursive
  rules, disjunction, aggregation, pagination, dynamic attributes, and transaction-binding clauses
  are rejected where a complete explanation cannot be preserved.
- Config decision verification proves internal content integrity given a trusted decision root. It
  does not independently prove that an external actor chose the right rule or answer.
- Constraint enforcement is opt-in and serialized through the commit-position boundary. Direct
  adapter writes, authorization, general Datalog invariants, inbox/outbox delivery, timers, retries,
  and application workflow lifecycle are host responsibilities.
- The HTTP API intentionally omits PATCH, filters, relationship expansion, raw Datalog, writable
  historical schemas, automatic migrations, empty entities, and mutation of scheduled facts.
- The schema is intentionally greenfield. Databases created by pre-baseline development builds
  must be recreated or migrated by application-owned tooling.
- The Cloudflare host is a reference implementation, not a production support claim. Backup and
  restore, provider limit measurements, staged migration/rollout drills, credentialed Alchemy
  reconciliation, and lost-acknowledgement/node-failure exercises remain explicit gates.

## First-release gates

1. Merge the initial Changesets version PR, which advances the public packages from `0.0.0` to
   `0.1.0`.
2. Publish the scoped stable packages together and verify their peer dependency, provenance, CLI,
   and exports behavior from the registry.

Cloudflare and FoundationDB are private for the first release. Their source stays in the monorepo
and continues to compile, but Changesets cannot publish them accidentally.

The six pre-stable `@bjacobso` canary packages must be deprecated after the corresponding
`@triplex-build` stable packages are available. The old artifacts remain available so existing
canary installs receive a migration message instead of breaking.
