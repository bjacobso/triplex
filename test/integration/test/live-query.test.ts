import { it } from "vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import {
  KvTriplesLive,
  TriplesLive,
  CurrentDialect,
  DeterministicTripleStoreRuntimeLive,
  makeTestKvBackend,
  KvBackend,
} from "@triplex-build/triplex/internal";
import { SqliteAdapterLive, SqliteDialect, SqliteTestLayer } from "@triplex-build/triplex-sqlite";
import { SqlQueryExecutorLive } from "@triplex-build/triplex-sql";
import { DatabaseScope } from "@triplex-build/triplex/runtime";
import { LiveQuery } from "@triplex-build/triplex/live-query";
import { liveQueryCases } from "@triplex-build/triplex-testkit";
for (const backend of ["kv", "sqlite"] as const) {
  for (const [name, program] of Object.entries(liveQueryCases)) {
    it(`${backend}: ${name}`, async () => {
      const store = (
        backend === "kv"
          ? KvTriplesLive.pipe(Layer.provide(Layer.sync(KvBackend, makeTestKvBackend)))
          : TriplesLive.pipe(
              Layer.provide(SqlQueryExecutorLive),
              Layer.provide(SqliteAdapterLive),
              Layer.provide(Layer.succeed(CurrentDialect, SqliteDialect)),
              Layer.provide(SqliteTestLayer),
            )
      ).pipe(Layer.provide(DeterministicTripleStoreRuntimeLive({ now: 0 })));
      await Effect.runPromise(
        program.pipe(
          Effect.provide(LiveQuery.layer({ scope: DatabaseScope.test(`${backend}:${name}`) })),
          Effect.provide(store),
          Effect.scoped,
          Effect.provide(TestClock.layer()),
        ),
      );
    }, 20000);
  }
}
