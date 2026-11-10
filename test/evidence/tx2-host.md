# TX2 follow-up: host protocol position basis

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

The helper uses the shared public `TemporalBasis` type rather than a handwritten
subset. JSON schema, authorization, routing identity, read limits, and the store
contract are unchanged. Consumers only update the host package; this follow-up
adds no migration. Adopt prior stack migrations separately. Changeset:
`host-position-basis.md` (host patch).

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

The mapper is adapter-independent: no SQL, SQLite, Postgres, Cloudflare, or
FoundationDB implementation changes. Direct tenant-boundary tests use KV and
SQLite; PostgreSQL/Cloudflare retain the existing full core position-read corpus.
No native FoundationDB pass is claimed because its client library is unavailable.

Final cumulative validation commands:

```sh
pnpm check
pnpm pack:check
pnpm test:postgres:integration
```

`pnpm check` passes, all 33 PostgreSQL integration tests pass, and
`pnpm pack:check` verifies 11 tarballs and a clean consumer. Revision and PR link
will be recorded after the implementation checkpoint. The original broad core conformance did not prove this host wrapper;
the missing forwarding was found by inspecting the current host implementation.
