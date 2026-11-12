import { expect, it } from "vitest";
import { Clock, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { Triples } from "@triplex-internal/core";
import {
  CurrentDialect,
  DeterministicTripleStoreRuntimeLive,
  TriplesLive,
  TripleStoreRuntime,
} from "@triplex-internal/core/internal";
import { PostgresqlAdapterLive, PostgresqlDialect } from "@triplex-build/triplex-postgres";
import { SqlQueryExecutorLive } from "@triplex-build/triplex-sql";
import { runnerCases } from "@triplex-build/triplex-testkit";
import { postgresSchemaLayer } from "@triplex-build/triplex-testkit/postgres";
import {
  PgConnectionInfo,
  PgContainerLayer,
  checkDockerAvailable,
} from "../fixtures/PgTestLayer.js";

const DOCKER_AVAILABLE = checkDockerAvailable();

const cases = {
  ...runnerCases,
  "TestClock drives commit instants": Effect.gen(function* () {
    const triples = yield* Triples;
    yield* TestClock.setTime(10);
    yield* triples.transact([]);
    yield* TestClock.setTime(20);
    yield* triples.transact([]);
    const page = yield* triples.transactions();
    expect(page.transactions.map(({ instant }) => instant)).toEqual([10, 20]);
  }),
};

for (const [name, program] of Object.entries(cases)) {
  it.skipIf(!DOCKER_AVAILABLE)(`postgres: ${name}`, { timeout: 60_000 }, async () => {
    // Keep deterministic IDs while sharing the watch's TestClock for commit instants.
    const runtime = Layer.effect(
      TripleStoreRuntime,
      Effect.gen(function* () {
        const base = yield* TripleStoreRuntime;
        return { ...base, now: Clock.currentTimeMillis };
      }),
    ).pipe(Layer.provide(DeterministicTripleStoreRuntimeLive({ now: 0 })));
    const schemaStore = Layer.unwrap(
      Effect.gen(function* () {
        const { url } = yield* PgConnectionInfo;
        return postgresSchemaLayer({
          url,
          triples: () =>
            TriplesLive.pipe(
              Layer.provide(SqlQueryExecutorLive),
              Layer.provide(PostgresqlAdapterLive),
              Layer.provide(Layer.succeed(CurrentDialect, PostgresqlDialect)),
              Layer.provide(runtime),
            ),
        });
      }),
    ).pipe(Layer.provide(PgContainerLayer));
    // SQL pool maintenance uses real time; advancing TestClock by months must
    // only drive the store and watch, not replay months of pool timers.
    const store = Layer.effectContext(TestClock.withLive(Layer.build(schemaStore)));
    await Effect.runPromise(
      program.pipe(Effect.provide(store), Effect.scoped, Effect.provide(TestClock.layer())),
    );
  });
}
