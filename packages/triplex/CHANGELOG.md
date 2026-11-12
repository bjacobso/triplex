# @triplex-build/triplex

## 0.3.0

### Minor Changes

- b26bfb2: Accept `validTo` in `Attribute.AssertionOptions` and carry it on the emitted `Attribute.Assertion`,
  so `handle.assertion(value, { validFrom, validTo })` produces a bounded valid interval. Previously
  `validTo` was not part of the options type, and a non-literal options object silently dropped it.
  A non-finite `validTo`, or one not later than `validFrom`, throws.
- dfa9298: Expose raw transaction preview through the database subpath, sharing the client's constraint
  projection and sensitive-value preparation. Add CLI why fact/attribute/entity/candidate and
  transaction preview commands, shared wire schemas, and manifest discovery for CLI and MCP.
  Both capabilities return Diagnostic failures and redact sealed envelopes. No existing API breaks.
- 3b6c09e: Replace CLI and HTTP failure bodies with stable core Diagnostic envelopes.

  CLI failures now emit { ok: false, command, error: Diagnostic } to stderr and exit
  nonzero, including argument and input failures with cli.\* codes. Original causes
  are available only with --debug.

  HTTP failures now emit { error: Diagnostic }, retain existing statuses, and send
  Retry-After: 0 for retryable conflicts. HTTP-owned error class code literals
  change to http.\* codes. OpenAPI describes the diagnostic envelope. Consumers must
  update old top-level code/message body parsing and HTTP error constructors.

- b184b37: Make attribute-use modifiers immutable and chainable in any order while preserving literal
  cardinality and requiredness. Chained and options declarations produce identical configuration
  content IDs, including sensitive attribute definitions.

  Breaking: `Attribute.Use.required` and `Attribute.Use.unique` are now methods. Read the data
  from `isRequired` and `isUnique` instead. `cardinality`, `UseOptions`, and entity-handle data
  fields are unchanged. Modifiers on definitions still accept options; subsequent use modifiers
  are zero-argument calls that preserve the other constraints.

- 021c3e4: Add atomic `AttributeValue`, `AttributeAbsent`, and `EntityAbsent` transaction
  preconditions. They check at most two unretracted facts across all valid times,
  without loading unrelated attributes or retracted history. Value guards require
  exactly one fact and compare canonical typed values; the sensitive decorator uses
  blind equality for plaintext guards on sealed attributes.

  Breaking pre-1.0 extension: custom `StorageAdapterService` implementations need
  `livePreconditionFacts`, and exhaustive precondition switches need three variants.
  PostgreSQL SQL migration v6 builds a live expression index and analyzes triples to
  avoid historical skew in its query plans; SQLite records v6 without extra DDL and
  Cloudflare needs no migration beyond v6. KV adds one live ID key per fact. Existing
  KV stores must upgrade all writers and run bounded `KvTriples.migrateLiveFacts`
  batches until complete before using these new guards. Existing APIs keep working
  during that backfill, and historical indexes remain unchanged.

- 3b6c09e: Add commit validators: host checks that run inside `Triples.transact` after operations and the
  journal envelope are applied and before commit. Validators read `before` and `after` views at
  exact commit positions (entity, match, and complete Datalog) and may return typed rejections that
  fail the whole transaction with `CommitRejectedError`. `TransactionMeta.validate` installs them
  per call; `CommitValidation.layer` decorates any `Layer<Triples>` so every application write path
  runs them, and can durably record rejections as reserved facts after rollback.
  `CommitValidation.recordRejection` and `readRejection` support hosts that roll back an enclosing
  SQL transaction. **Breaking:** `Triples.transact` now includes `CommitRejectedError` in its error channel.
  Exhaustive error handlers must handle it. Commit views also provide read-only, position-bound
  inbox/outbox point and pending reads; rejection rolls back entry appends and acknowledgements. The
  SQLite and PostgreSQL adapters pass the rejection through their transaction boundary, and the
  testkit conformance suite covers validator semantics on every backend. The HTTP
  package maps rejections to `409 commit_rejected`.
- 9f4e703: Make the Triples-backed `ConfigStore` read only what each operation needs. `resolveRef` and
  `snapshotById` read the ref and the objects reachable from the snapshot, cache immutable records
  by identity, and keep decoded trees until `:triplex/valid-under` changes; `commit`, `setRef` and
  `reverseDependencies` no longer load the whole store. `ConfigStore.commit` no longer returns a
  `store`: call `load()` for the whole store.
- dfa9298: Add Datalog interval patterns (`{ pattern, valid: { from?, to? } }`) and query-wide
  `validTime: "all"` on KV, SQLite, and PostgreSQL. Project assertion bounds directly in native
  queries, with `null` for open ends, finite-only ordered comparisons, null-safe equality,
  nullable aggregation, stable pagination, sensitive-value analysis, and shared conformance.
  All-time mode rejects explicit `validAt` and optional projections. Exact derivation provenance
  and hypothetical overlays reject the new temporal forms.

  Breaking: Datalog rows with attributes beginning `:_tx/` now follow only the recorded cut,
  including variable-attribute scans, negation, disjunction, and rules. Backdated assertions can
  join their asserting transaction's actor at a past valid point in one query. Existing metadata
  queries may gain rows, negation may remove rows, and counts can change. Direct fact reads keep
  their point semantics. There is no legacy mode.

  Breaking: query pagination cursors use version 2; restart existing cursors. The executor SPI
  accepts a query basis with no valid point for all-time reads.

  SQL migration 8 adds non-partial attribute/end and attribute/start history indexes. PostgreSQL
  keeps its BIGINT interval columns, avoiding a table rewrite and a precondition-plan regression.
  Breaking: assertion bounds and numeric interval-pattern bounds now require integer epoch
  milliseconds on every backend; fractional bounds fail with `time.invalid-bound`. KV writers maintain history-preserving interval indexes; queries complete their
  resumable backfill before using them. Upgrade all writers before enabling the new query engine.
  Cloudflare and FoundationDB remain frozen experimental backends with no new certification.

- c146b81: Add the browser-safe `/runner` subpath for durable derivation diff handlers, acknowledged candidate
  snapshots, Outbox recovery, bounded retries, scoped supervision and offline temporal boundary replay.
  Publish the ordinary runner control schema, runner conformance helpers and a compliance host using
  schema-bound commands. Add `KvTriples.layerWithClock` for deterministic commit/runner clock wiring.

  Consumer checkpoints now read unretracted facts and write `validFrom: 0`, preserving durable
  progress when the wall clock rolls backwards.

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

- 021c3e4: Add `entityIdPrefix` to `transactions({ after, limit })` and tenant-protocol
  Transactions requests. Filtered pages return complete authoritative records for
  commands touching a matching entity, deduplicate multiple matching entities, and
  preserve global position ordering and exclusive resume cursors. Prefix matching is
  literal and case-sensitive, including Unicode; an explicit empty prefix selects
  transactions with at least one fact change.

  Breaking pre-1.0 adapter extension: custom `StorageAdapterService` implementations
  must add indexed `transactionIdsForEntityPrefix` discovery. SQL migration v7 adds
  PostgreSQL's binary-collation covering journal index and analyzes triples; SQLite
  records v7 without extra DDL. Cloudflare uses its existing reference index and
  needs no additional migration beyond v6. KV reuses its existing changed-entity
  index, with no feed backfill; its candidate work scales with matching prefix
  history, while unrelated transactions are not read. Upgrade the host package too
  when using the new filter through the tenant protocol.

- 3b6c09e: Add entity-level write helpers to the ontology DSL. `EntityType.assert(id, values, options?)`
  builds typed `assert` operations for a whole entity from alias-keyed values, with arrays for
  cardinality-many uses. `Attribute.assertion` and the attribute handles now accept `validTo`, and
  reject non-finite bounds or an empty `[validFrom, validTo)` interval. `GraphConstraint.pinned(release)`
  returns the `configSnapshot` and `enforce` transaction metadata from one release. `Attribute.use`
  now records a literal cardinality in its type, and `assert` is a reserved entity attribute alias.

  Declare attribute uses concisely: attribute definitions now have `.required()`, `.many()`, and
  `.unique()`, and `EntityType.make(name, fields)` accepts aliased fields directly, with a bare
  definition as an optional single-valued use. **Breaking:** the wrapped
  `EntityType.make(name, { attributes: fields })` declaration is removed; pass `fields` directly.
  The compiled node content IDs are unchanged. `Type.where(entity, patterns)` and `Type.not(entity, patterns)` build Datalog
  pattern and negation clauses by alias, with typed constants. `where` and `not` are now reserved
  attribute aliases as well.

  Publish several entity types with `EntityType.nodesOf(...types)`, which deduplicates shared
  attribute nodes by content ID. Sensitive attribute modifiers preserve their sensitive node,
  and query builders use the same blind-token equality as handwritten patterns under
  `Sensitive.layer`. `GraphConstraint.pinned` memoizes enforcement per release root content ID.
  Conditional `validFrom` and `validTo` values may explicitly be `undefined`.

  Breaking type changes: `Attribute.Use` now carries literal cardinality (including changes to
  inferred assignment compatibility), and `assert`, `where`, and `not` are reserved entity
  attribute aliases. Attribute definitions now require the three modifier methods when
  constructed structurally.

- 021c3e4: Expose `recordedPosition` on the shared temporal read basis for entity, batch,
  match, Datalog, and paginated reads. Position zero is the empty cut; positions
  must be non-negative safe integers. Supplying both `recordedAt` and
  `recordedPosition` is rejected. Valid-time behavior is unchanged.
  Position reads also hide later retraction metadata so the returned facts match
  their earlier state; full audit/history reads retain the stored metadata.

  Pages bind the explicit position into their cursor and preserve it across later
  commits. Future positions are capped at the head for paging; omit the basis on
  continuation to reuse that captured cut. Position-only pages do not add a
  wall-clock filter. `EntityPageSnapshot.recordedAt` is consequently optional for
  these new requests, a pre-1.0 source-level change; existing timestamp/default
  requests still return it. Persisted derivations retain the position basis and
  include it in freshness and journal fallback checks.

  SQL migration v4 adds `idx_entity_recorded_position` on entity ID and recorded
  position. Run the existing `runMigrations` entrypoint before acquiring host-owned
  unmigrated layers. Standalone migrating layers apply it automatically. Cloudflare
  uses migration v5 (experimental); KV needs no migration. The testkit now checks
  generated assertion/retraction/replacement histories against captured commit cuts
  on every read surface.

- dfa9298: Add the `why` subpath with the `Why` service for exact-cut explanations of facts,
  attributes, entities and derivation candidates, immutable release attribution and
  bounded command causation. Sensitive values remain sealed.

  Export shared assertion and explanation conformance cases for backend implementors.

- 021c3e4: Preserve `recordedPosition` when forwarding tenant-protocol `Query` and `QueryPage`
  options to Triples. Historical requests now retain their exact commit cut after
  later assertions/retractions, including empty position zero and page continuation.
  Requests supplying both recorded timestamp and position now reach core validation
  and are rejected consistently. HTTP entity and collection reads now expose and validate `recordedPosition` as a
  non-negative safe integer, retain it through cursor continuation, and reject it
  on writes. Generated OpenAPI includes the parameter. Dashboard fact-read helpers
  and entity pages preserve the same position, cap future page cuts at the initial
  head, and continue accepting existing timestamp cursors. No new migration is
  required.
- b184b37: Add `Triples.liveFacts(entityId)`, an indexed read of unretracted assertions across all valid time, and use it for command `tx.get` entity-state observations. Sensitive and commit-validation decorators preserve sealed values through this read. Existing KV stores require the existing `KvTriples.migrateLiveFacts` backfill.

  Custom `TriplesService` and `StorageAdapterService` implementations must implement the new `liveFacts` method.

- dfa9298: Add the browser-safe `live-query` subpath with scoped `LiveQuery.watch`, complete exact-cut snapshots, resume tokens, deadline scheduling, optional coalescing and pull backpressure. Export a shared KV/SQLite/PostgreSQL observation corpus from testkit.

  Subscription invalidation now treats dynamic attributes as database-wide and uses proven per-attribute subject sets. Manually constructed `QueryDependencies` without this optional proof conservatively invalidate all subjects of a matching attribute; namespace/type heuristics no longer narrow dynamic reads.

- 3b6c09e: Read the selected database release in `describe`, defaulting to `live` with a `--ref` override.
  Retain the command manifest and add schema, constraints, config objects, write rules, and attributed,
  release-pinned transaction examples with enforcement. Missing releases return a publishing hint.

  Behavior change: `describe` now opens the selected database and can apply its pending migrations,
  like other data commands; it requires a working database connection.

- b184b37: Expose only the documented services from backend convenience layers. This is a breaking type and runtime change: SQLite's `layer`, `layerMemory`, and `layerMemoryWithScope`, and PostgreSQL's `layer` and `layerFromUrl`, now output only `Triples`. SQLite no longer exposes its SQL client, storage adapter, query executor, dialect, clock, or ID generator through these layers. PostgreSQL standalone layers no longer expose their SQL client or backend-specific client.

  PostgreSQL's `layerForDatabase` and `layerForDatabaseMigrated` expose exactly `Triples | SqlClient`, retaining the schema-bound client for host transactions. The ambient-client constructors still require `SqlClient` and output only `Triples`. Compose SQL or implementation layers explicitly when their services are needed.

- c146b81: Consolidate all published APIs into one package. Install `@triplex-build/triplex effect`
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

- dfa9298: Add `Triples.assertion(id)` for retained assertions, including retraction metadata.
  Breaking: KV `Triples.get(id)` now returns only unretracted assertions, matching
  SQL. Use `assertion(id)` for the former historical lookup behavior. Custom
  `TriplesService` implementations must add `assertion`; custom storage adapters
  must honor the optional `includeRetracted` argument to `getById`.
- 021c3e4: Surface structured PostgreSQL serialization and deadlock failures as
  `TransactionConflictError` rather than wrapping them in `WriteError`. Conflicts
  now expose `isRetryable: true`, an optional `serialization`/`deadlock` reason,
  and the original cause. Existing precondition conflicts retain their identity.

  Add `PgTriples.withTransaction` for typed conflicts spanning host SQL, nested
  Triplex calls, and the outer commit. Other host SQL/domain errors remain unchanged.
  There are no automatic retries; reload state and retry the entire host transaction.
  The allocator and commit-order guarantees are unchanged; no migration is needed.

  This pre-1.0 change widens convenience write methods and adapter transaction error
  channels to include `TransactionConflictError`; the sensitive decorator preserves
  it too. `OverlayError` follows the widened assertion contract. Callers with explicit
  error annotations may need to add this type, and Postgres callers catching only
  `WriteError` for native conflicts should handle `TransactionConflictError` instead.

- 3b6c09e: Add opt-in SchemaBound.layer to check Datalog and constant-attribute match reads against a committed configuration release, resolving movable refs on each call. UnknownAttributeError names the unknown key, clause path, and a nearby known spelling; match preserves its ReadError contract with the typed error in cause. Export pure attributesOf and checkAttributes helpers from the datalog subpath. Existing callers without the layer keep their current behavior. No breaking changes.
- dfa9298: Add the `@triplex-build/triplex/database` subpath with a schema-bound Effect service,
  release compatibility checks, pinned and enforced commands, guarded entity reads,
  idempotent receipt recovery, typed bounded reads and queries, and stable asOf views.

  `Attribute.ref` now retains its runtime target declaration and `EntityType.nodesOf`
  includes transitive reference targets, deduplicated by CID. Existing individual node
  CIDs are unchanged. The resulting nodesOf array can contain additional referenced
  declarations; callers publishing only a partial graph now publish its target closure.
  No existing method is removed, and the root export is unchanged.

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

- dfa9298: Add entity decoding options for distinct-value scalar cardinality, aggregate type membership validation, and detailed value diagnostics while keeping strict defaults. Reuse the core entity decoder for HTTP reads with unchanged response bodies and diagnostics.
- 3b6c09e: Export `diagnose(error)` and `Diagnostic` for stable, JSON-serializable error codes,
  input paths, recovery hints and retryability across public core errors. Datalog
  validation errors now carry optional code, path and fix metadata at their raise
  sites. Constraint details expose only keys, subjects and valid-time instants;
  transaction conflicts distinguish precondition, serialization and deadlock causes.

  No existing public shapes are removed. Error codes are a new public contract;
  callers can branch on them instead of parsing free-text messages.

- 3b6c09e: Add pure `Change.end`, `replace`, `correct`, and `combine` builders with TripleLive guards,
  plus typed EntityType helpers that encode one aliased value. Temporal splits preserve the
  original past and replacement end, and reject invalid split instants with ChangeRangeError.

  Breaking change: EntityType aliases `end`, `replace`, and `correct` are now reserved for
  the new helpers. Rename attributes using those TypeScript aliases; their global keys can stay
  the same.

  Sensitive temporal changes reuse existing ciphertext only when a same-transaction explicit
  retraction identifies a stored fact with the same entity, attribute, envelope and blind token.
  All other sealed inputs remain rejected; plaintext replacements seal through the usual write path.

- dfa9298: Add Database.preview(meta, build, options?) to inspect compiled operations and guards,
  assertion/retraction descriptions, newly introduced graph violations, optional derivation
  candidate diffs, and existing command receipts without committing. Sensitive values remain
  sealed. Preview and command share their builder compiler. No breaking changes.
- dfa9298: Add indexed `Triples.resolveRecordedBasis` and `Triples.dependencyStateAll` reads.
  Resolve recorded timestamps to exact captured commit cuts, including tied instants,
  and read wildcard freshness and valid-time schedules without loading fact payloads.

  Breaking adapter contract: custom Triples services must implement both reads, and
  StorageAdapter implementations must add `recordedPositionAt` and `dependencyStateAll`.
  Apply SQL migration v9 before using these reads with host-owned schemas. Existing KV
  stores build the new read indexes once on opening. Service decorators that spread the
  inner service pass both methods through unchanged.

- ace84f0: Check the current schema version when acquiring an unmigrated PostgreSQL adapter
  or Triples layer. The exported `SchemaVersionError` includes expected and actual
  versions and directs hosts to `runMigrations`. Missing histories report version 0;
  older and newer schemas are rejected without running DDL. Other SQL failures stay
  SQL failures.

  This is a pre-1.0 breaking change to acquisition behavior and its typed error
  channel: hosts must run migrations before building an unmigrated layer, rather
  than inside the application receiving it. No new migration is required; apply
  the existing migrations. Auto-migrating conveniences retain their behavior.

  Add `postgresSchemaLayer` in `@triplex-build/triplex-testkit/postgres`. It creates,
  migrates, and cleans up a per-acquisition schema and supplies a schema-bound pool
  and the caller's Triples layer. Install the compatible optional `@effect/sql-pg`
  peer when using this subpath; other testkit consumers do not need the driver.

- 021c3e4: Add indexed inbox/outbox entries that compose with facts in `transact`, deduplicate
  canonical payloads by scoped idempotency key, page pending work globally or per
  entity, and retain acknowledged history. A different payload for an existing key
  fails atomically with non-retryable `OperationalEntryConflictError`.

  Breaking pre-1.0 extension: `TransactOp` has `append-entry` and `acknowledge-entry`
  variants, `TriplesService` has two new read methods, and `StorageAdapterService`
  requires four entry persistence methods. Update custom implementations, exhaustive
  switches, and explicit transaction error unions. Host-owned SQL must apply migration
  v5 before layer construction; Cloudflare applies v6. KV needs no data migration.
  Payloads are canonical JSON supplied by the host and are outside attribute-based
  sensitive-value policies; hosts seal sensitive contents before appending.

- b184b37: Add Database receipt lookup, paged entity transaction history with alias-discriminated typed changes, and read-only inbox/outbox access with deterministic entry IDs. Receipt and history reads honor the recorded cut of asOf views; operational mailbox reads remain live-only. Sealed journal values remain sealed.
- 3b6c09e: Add Effect-native `EntityType.decode` to materialize visible facts by declaration alias,
  validate stored types and requiredness, reject ambiguous scalar facts and mixed subjects or
  types, and keep sealed values as safe markers. Optional metadata preserves source facts for
  temporal edits. Instants decode to epoch-millisecond numbers; many values deduplicate and
  sort by canonical identity.

  `Attribute.Use` now carries a third generic parameter for literal requiredness. Concise
  modifiers and `Attribute.use` retain that flag, and bare definitions remain optional. Existing
  two-parameter annotations remain broad; no existing runtime shape is removed. Decoded sealable
  values include a `SealedMarker` union because stored sealed values stay sealed even after a
  sensitivity declaration changes. Breaking change: `decode` is now a reserved entity attribute alias, so declarations that
  previously used that alias must rename it. No existing helper is removed.

- dfa9298: Return `QueryResponse` from `CommitValidation.View.query`, matching the complete
  `Triples.queryAll` read. This is a breaking change: validator callers must read
  bindings from `response.results` instead of using the returned value as an array.
  The read remains complete at its fixed commit cut and has no continuation cursor.
  Update shared backend validator conformance to cover this response contract.

### Patch Changes

- 405f798: Describe Triplex as the database that remembers why, and link the agent modeling guide and the
  `llms.txt` documentation index from the package README.
- 73bcb15: Fix the `config` command description in CLI help, which read "Splunk configuration objects".
- bfe0d2e: Name the first two violations in `ConstraintViolationError.message` with their constraint key,
  subject, and valid-time instant, instead of only a count, and add `Constraint.describeViolations`.
  Document that enforced graph constraints hold at every valid-time edge of an entity.
- 108196e: Explain `and` grouping and multi-clause `or` alternatives in Datalog preflight errors. Queries such
  as `["or", [[c1, c2], [c3]]]` or `["not", ["and", ...]]` now fail with a message naming the clause
  and the supported shape instead of a schema union dump.
- dfa9298: Refresh the live-query coordinator clock after asynchronous journal reads so a temporal deadline that elapsed during a read wakes immediately instead of scheduling a stale relative sleep.
- dfa9298: Drive the live-query coalescing case's test clock until its pull completes so asynchronous backends can finish reading the head before scheduling the coalescing delay. Keep the existing coverage and result assertions unchanged.
- 20bc2a4: Provision a shared numeric/datetime expression index through an additive SQL migration, enabling
  Datalog range scans for live and snapshot-pinned actor due-work queries without application DDL.
  Preserve numeric comparison semantics and add shared backend conformance coverage for due-work
  ordering, limits, temporal visibility, and continuation after retraction. Existing SQL databases
  must apply migration v2; creating the index scans existing numeric history and can block writes.
- b184b37: Guarantee assertion order in transaction receipts and submitted operation order in journal changes
  on every backend. Persist change indices in journal JSON facts and read older records by metadata
  fact ID without a schema migration. Pattern retractions expand in ascending triple-ID order.
  This changes previously unspecified, backend-dependent journal ordering; callers that relied on
  storage scan order must use submitted operation order instead.
- 458d699: Update the published package READMEs to reflect npm availability and supported installation paths.
- 177e448: Fix two PostgreSQL problems when a host creates many organization databases at once. Each
  database schema is now created on a separate connection before its schema-bound pools open.
  Before, a pooled connection that opened before the schema existed could create migration tables
  in `pg_catalog` and fail with "permission denied to create pg_catalog.triplex_schema_migrations".
  Closing the database manager now also closes every cached database's connection pools; before,
  they stayed open until the process exited.
- 44892c4: Declare Effect and its platform and SQL companions as compatible peer ranges so
  applications can share one runtime. Keep exact development versions for repository
  tests. Consumers of the CLI, SQLite and PostgreSQL packages must provide their
  platform and SQL adapter peers alongside Effect.
- dfa9298: Derive failure-envelope command names and value-taking flags from the declared command tree, including aliases and options before subcommands.
- dfa9298: Resolve database client recorded-time views through the indexed recorded-basis read instead of paging the transaction journal. Preserve exact commit cuts for timestamp ties, future timestamps, and later writes.
