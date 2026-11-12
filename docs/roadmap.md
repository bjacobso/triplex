# Triplex roadmap

The [current state](/current-state) lists shipped behavior and backend maturity. The
[Database client](/database), typed reads and `asOf`, command preview, `why`, live queries,
Datalog interval patterns and all-valid-time reads, stable error diagnostics, schema-bound
queries, temporal change verbs, chainable modifiers, CLI describe/why/preview and the private
MCP server have shipped. They are foundations for the work below, rather than future promises.

## Next: durable runner

The runner is designed, not built. Its approved design is in the
[runner RFC](https://github.com/bjacobso/triplex/blob/main/docs/rfcs/runner.md).
It will be a `/runner` subpath after the single-package work lands.

The design follows the ordered journal and replays valid-time boundaries while offline, using
commit-first ties and a monotonic valid-time frontier. One diff handler per registration starts
from current state, persists progress, and drains before removal. Delivery is at least once;
handlers use stable command IDs for idempotency. Version one assumes one active runner process
per world, supervised by the host, with no distributed leases or poison-discard API. Retry and
candidate limits need measurements against WorldVM. The initial implementation reuses live-query
planning; a shared coordinator is deferred until there is a concrete need.

[Live queries](/live-queries) already deliver position-pinned snapshots and temporal wakeups for
interactive consumers. They do not replace this durable execution boundary.

## Release and operational evidence

- Verify tokenless trusted publishing and registry-only installation with peer dependencies,
  provenance, CLI and exports. The single-package distribution work is tracked separately;
  this site does not claim it has shipped.
- Continue backend conformance with each query-engine regression. Validate migrations, durability,
  isolation, backup/restore and capability behavior under real host operation; passing shared
  tests alone does not establish those guarantees.
- Keep PostgreSQL a pre-1.0 production candidate until operational use establishes its migration,
  observability and scale characteristics.

## Remaining limitations to address

- Sensitive-value maintenance: scrubbing erased subjects' blind tokens, data-key rewrapping,
  blind-key rotation and explicit host opt-in to opening values in configuration evaluation.
- Broader exact provenance and structured negative witnesses for explanations, with no claim of
  complete support for recursive rules, aggregation or arbitrary Datalog.
- Query performance work driven by measured workloads. A position-allocator redesign waits for
  evidence and an atomic multi-scope design, rather than weakening journal ordering prematurely.

## Backend and API policy

New surface targets in-memory KV, SQLite and PostgreSQL. KV and SQLite are supported;
PostgreSQL remains a pre-1.0 production candidate. Cloudflare and FoundationDB are experimental
and frozen: keep them compiling and preserve their existing tests, without requiring new feature
coverage. Credentialed Cloudflare rollout and failure drills remain outstanding.

Triplex is greenfield before 1.0. Public API breaks are allowed when they improve the model;
update callers and record them in Changesets rather than keeping compatibility shims.

Authorization stays with the host. Full-text search, client sync, new backends, a cost-based
optimizer, a Promise API and a new query language are outside the current plan.
