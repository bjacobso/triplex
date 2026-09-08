# Configuration-derived entity HTTP API

Status: proposed implementation plan. This change adds the plan only.

The separate tenant-hosting proposal is preserved in [HOSTING_PLAN.md](HOSTING_PLAN.md).

## Outcome

Add `@bjacobso/triplex-http`, an optional package that derives an Effect `HttpApi`,
request/response schemas, OpenAPI documentation, and REST handlers from a Triplex
configuration release. A host supplies `Triples`, `ConfigStore`, and its authorization
policy, then mounts the resulting routes over its chosen backend.

An `Employer` entity schema using `:employer/name` should be enough to expose a
validated employer collection. The HTTP layer must read persisted configuration;
it must not require the original TypeScript declarations to remain in memory.
Include immutable config versions from the start, with a deliberately small policy
for writable versions.

## Existing implementation and port boundary

The sibling checkout at commit `27f5fc5f` already implements the central idea:

| Source in `../open-ontology/`                            | What to reuse conceptually                                             | Triplex adaptation                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/runtime/api/src/rest/DynamicRestApiFactory.ts` | Runtime entity groups, CRUD endpoints, schemas, handler composition    | Build from Triplex config nodes and use the public `Triples` service                       |
| `packages/runtime/api/src/rest/VersionResolver.ts`       | Resolve a requested version before constructing the API                | Replace VCS change IDs and Lisp compilation with `ConfigStore.resolveRef` / `snapshotById` |
| `packages/runtime/api/src/rest/RestHandlerCache.ts`      | Reuse compiled APIs and generate OpenAPI from them                     | Use a scoped Effect service keyed by resolved snapshot and mount options                   |
| `packages/runtime/api/src/rest/SwaggerUI.ts`             | Optional interactive API documentation                                 | Use the documentation integration supported by the pinned Effect version                   |
| `packages/runtime/api/test/rest-api.test.ts`             | HTTP CRUD, custom paths, generated OpenAPI, historical write rejection | Rework fixtures for KV and SQLite; add atomicity, cardinality, and version-race coverage   |

The source exposes `/api/db/{database}/rest/{version}/{plural}`. `latest` resolves
through its VCS `main` branch; explicit changes are read-only. Its factory also
contains relationship, action, task, and kernel integrations. Those integrations,
database management, VCS, and deployment compilation are outside this port.

Do not copy these behaviors:

- Attribute suffix extraction and reconstruction from the entity name: Triplex
  keywords are global identities and may be shared between entity types.
- Inferring refs from punctuation in strings, coercing values, or collapsing
  multiple facts into one scalar.
- Separate retract/assert calls for update and delete: each mutation must use one
  `Triples.transact` boundary.
- A process-global handler map, invalidation that depends only on a deploy hook,
  or an empty OpenAPI document returned after generation fails.
- `@open-ontology/*` imports, compatibility exports, or the old Effect 3
  `@effect/platform` API surface.

Triplex pins `effect` and `@effect/platform-node` to `4.0.0-rc.112`. The installed
source provides `HttpApi`, `HttpApiEndpoint`, `HttpApiGroup`, `HttpApiBuilder`, and
`OpenApi` under `effect/unstable/httpapi`; route composition and the Fetch adapter
live under `effect/unstable/http`. Confirm dynamic construction against that pin.
The [upstream Effect HTTP example](https://github.com/Effect-TS/effect-smol/blob/main/ai-docs/src/51_http-server/10_basics.ts)
also demonstrates the definition/handler split and layer composition, but the
installed version is the implementation reference.

## Package and service boundaries

Preserve the one-way graph in [ARCHITECTURE.md](ARCHITECTURE.md):

- `triplex-http` depends on public core and `@bjacobso/triplex/config` exports and
  peers on Effect. Core never imports the HTTP package.
- Backend packages remain independent of HTTP. Examples/hosts compose HTTP with
  KV, SQLite, or another backend. Node server dependencies belong in the host.
- Use Effect services/layers for configuration loading, entity operations, host
  authorization, and caching. Keep contract/schema compilation independent of
  server startup and backend allocation.
- Use `catalog:` for external dependencies, keeping any new versions pinned in
  the root catalog. Public exports resolve only to `dist`.

Suggested modules in `packages/http/src/`:

| Module                  | Responsibility                                                          |
| ----------------------- | ----------------------------------------------------------------------- |
| `ConfigApi.ts`          | Validate exposure options and compile a resolved config into a contract |
| `EntityCodec.ts`        | Map JSON, exact attribute identities, and typed triple values           |
| `EntityStore.ts`        | Effect service for collection reads and atomic entity mutations         |
| `EntityHttpApi.ts`      | Build dynamic groups/endpoints and OpenAPI annotations                  |
| `EntityHttpHandlers.ts` | Decode requests, authorize operations, invoke the service, map errors   |
| `VersionResolver.ts`    | Resolve explicit snapshot IDs and configured aliases                    |
| `HandlerCache.ts`       | Scoped, bounded cache with concurrent-build deduplication               |
| `index.ts`              | Public construction and layer APIs                                      |

Offer a contract-only entry point that takes a resolved `ConfigSnapshot`, and a
host layer that resolves versions and serves requests. A single database per layer
is sufficient; database selection and multi-tenant routing remain host-owned.
Runtime-derived fields have runtime validation, not invented static TypeScript
types. A generated client/source-code emitter can be added later.

## Reflecting the configuration

Reuse these existing foundations:

- [EntityType](packages/core/src/config/EntityType.ts): entity-schema nodes,
  usage aliases, requiredness/cardinality, attribute refs, and constraint children.
- [Attribute](packages/core/src/config/Attribute.ts): global keywords and value types.
- [TypeSchema](packages/core/src/config/TypeSchema.ts): `TypeExpr` to Effect Schema,
  including closed objects, constraints, defaults, enums, and references.
- [GraphConstraint](packages/core/src/config/GraphConstraint.ts): collect and
  validate rules from a pinned release; produce transaction enforcement metadata.
- [ConfigStore](packages/core/src/config/ConfigStore.ts): immutable release loading.
- [EntityValidation](packages/core/src/config/EntityValidation.ts): existing schema
  parsing/materialization semantics to compare against. Its helpers are currently
  private; extract shared storage-independent helpers only where semantics agree.

Compile each release into a validated descriptor containing the entity identity,
declared attributes and usages, value schemas, graph constraints, route name, and
allowed operations. Traverse the release graph and resolve attribute references
within that release. Reject conflicting definitions, invalid schema/usage metadata,
unresolved references, reserved identities, and duplicate route/operation names.
Handle direct `EntityValidation.define` schemas explicitly: they may have no DSL
usage map. Initially require complete `EntityType`/`Attribute` metadata for REST
exposure and return a descriptive unsupported-config error for incomplete schemas.

Use full attribute keywords as JSON keys in the initial contract. The property
alias `name` is discoverable metadata, not another accepted wire spelling. This
preserves identity across entities and removes ambiguity when aliases change.
Generate collection names deterministically from the entity name, with a host
override such as `Employer -> employers`; validate safe single path segments and
collisions. Do not introduce an English pluralization dependency.

Derive input and output schemas from the same descriptor. Scalars remain scalars;
cardinality-many becomes a JSON array of facts with deterministic set ordering.
Distinguish that from a list-valued attribute encoded as one JSON fact. Reuse the
DSL encodings for text, number/integer, boolean, date, instant, enum, and ref.
Define JSON encoding for supported composite types; reject ambiguous union/storage
mappings during compilation instead of guessing. Instants use epoch milliseconds,
dates use the existing date schema, and refs remain entity ID strings. JSON null
is accepted only where the declared value type permits it.

Expose only configured attributes on reads. Missing required values, incompatible
stored types, and multiple distinct values for a scalar produce a typed data-shape
conflict; do not silently choose a value or disguise old incompatible data as valid.
Historical contracts may therefore reject current entities that no longer fit them.

## Proposed REST contract

Use a host-controlled base path, for example `/api`. In the table below,
`B = /api/rest/{version}` and `C` is an exposed collection such as `employers`.

| Method and path             | Behavior                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `GET B/schema`              | Exposed entities, global attribute keys, aliases, value schemas, constraints, allowed operations, and resolved config ID |
| `GET B/openapi.json`        | OpenAPI generated from the same compiled `HttpApi`                                                                       |
| `GET B/docs`                | Optional documentation UI                                                                                                |
| `GET B/C?limit=50&cursor=…` | Bounded, deterministically ordered entity page                                                                           |
| `POST B/C`                  | Create with a server-generated ID; return `201` and `Location`                                                           |
| `GET B/C/:id`               | Fetch one entity of this type, or `404`                                                                                  |
| `PUT B/C/:id`               | Replace the exposed attribute set on an existing entity; return `200`; no implicit upsert                                |
| `DELETE B/C/:id`            | Retract the entity's application facts atomically; return `204`; history remains queryable                               |

Example create body and response shape:

```json
{ "attributes": { ":employer/name": "Acme" } }
```

```json
{
  "id": "employer:01…",
  "type": "Employer",
  "attributes": { ":employer/name": "Acme" }
}
```

`PUT` requires all required fields and removes omitted optional exposed attributes.
Preserve facts outside the selected schema during replacement. Deletion applies
to the entity, so authorize it as such and enforce inbound reference constraints
from the whole pinned release. Reject mixed/conflicting entity-type membership
until a multi-type mutation policy is explicitly designed. Reserve collection names
used by schema/docs endpoints and validate encoded IDs consistently.

Pages return `{ items, nextCursor? }`, without an unconditional full count. Start
with entity-ID ordering, a default limit of 50 and maximum of 200. Additional filters,
sorting, PATCH, batch transactions, relationship expansion, raw Datalog, and
attribute-level mutation routes are follow-up work.

Use declared errors consistently: `400` for malformed input/cursors, `401`/`403`
from host authorization, `404` for unknown versions/types/entities, `405` with
`Allow` for read-only versions, `409` for graph/data-shape/transaction conflicts,
and sanitized `500` for storage failures or corrupt deployed configuration.
Return machine-readable codes and field paths; preserve detailed causes in logs.

## Versioning policy

Treat three identities separately: the HTTP protocol/contract format, the immutable
`ConfigSnapshot.id`, and the temporal basis of operational facts. A release label
is descriptive and is not assumed to be a unique version key.

1. `latest` resolves a host-configured ref, defaulting to `live`.
2. An explicit snapshot ID resolves with `snapshotById` and is read-only by default.
3. Optional friendly aliases such as `v1` and `v2` map to immutable snapshot IDs in
   host configuration. They can coexist; the initial implementation does not promise
   writable historical schemas or automatic migrations.
4. A fixed deployment may mount a pinned snapshot at an unversioned path. The host
   explicitly designates that snapshot as its active write contract.
5. Each request resolves once, pins that snapshot for decoding, handlers, graph
   enforcement, and response encoding, and reports it in `X-Triplex-Config-Snapshot`.
   Journal writes carry `TransactionMeta.configSnapshot` with the same ID.
6. Moving a ref affects subsequent requests. In-flight writes finish under the
   snapshot they resolved; this is request-start pinning, not a promise that a ref
   cannot move before commit. A strict deployment cutover barrier is separate work.

A historical config version describes the shape of data; it does not automatically
select historical data. Add explicit `recordedAt`/`validAt` query parameters to reads
using Triplex's bitemporal semantics. Reject temporal parameters on writes. Do not
port the ambiguous `X-As-Of` wrapper or accept malformed instants as current reads.
Default writes operate at current time. Define interval replacement carefully;
initially reject mutations of entities with scheduled future facts rather than
silently deleting or rewriting their schedule.

Cache immutable compiled descriptors by snapshot ID and exposure options. Handler
keys also include database/runtime scope, mount path, requested version spelling,
and write policy. Resolve movable aliases before cache lookup so a ref move cannot
reuse a stale handler. Do not cache credentials or request authorization decisions.
Bound entries, deduplicate concurrent construction, dispose evicted resources after
active requests finish, and close all resources with the host layer's scope.

## Storage correctness gates

The current public API has useful primitives but is not already a complete entity
CRUD abstraction. Resolve these gaps before promising the HTTP behavior above:

- **Atomic writes:** decode first, then transact all retractions/assertions once,
  using constraints collected from the entire pinned release. Constraint enforcement
  checks graph rules; it does not replace value-schema decoding. Derive actor and
  other trusted metadata from the host, never from arbitrary payload fields.
- **Entity identity and empty bodies:** membership currently lives on individual
  facts as `entityType`, not Open Ontology's `:_schema/type` marker. An entity with
  no facts has no representation. For the first slice, reject create/replacement
  that would leave no application facts; document this restriction. Persistent
  empty entities require a separately designed core-owned lifecycle representation.
- **Concurrent replacement/delete:** `TripleLive` preconditions require retraction
  of the referenced facts. They catch competing changes to those facts, but do not
  protect against new attributes appearing after a read. Add a backend-independent
  entity-state precondition at the serialized transaction boundary if needed to
  guarantee replacement/delete semantics. It must detect insertion-only races,
  not just check an ETag before calling `transact`. Keep this extension in core and
  its backend implementations; do not reach through HTTP into adapters or reserved
  config facts. Verify it against existing non-HTTP `Triples` writers.
- **Paged materialization:** reuse `queryPage` cursor semantics and batched
  `entities` reads, but do not page IDs at one commit position and load bodies at
  another. Public `TemporalBasis` currently exposes timestamps; the exact
  `recordedPosition` used by pagination is internal. Add a public snapshot-read
  token or a core entity-page operation that performs both stages at one exact
  cut. Verify entity-type discovery can use an indexed public query; extend core
  minimally if it cannot, rather than scanning all facts or importing internals.
- **Cursor binding:** bind the page to database scope, collection, resolved config,
  exposure options, order, and temporal basis. Reject cross-version reuse. If
  `latest` moves between pages, return a restart-required conflict or require
  continuation through the explicit snapshot URL; never mix contracts silently.
- **Post-commit responses:** encode created/replaced state from the committed
  result or a pinned read, not a later mutable read. Failure to build a response
  after commit cannot roll back the mutation. Do not claim automatic retry
  idempotency without a request/receipt design using Triplex command IDs.

Host authorization must run on every request and scope collection results as well
as individual entity operations. Provide an explicit allow-all layer for local
examples, not an implicit authentication system. Reserved entities/attributes stay
excluded, and database selection is completed by the host before dispatch.

## Implementation sequence and acceptance criteria

1. **Prove the runtime contract and storage seams.** Build a small in-process
   Effect 4 experiment from a persisted Employer schema. Verify dynamic endpoints,
   schema error encoding, OpenAPI generation, route mounting, and scope disposal.
   Settle the entity-state precondition and exact-cut pagination APIs above before
   implementing production writes/pages. Exit: concrete public service signatures
   and tests demonstrating the relevant concurrency behavior.
2. **Add the package and config compiler.** Scaffold manifests/build configuration,
   descriptors, codecs, errors, and contract generation. Exit: the same persisted
   release produces deterministic routes and schemas without DSL objects in memory;
   unsupported or conflicting metadata fails with actionable errors.
3. **Deliver one vertical CRUD slice.** Compose `Triples` and `ConfigStore` with
   generated handlers for Employer and Employment (including a reference), first
   over in-memory KV, then SQLite. Include discovery/OpenAPI and the authorization
   seam. Exit: requests round-trip exact keywords and typed values, constraints
   abort atomically, PUT clears omitted optional values, and deletion retains history.
4. **Add version resolution and scoped caching.** Implement latest, explicit IDs,
   friendly aliases, version headers, and read-only historical contracts. Exit:
   schema/docs/handlers always agree, ref movement is observed, concurrent builds
   share work, and eviction/shutdown release resources safely.
5. **Complete pagination, temporal reads, and conflict behavior.** Wire the public
   storage extensions, bounded pages, temporal validation, and conflict responses.
   Exit: pages remain consistent under same-millisecond concurrent commits and
   version movement; mutation races cannot lose unrelated concurrent facts.
6. **Document and package the feature.** Add `examples/http-api` with KV/SQLite
   host composition and curl requests; document version policy, wire identities,
   constraints, limitations, and errors. Update `ARCHITECTURE.md`, package/release
   lists, and `scripts/check-packages.mjs` so the HTTP package is checked from its
   tarball with public `dist` exports. Add a changeset for the implementation.

Test the behavior through real Fetch `Request`/`Response` handlers. Cover required
and optional fields, shared keywords with different aliases, ref targets, enums,
constraints, scalar/many encoding, unknown fields, malformed JSON, wrong entity
type, empty entities, scheduled facts, unsupported stored values, and route collisions.
Verify OpenAPI describes the actual writable/read-only methods and schemas; test
generation failure rather than accepting an empty fallback document.

Run the same HTTP integration cases with KV and SQLite in `test/integration`.
Core concurrency additions need backend conformance tests, including insertion-only
races, reference-target deletion, competing unique values, rollback of facts/journal,
and exact-position pagination. PostgreSQL, FoundationDB, and stress execution remain
opt-in; default checks must still compile affected packages.

Before handing off implementation changes, run `pnpm check` and `pnpm pack:check`.
The feature is complete when a persisted configuration alone can drive documented,
validated REST CRUD on both baseline backends, with the version and concurrency
semantics above demonstrated by tests.
