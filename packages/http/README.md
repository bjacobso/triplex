# @bjacobso/triplex-http

Configuration-derived REST and OpenAPI contracts for Triplex. The package is backend-neutral and
uses Effect services: hosts provide `Triples`, `ConfigStore`, and an authorization policy, then
mount `EntityHttp.layer` into their chosen HTTP server.

```ts
import { EntityHttp, HttpAuthorizationAllowAll } from "@bjacobso/triplex-http";
import { Layer } from "effect";

const routes = EntityHttp.layer({
  basePath: "/api",
  exposure: { collections: { Employer: "employers" } },
}).pipe(Layer.provide(HttpAuthorizationAllowAll));
```

The HTTP contract is loaded from an immutable persisted configuration snapshot. JSON attribute
keys are exact global keywords such as `:employer/name`; TypeScript aliases are discovery metadata
only. `latest` resolves the configurable `live` ref and is writable. Explicit snapshot IDs and
friendly aliases are read-only unless the host names an `activeWriteSnapshot`.

See the repository's [HTTP API guide](../../docs/http-api.md) and
[complete host example](../../examples/http-api).

MIT © 2026 Ben Jacobson.
