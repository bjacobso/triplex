# TX5: bounded live-value and absence guards

Branch `feat/tx5-cheap-preconditions`, based on
[TX4 PR #65](https://github.com/bjacobso/triplex/pull/65). Implementation and clean measured revision: `6673197`. The PR link will be
recorded after opening the PR.

## Public behavior and adoption

Previously a version check needed a full `EntityState` ID-set read or a
backend-specific lock and version convention. Now a command can guard one attribute
or absence without materializing other attributes or historical replacements:

```ts
const command = Effect.gen(function* () {
  const triples = yield* Triples;
  return yield* triples.transact(operations, {
    preconditions: [
      { _tag: "AttributeValue", entityId: home, attribute: ":home/version", value: number(1) },
      { _tag: "AttributeAbsent", entityId: home, attribute: ":home/deleted" },
    ],
  });
});
```

`EntityAbsent` replaces the empty-entity case of `EntityState`. All three inspect
unretracted facts across every valid time, like the existing entity-state contract;
future and expired unretracted facts count. `AttributeValue` requires exactly one
live fact, including when duplicate facts have identical values. Typed scalar
values compare exactly; JSON uses canonical equality, including object-key order
normalization. A mismatch raises retryable `TransactionConflictError`; facts,
receipt, journal and position roll back. Conditions inspect the pre-state inside
the existing serialized boundary and require no matching retract. Existing guards
and commit ordering are unchanged. Unrelated attributes do not invalidate the
attribute checks.

Sensitive plaintext guards are rewritten to blind comparisons before the backend
runs. A codec without blind equality fails closed with `WriteError` containing a
`SensitiveQueryError`. Exact stored-envelope comparison remains available; blinded
envelopes compare value type and token. No plaintext is placed in a query or
journal by guard processing. The shared confidential-storage scans still apply.

Breaking pre-1.0 contract additions: custom `StorageAdapterService` implementations
must provide `livePreconditionFacts`, with a hard limit of one or two unretracted
facts using a live index; exhaustive precondition switches need three variants.
No transaction error union changes are required.

SQL migration **v6** adds the PostgreSQL expression index and analyzes triples.
Hosts owning migrations must run `runMigrations` before acquiring a Postgres layer;
the schema guard expects the latest version. Index creation is an ordinary atomic
migration, not concurrent index creation; plan its write-lock window for large
tables. SQLite records v6 with no extra DDL. Cloudflare needs no new migration
beyond its existing v6. SQL queries retain ordinary automatic-plan selection, so
keep automatic analysis enabled as distributions change.

KV adds one live ID key per unretracted fact. Existing historical indexes and
META values remain intact. Fresh empty stores are ready automatically. Upgrade
**all writers of an existing KV database** before starting its resumable backfill:

```ts
const migrate = Effect.gen(function* () {
  for (;;) {
    const progress = yield* KvTriples.migrateLiveFacts({ batchSize: 500 });
    if (progress.complete) return;
  }
});
```

Provide that database's existing `KvBackend`. Batch sizes are 1–1000, default 500;
reduce them to meet backend transaction time/size limits. Each batch commits its
keys and durable cursor atomically, so restarting resumes safely. Upgraded
transactional writers maintain the index during backfill: changes overlapping a
source read conflict atomically, retractions remove live keys, and new assertions
behind the cursor write their own keys. Malformed source input rolls back its whole
batch; unknown versions are rejected. Once complete, repeated migration is a no-op.
Existing APIs keep working before completion; new cheap guards fail with an
instructive `ReadError` until ready. Mixed old writers and raw index-bypassing KV
writes are outside the guarantee. The backfill adds no commit position or receipt.

## Coverage and evidence

| Adapter      | Lookup                                              | Coverage                                                                                                                            |
| ------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| In-memory KV | Live entity/attribute ID prefix + bounded META gets | Portable races/rollback; migration resume, concurrent upgraded changes, corrupt-input rollback, version rejection; operation counts |
| FoundationDB | Same KV protocol inside native transactions         | Shared code tested in memory; native client unavailable, no native pass claimed                                                     |
| Shared SQL   | Bounded one/two-row lookup                          | Shared builder and dialect predicates                                                                                               |
| SQLite       | Existing partial entity/attribute index             | Full portable and sensitive suites; 10/10000 plans                                                                                  |
| PostgreSQL   | Existing live indexes plus new expression index     | Portable suites in native integration; 10/10000 plans with unrelated entities                                                       |
| Cloudflare   | Same SQL lookup over synchronous DO SQL             | Native SQLite harness and real workerd through root checks                                                                          |

The failing test was written and run first:

```sh
pnpm --filter @triplex-build/triplex-testkit exec vitest run test/fixtures.test.ts -t 'attribute-value and absence'
```

It failed because an incorrect value guard was ignored. Portable coverage now
includes wrong-value rollback of facts/receipt/position, unrelated attributes,
canonical JSON, attribute and entity absence, concurrent version replacement and
creation, multi-valued conflict, future-valid facts and retraction. Separate tests
check sensitive blind equality and fail-closed behavior without blind support.

Final cumulative commands:

```sh
pnpm check
pnpm pack:check
pnpm test:postgres:integration
pnpm --filter @triplex-build/triplex exec vitest run test/operational/LivePreconditions.test.ts
pnpm --filter @triplex-build/triplex exec vitest run test/sensitive/Sensitive.test.ts -t 'fails closed for plaintext guards'
```

`pnpm check` and all **33 PostgreSQL integration tests pass**, including the
long-history plan case. Four KV migration/cost tests and the no-blind guard test
also pass. Clean-revision plans are retained below. `pnpm pack:check` also passes: 11 tarballs and a clean consumer exercising
the three guard variants and KV backfill API.
FoundationDB's missing `/usr/local/lib/libfdb_c.dylib` prevents native verification.

## Cost and design decisions

The fixture keeps one live guarded value while increasing both retracted versions
and unrelated live attributes from 10 to 10,000; SQL also keeps 1,000 unrelated
entities on the same attribute. Actual public guards run before plans are captured
from the production query builder. No plan is forced.

```sh
TRIPLEX_LIVE_PLANS=/tmp/tx5-sqlite-plans.json pnpm --filter @triplex-build/triplex-sqlite exec vitest run test/live-precondition-index.test.ts
TRIPLEX_LIVE_PLANS=/tmp/tx5-postgres-plans.json pnpm --filter @triplex-build/triplex-postgres exec vitest run test/integration/postgresql.test.ts -t 'bounds cheap guards'
```

Raw plans: [SQLite](tx5-sqlite-plans.json), [PostgreSQL](tx5-postgres-plans.json).
Both ran sequentially at clean `6673197`, without other builds or benchmarks.
Environment: Node 24.13.0 on the same macOS arm64 host as TX4; SQLite 3.50.4 and
PostgreSQL 17.8 arm64 (`postgres:17-alpine` testcontainer). These are query-plan and
operation-count experiments, not throughput or latency benchmarks.

At both history sizes, PostgreSQL's guarded-value expression-index scan returns
one row with **zero rows filtered and three shared buffer hits**. Missing attribute
and missing entity lookups return zero rows; at 10,000 history rows each uses the
existing entity/attribute live index and two shared buffer hits. SQLite uses its
live compound/entity indexes. The index choice may differ for small tables while
retaining zero rejected candidates. No session planner setting or forced index is
used.
KV counts at both
sizes are exactly three readiness lookups, one bounded live candidate, and one META
lookup for three guards (value present, attribute absent, entity absent). Every
range is limited to one or two. Thus irrelevant live attributes and retracted
history are not visited. These are storage-port operation counts; they do not claim
constant native latency or constant internal allocation in the in-memory backend.
B-tree traversal can grow logarithmically with index size.

The existing SQL partial index alone did not settle the PostgreSQL cost target:
historical correlation led the planner to scan 20,012 rejected rows in the initial
diagnostic. Extended statistics improved that plan but still read 1,000 unrelated
entities through an attribute-only index. The selected expression index has
statistics over live keys and keeps the lookup selective. Length framing prevents
ambiguous entity/attribute concatenations; original entity/attribute predicates
remain present. SQLite and Cloudflare need no extra index.

For KV, three approaches were considered: a whole-store startup rebuild would
block every acquisition and risk native transaction limits; lazy history fallback
would violate the first cheap guard's cost bound; explicit bounded backfill preserves
existing API availability and provides durable progress. This PR recommends the
implemented bounded backfill, with the all-writers-upgraded prerequisite above.
It keeps the existing history representation and costs one extra ID key per live
assertion. The guard's strict single-fact/all-valid-time semantics follow the
existing entity-state meaning rather than silently selecting one of several facts.
No allocator or scoped-concurrency proposal is implemented here.
