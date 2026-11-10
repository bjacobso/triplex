# TX2 follow-up: host, HTTP and dashboard position bases

Branch `fix/tx2-host-position-basis`, based on
[TX5 PR #66](https://github.com/bjacobso/triplex/pull/66). This closes a wrapper gap
in [TX2 PR #60](https://github.com/bjacobso/triplex/pull/60).

## Public behavior

The tenant protocol already decoded `recordedPosition`, but its Datalog options
mapper copied only `recordedAt` and `validAt`. Thus a request carrying:

```json
{ "basis": { "recordedPosition": 1, "validAt": 1 } }
```

could return current `["Alicia", "Bob", "Carol"]` instead of historical
`["Alice", "Bob"]` after a rename/retraction and later insertion. Both `Query`
and `QueryPage` now forward the position. Wrapped page continuations keep the
same cut, position zero stays empty, and a supplied timestamp plus position reaches
core's existing rejection instead of silently dropping the position.

The host helper uses the shared public `TemporalBasis` type rather than a
handwritten subset. Its request schema, authorization, routing identity, read
limits, and store contract are unchanged.

HTTP entity GETs and collection GETs now expose `?recordedPosition=P`, including
zero. The URI handler previously omitted that parameter. It validates non-negative
safe integers, returns 400 for malformed/fractional/unsafe/empty values and for
combining a position with recordedAt, and rejects temporal parameters on writes.
Collection continuation retains its original cut without needing to repeat the
parameter. Both compiled OpenAPI read endpoints advertise the parameter; the
example's v1/v2/latest fixtures were regenerated for this additive contract.

Dashboard `loadDashboardAt` and `loadEntityTypePage` already accepted TemporalBasis
but omitted its position. They now preserve it, expose optional position metadata
on the dashboard fact-view basis, and retain it in page cursors. Future position
pages clamp to their initial committed head so later assertions cannot enter the
continuation. Existing v1 timestamp cursors remain accepted. A cursor without an
exact recorded cut, or with an invalid/ambiguous basis, fails. Continuations use
the cursor's stored cut, preserving the helper's existing precedence. The dashboard
change concerns fact reads and entity pages; config catalogs and the journal keep
their existing behavior.

Consumers update host/HTTP packages and the dashboard application as needed. This
follow-up adds no migration; adopt prior stack migrations separately. Changeset
`host-position-basis.md` contains a host patch and HTTP minor; dashboard is private.

## Regression and coverage

Tests were written and run first:

```sh
pnpm --filter @triplex-build/triplex-host exec vitest run test/host.test.ts -t 'preserves position cuts'
```

Both real KV and SQLite boundary cases failed, returning Alicia and Carol at the
older position. The cases JSON-round-trip and schema-decode tenant requests,
authorize the bound identity, then execute through the public tenant boundary.
They cover later assertion and retraction, Query, QueryPage and continuation,
position zero, and ambiguous timestamp+position rejection. The entire host suite
passes after forwarding the missing field (8 tests).

Additional failing-first regressions:

```sh
pnpm --filter triplex-integration-tests exec vitest run test/http-api.test.ts -t 'preserves commit-position'
pnpm --filter @triplex-build/triplex-dashboard exec vitest run src/position-reads.test.ts
```

Both HTTP backends returned Alicia instead of Alice at the older position. The
dashboard historical test included later entities. Corrected focused tests pass:
HTTP KV/SQLite point reads, pages and continuation, position zero, invalid inputs,
ambiguous bases and temporal-write rejection; dashboard fact cuts, pages, future
head clamping, legacy cursors and malformed/ambiguous cursor rejection. A separate
OpenAPI test checks the query parameter on entity and collection reads.

These forwarding paths are adapter-independent; no SQL, SQLite, PostgreSQL,
Cloudflare or FoundationDB backend implementation changes. Direct host and HTTP
boundary regressions use KV/SQLite; dashboard helpers use the KV demo composition.
PostgreSQL/Cloudflare retain their full core position-read corpus. Their native
front doors are not separately exercised by these new surface tests. No native
FoundationDB pass is claimed because its client library is unavailable.

Final cumulative validation commands:

```sh
pnpm check
pnpm pack:check
pnpm test:postgres:integration
```

The host-only checkpoint `80ab675` passed root checks, all 33 PostgreSQL
integrations and 11 tarballs/clean consumer, and opened as
[PR #67](https://github.com/bjacobso/triplex/pull/67). The expanded HTTP/dashboard scope also passes `pnpm check` and all 33
PostgreSQL integrations. Its package check and final revision record are next. The original broad core conformance did not prove this host wrapper;
the missing forwarding was found by inspecting the current host implementation.

The HTTP example OpenAPI fixtures were regenerated intentionally with:

```sh
pnpm --filter triplex-http-api-example exec vitest run test/openapi.test.ts --update
```

Their only contract additions are the optional recordedPosition read parameters;
the final root run verifies all three snapshots without update mode.
