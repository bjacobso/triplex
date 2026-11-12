# TX8: schema guard and Postgres fixture

Date: 2026-11-10. Branch: `feat/tx8-schema-guard`; base: `main` at `704b578`.
PR: <https://github.com/bjacobso/triplex/pull/59>. Tested implementation: `105b37a`.

## Result and adoption

The reported problem is confirmed: against a v2 schema, layer acquisition previously
ran an application effect without detecting the incompatible schema. The new
read-only preflight rejects it before exposing the service. The expected version
comes from the exported SQL migration definitions. No migration is added.

`SchemaVersionError`, exported from the Postgres package, includes `expectedVersion`
and `actualVersion` and names `runMigrations` in its message. Missing history is
version 0; older and newer versions are rejected. A fallback search-path schema's
history does not count. SQL errors, including malformed-history query failures,
are preserved. The preflight runs when an unmigrated adapter is acquired; the
ordinary auto-migration path is unchanged.

Before, this setup reached application code even with missing migrations:

```ts
const DatabaseLive = PgTriples.layerFromSqlClient({ scope: "host/main" }).pipe(
  Layer.provideMerge(HostSql),
);
```

After, the same API validates compatibility. Provision before acquisition:

```ts
await Effect.runPromise(runMigrations.pipe(Effect.provide(HostSql)));
await Effect.runPromise(program.pipe(Effect.provide(DatabaseLive)));
```

Hosts already migrating before acquisition need no change. Hosts migrating inside
`program` must move that step earlier. A newer schema requires a compatible
Triplex release, rather than attempting a downgrade. This is a pre-1.0 breaking
change to the unmigrated layer's acquisition behavior/error channel, described in
`.changeset/tidy-schema-fixtures.md`.

The testkit's new Postgres-only entrypoint replaces per-test schema creation,
migration wiring, schema binding, and cleanup:

```ts
import { postgresSchemaLayer } from "@triplex-build/triplex/testkit/postgres";

const TestDatabase = postgresSchemaLayer({
  url: process.env.PG_TEST_URL!,
  triples: PgTriples.layerFromSqlClient,
});
await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(TestDatabase))));
```

Each acquisition supplies `Triples` and `SqlClient` for a unique schema, runs
migrations, binds every pooled connection through startup options, then closes
connections and drops the schema on scope release. Cleanup failures are visible,
not silently ignored. The database/container must outlive that scope. A regression
in the existing helper's container/fixture scope ordering was found by full-suite
testing and corrected. Cleanup is tested on success, test failure, and application
layer-construction failure, and the three existing sensitive-value tests now use
the fixture.

The Triples factory is injected to avoid a circular Postgres-to-testkit-to-Postgres
dependency. Install the compatible optional `@effect/sql-pg` peer for the new
subpath; importing the main testkit does not load that driver. The fixture manages
schemas, not database servers. No material design decision remains open for TX8.

## Adapter coverage

| Adapter      | Coverage / effect                                                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres     | v2/missing/newer rejection, current schema, fallback search path, unrelated SQL error, concurrent schema/pool isolation, cleanup, existing full integration suite |
| Shared SQL   | Reuses migration definitions and runner; no shared contract or migration changed                                                                                  |
| SQLite       | No adapter change; covered by root checks                                                                                                                         |
| Cloudflare   | No adapter change; root checks include native harness/workerd coverage                                                                                            |
| KV           | No adapter change; root checks include shared contracts                                                                                                           |
| FoundationDB | No adapter change; native opt-in suite not run for this Postgres-only change                                                                                      |

## Reproduction and verification

Environment: macOS, Node `v24.13.0`, pinned pnpm `10.11.0`, Effect `4.1.1`,
Vitest `5.0.4`, Docker server `29.4.0`, testcontainers default
`postgres:17-alpine`. No `PG_TEST_URL` override; each integration test owns its
container. The initial `node_modules` contained stale versions: the first test
attempt could not import `effect/sql`. A frozen install corrected the environment
before recording the behavioral regression.

Commands and outcomes:

- `pnpm install --frozen-lockfile`: passed. After adding testkit dependencies,
  `pnpm install --lockfile-only` followed by the frozen install passed.
- `pnpm --filter @triplex-build/triplex/postgres exec vitest run test/integration/postgresql.test.ts -t 'rejects a v2 schema'`:
  failed before implementation (`applicationRan` was true); passed after the guard.
- `pnpm --filter @triplex-build/triplex/postgres exec vitest run test/integration/postgresql.test.ts -t 'isolates migrated test schemas'`:
  failed before the fixture existed; subsequent integration runs pass its behavior.
- `pnpm check`: passed, including format, lint, TypeScript, checked docs/examples,
  default unit/integration/workerd suites, packages, docs build, and local llms links.
- `pnpm test:postgres:integration`: passed, 26 tests, including four overlapping
  pooled connections per fixture and concurrent isolated fixtures.
- `pnpm pack:check`: passed, 11 tarballs and a clean consumer. The consumer now
  typechecks the fixture subpath, injected factory, and exported error constructor.
- `pnpm test:e2e`: 9 passed, 4 screenshot failures (dashboard overview, temporal
  controls, docs home light/dark). No functional assertion failures. Reproduced
  those same four failures on untouched `main` at `704b578` using
  `git worktree add --detach /tmp/triplex-tx8-baseline main`, then
  `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm test:e2e` in that worktree
  (9 passed, 4 failed). The docs screenshots expect height 13271 but render 13180
  on both revisions. Existing image baselines were not changed for TX8.
- `git diff --check`: passed.

No performance benchmark is required for TX8. Other packages' hypotheses have
not been confirmed by this work.
