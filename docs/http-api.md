# Configuration-derived HTTP API

`@triplex-build/triplex-http` turns a persisted `ConfigSnapshot` into runtime request/response schemas,
an Effect `HttpApi`, OpenAPI 3.1, and REST handlers. It never needs the original `Attribute` or
`EntityType` TypeScript values after deployment. The package depends only on public Triplex core
and config APIs; the host chooses and provides its backend and server.

## Host composition

```ts
import { ConfigStore } from "@triplex-build/triplex/config";
import { EntityHttp, HttpAuthorizationAllowAll } from "@triplex-build/triplex-http";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";
import { Layer } from "effect";

const database = ConfigStore.layer.pipe(
  Layer.provideMerge(SqliteTriples.layer({ filename: "triplex.sqlite" })),
);

const routes = EntityHttp.layer({
  basePath: "/api",
  exposure: { collections: { Employer: "employers" } },
}).pipe(
  Layer.provide(HttpAuthorizationAllowAll), // local examples only
  Layer.provide(database),
);
```

Production hosts provide `HttpAuthorization` with request authorization, row visibility for
collection reads, and trusted actor metadata. Payload fields never control transaction metadata.

## Routes and wire format

For `/api/rest/{version}`, the package exposes `schema`, `openapi.json`, an optional interactive
Scalar `docs` page, collection GET/POST, and item GET/PUT/DELETE routes. Create and replace bodies
have one `attributes` object:

```json
{ "attributes": { ":employer/name": "Acme" } }
```

Responses add server-owned identity and the configured entity type. Full keywords are the only
accepted wire keys. Cardinality-many attributes are deterministically ordered arrays; list-valued
attributes remain one JSON fact. Dates are `YYYY-MM-DD`, instants are epoch milliseconds, and refs
are entity ID strings.

Every response has `X-Triplex-Config-Snapshot`. Writes carry the same ID in
`TransactionMeta.configSnapshot`, decode before mutation, enforce constraints from the complete
release, and use one `Triples.transact` boundary. PUT replaces only exposed attributes and retains
unexposed facts. DELETE retains normal bitemporal history. The initial contract rejects empty
entities, mixed entity-type membership, and mutations of entities with active scheduled facts.

## Versions and temporal reads

- `latest` resolves `latestRef` (`live` by default) for each request and is writable.
- Explicit snapshot IDs and configured aliases are immutable and read-only by default.
- `activeWriteSnapshot` can designate one immutable snapshot as the deployment's write contract.
- `recordedAt` and `validAt` are validated epoch-millisecond query parameters on reads only.
- `recordedPosition` selects an exact commit cut for entity and collection reads. It must be a
  non-negative safe integer; zero is the empty cut. Do not combine it with `recordedAt`.
  Temporal query parameters are rejected on writes. Use the returned collection cursor to
  continue at the same cut after later commits.

Collection cursors bind the database scope, entity type, temporal basis, exact commit position, and
the surrounding HTTP snapshot/version cache key. A continuation therefore materializes every body
at the first page's exact cut. If a movable ref changes, clients must restart under the newly
resolved contract.

Errors are JSON envelopes `{ "error": Diagnostic }`, for example:

```json
{
  "error": {
    "code": "http.invalid-request",
    "message": "limit must be an integer between 1 and 200",
    "path": "$.limit",
    "fix": "Correct the named request field using the OpenAPI schema.",
    "retryable": false
  }
}
```

The OpenAPI error schema includes `code`, `message`, `retryable`, and optional `path`,
`fix`, and `details`. Core failures retain their core codes; HTTP-owned errors use `http.*`.
See [Error diagnostics](/errors) for every code. Retryable transaction conflicts include
`Retry-After: 0`; reload current facts before retrying the whole command.
Malformed input is `400`, host authentication/authorization is `401`/`403`, missing resources are
`404`, read-only writes are `405` with `Allow`, and data/constraint/concurrency conflicts are `409`.
Unexpected storage and deployed-config failures return a sanitized `500` while their causes remain
in Effect logs.
