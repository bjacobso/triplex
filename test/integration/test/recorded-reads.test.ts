import { it } from "vitest";
import { Effect, Layer } from "effect";
import {
  KvTriplesLive,
  TriplesLive,
  TripleStoreRuntime,
  CurrentDialect,
  DeterministicTripleStoreRuntimeLive,
} from "@triplex-build/triplex/internal";
import { InMemoryKvBackendLive } from "@triplex-build/triplex/internal";
import { SqliteAdapterLive, SqliteDialect, SqliteTestLayer } from "@triplex-build/triplex-sqlite";
import { SqlQueryExecutorLive } from "@triplex-build/triplex-sql";
import { recordedReadsConformance } from "@triplex-build/triplex-testkit";

// D9/D11 freeze Cloudflare; its new historical timestamp/wildcard reads return ReadError.
// FoundationDB inherits these reads from KV; native coverage remains opt-in.
for (const backend of ["kv", "sqlite"] as const) {
  it(`${backend} resolves recorded bases and wildcard dependency state`, async () => {
    let instant = 0;
    const runtime = Layer.effect(
      TripleStoreRuntime,
      Effect.gen(function* () {
        const base = yield* TripleStoreRuntime;
        return { ...base, now: Effect.sync(() => instant) };
      }),
    ).pipe(Layer.provide(DeterministicTripleStoreRuntimeLive({ now: 0 })));
    const store =
      backend === "kv"
        ? KvTriplesLive.pipe(Layer.provide(InMemoryKvBackendLive))
        : TriplesLive.pipe(
            Layer.provide(SqlQueryExecutorLive),
            Layer.provide(SqliteAdapterLive),
            Layer.provide(Layer.succeed(CurrentDialect, SqliteDialect)),
            Layer.provide(SqliteTestLayer),
          );
    await Effect.runPromise(
      recordedReadsConformance((value) => {
        instant = value;
      }).pipe(Effect.provide(store.pipe(Layer.provide(runtime))), Effect.scoped),
    );
  });
}
