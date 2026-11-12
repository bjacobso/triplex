# Current state

This document is the concise maturity contract for Triplex as of November 2026. The README
explains how to use the system, [Host integration](/host-integration) defines application
boundaries, [Custom runtimes](/custom-runtimes) defines adapter composition, and the roadmap tracks
work that is not complete.

## Delivered

Start with the [Database client](/database), not raw storage primitives, when building an
application. The following surface is shipped on this branch:

- **Schema-bound commands and reads.** `Database` on the `/database` subpath checks startup
  compatibility against the live release, pins that release at command admission, and enforces
  its constraints. It provides typed entity reads and explicit Effect Schema query projections,
  effectful `asOf` historical views, idempotent receipts, and read-only `preview` of operations,
  changes, violations and derivation candidates. Preview does not commit or reserve a command ID.
- **Ontology and temporal writes.** `SchemaBound` checks queries against a release, rejecting
  unknown attributes before execution. `Type.decode` decodes entity facts through the declared
  aliases. Chainable use modifiers such as `.required().unique()` preserve literal types.
  `Change.end`, `Change.replace`, `Change.correct` and `Change.combine`, and typed entity helpers,
  express temporal edits with their preconditions. See the [modeling guide](/agents).
- **Facts and exact history.** One `Triples` service provides atomic writes, triple reads, Datalog,
  entity pages, history and the ordered transaction journal. `get` is live-only on every backend;
  `assertion(id)` retrieves an assertion even after retraction, including `retractedAt`.
  Indexed `liveFacts(entityId)` avoids replaying an entity's history. `resolveRecordedBasis`
  resolves recorded timestamps to exact commit cuts; `dependencyState` and `dependencyStateAll`
  provide freshness positions and future temporal edges for fixed or all-attribute dependencies.
- **Time in Datalog.** [Datalog](/datalog) supports interval patterns
  (`{ pattern, valid: { from, to } }`) and query-wide `validTime: "all"` alongside ordinary
  point-in-time reads. `:_tx/*` metadata is recorded-only, including at historical valid times.
  Bounds are integer epoch milliseconds; open interval ends are `null`, and ordered predicates
  require finite bounds. Shared KV, SQLite and PostgreSQL coverage checks these semantics.
- **Live results.** [Live queries](/live-queries) expose `LiveQuery.watch` as complete,
  position-pinned snapshots on relevant commits and valid-time boundaries, with resume tokens,
  optional coalescing, pull backpressure and one shared feed reader. They are not durable handlers.
- **Explanations and diagnostics.** [Why](/why) explains facts, attribute values, entities and
  supplied derivation candidates at an exact basis. Public errors have stable codes, offending
  paths and suggested fixes through [diagnose](/errors).
- **Configuration and validation.** Content-addressed nodes, releases, refs, evaluation proofs,
  persisted configuration, queryable validation observations, and atomic requiredness,
  cardinality, uniqueness and reference-target enforcement. [Commit validators](/commit-validators)
  let hosts reject a proposed transaction using read-only before/after views.
- **Derivations and operations.** Content-addressed candidates, immutable freshness-aware
  materializations, temporal wakeups, pure reconciliation, hypothetical overlays, causal
  transaction metadata, atomically unique command receipts and durable consumer checkpoints.
- **Runtime and storage composition.** Public runtime builders, structured database scopes,
  browser-safe content IDs, testkit conformance helpers, immutable entity snapshots, indexed
  snapshot-stable pages, and host-owned SQL migrations. PostgreSQL supports ambient host-owned
  clients and database-scoped pools, allowing host rows and Triplex writes to share a transaction.
- **Sensitive values.** [Sensitive attributes](/sensitive-values), a sealing decorator,
  WebCrypto AES-256-GCM and development identity codecs, blind equality, explicit opening, and
  redacted tooling. Unsupported operations over sealed values fail during planning.
- **Tools.** The [CLI](/tools) offers `why`, live-release `describe`, and `transaction preview`
  beside reads, queries, configuration and attributed writes. The [MCP server](/mcp) exposes the
  same execution path over stdio; it is private and is not published on npm. The dashboard and
  [explorer](/explorer) inspect facts, history, configuration and derivations. The configuration
  HTTP API provides runtime schemas, CRUD, OpenAPI and host authorization.
- **Reference hosting and publishing.** A private Cloudflare reference host exercises tenant
  isolation, lifecycle fencing and restart persistence. Documentation is built with VitePress and
  hosted at <https://triplex.build>. Package builds, tarball consumer checks and Changesets
  release workflows are in place.

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

- Seven public packages are published under the `@triplex-build` organization scope. The GitHub
  repository is `bjacobso/triplex`.
- The superseded `@bjacobso` bootstrap packages are not the installation path for new consumers.
- `SubscriptionManager` only reports possible invalidations; use `LiveQuery.watch` for result
  snapshots. Incremental result deltas are not implemented.
- The durable runner is designed, not built. Journal replay, checkpoints and temporal schedules
  are available as primitives; hosts still own handler execution, retries and delivery.
- `why` does not yet provide structured negative witnesses. Its derivation explanation support
  has the same restricted provenance boundary as derivations.
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

1. Configure npm trusted publishing for all seven packages and verify a tokenless `next` publish.
2. Verify the published packages in a clean registry-only consumer, including peer dependencies,
   provenance, CLI, and exports.
3. Deprecate the superseded `@bjacobso` canaries with migration guidance.

Cloudflare and FoundationDB are private for the first release. Their source stays in the monorepo
and continues to compile, but Changesets cannot publish them accidentally.

The six pre-stable `@bjacobso` canary packages must be deprecated after the corresponding
`@triplex-build` stable packages are available. The old artifacts remain available so existing
canary installs receive a migration message instead of breaking.
