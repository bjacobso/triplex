# @triplex-build/triplex/testkit

Reusable backend fixture and capability helpers for testing Triplex adapters.

Install `@triplex-build/triplex/testkit` from npm with Node.js 22+ and the compatible Effect 4
release candidate.

`triplesConformanceCases` and `makeTriplesConformanceSuite` define the behavioral contract used by
the in-memory KV, SQLite, and opt-in PostgreSQL suites. The corpus covers atomic writes, typed
values, temporal reads, Datalog semantics, stable pagination, the transaction journal, command
receipts, checkpoints, derivations, and graph constraints. New backends should pass it before being
described as supported.

`runtimeConformance(definition, options)` builds a public `Runtime.define` or `Runtime.fromKv`
definition and runs that same corpus. Use a fresh isolated backend and choose capabilities
explicitly. This is a Triples contract check, not a guarantee of snapshot/emitter correctness,
crash durability, cross-process isolation, or migration safety.

For Postgres tests, install the compatible `@effect/sql-pg` optional peer and use
the separate `@triplex-build/triplex/testkit/postgres` entrypoint:

```ts
import { Effect } from "effect";
import { Triples } from "@triplex-build/triplex";
import { PgTriples } from "@triplex-build/triplex/postgres";
import { postgresSchemaLayer } from "@triplex-build/triplex/testkit/postgres";

const TestDatabase = postgresSchemaLayer({
  url: process.env.PG_TEST_URL!,
  triples: PgTriples.layerFromSqlClient,
});

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const triples = yield* Triples;
      // Test code; SqlClient is also available for host transaction tests.
      return yield* triples.transactions();
    }).pipe(Effect.provide(TestDatabase)),
  ),
);
```

Each acquisition creates a unique schema, runs migrations, and supplies `Triples`
and a pool whose every connection is bound to that schema. Closing the scope drops
the schema, including after test or layer-construction failure. Use a disposable
database with permission to create and drop schemas. The fixture manages schemas
and connections; consumers provide the database service or container. The main
testkit entrypoint does not load the Postgres driver.

MIT © 2026 Ben Jacobson.
