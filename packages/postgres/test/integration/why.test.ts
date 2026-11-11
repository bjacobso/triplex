import { it } from "vitest";
import { Effect, Layer } from "effect";
import {
  TriplesLive,
  TripleStoreRuntime,
  CurrentDialect,
  DeterministicTripleStoreRuntimeLive,
} from "@triplex-build/triplex/internal";
import { PostgresqlAdapterLive, PostgresqlDialect } from "@triplex-build/triplex-postgres";
import { SqlQueryExecutorLive } from "@triplex-build/triplex-sql";
import {
  whyConformance,
  whyTestLayer,
  assertionConformance,
  whyReadBoundaryConformance,
} from "@triplex-build/triplex-testkit";
import { postgresSchemaLayer } from "@triplex-build/triplex-testkit/postgres";
import {
  PgConnectionInfo,
  PgContainerLayer,
  checkDockerAvailable,
} from "../fixtures/PgTestLayer.js";

it.skipIf(!checkDockerAvailable())(
  "PostgreSQL passes shared why conformance",
  { timeout: 120000 },
  async () => {
    let instant = 0;
    const runtime = Layer.effect(
      TripleStoreRuntime,
      Effect.gen(function* () {
        const base = yield* TripleStoreRuntime;
        return { ...base, now: Effect.sync(() => instant) };
      }),
    ).pipe(Layer.provide(DeterministicTripleStoreRuntimeLive({ now: 0 })));
    const store = Layer.unwrap(
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
    await Effect.runPromise(
      whyConformance((value) => {
        instant = value;
      }).pipe(
        Effect.andThen(whyReadBoundaryConformance),
        Effect.provide(whyTestLayer.pipe(Layer.provideMerge(store))),
        Effect.scoped,
      ),
    );
  },
);

it.skipIf(!checkDockerAvailable())(
  "PostgreSQL distinguishes get from assertion",
  { timeout: 120000 },
  async () => {
    const store = Layer.unwrap(
      Effect.gen(function* () {
        const { url } = yield* PgConnectionInfo;
        return postgresSchemaLayer({
          url,
          triples: () =>
            TriplesLive.pipe(
              Layer.provide(SqlQueryExecutorLive),
              Layer.provide(PostgresqlAdapterLive),
              Layer.provide(Layer.succeed(CurrentDialect, PostgresqlDialect)),
              Layer.provide(DeterministicTripleStoreRuntimeLive({ now: 1000 })),
            ),
        });
      }),
    ).pipe(Layer.provide(PgContainerLayer));
    await Effect.runPromise(assertionConformance.pipe(Effect.provide(store), Effect.scoped));
  },
);
