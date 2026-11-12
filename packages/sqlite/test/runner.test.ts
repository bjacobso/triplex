import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { Clock, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import {
  KvTriplesLive,
  KvBackend,
  makeTestKvBackend,
  TriplesLive,
  CurrentDialect,
  TripleStoreRuntime,
  DeterministicTripleStoreRuntimeLive,
  TripleStoreRuntimeLive,
} from "@triplex-internal/core/internal";
import { SqlQueryExecutorLive } from "@triplex-build/triplex-sql";
import {
  SqliteAdapterLive,
  SqliteDialect,
  SqliteTestLayer,
  makeSqliteLayer,
} from "../src/index.js";
import {
  runnerCases,
  runnerPersistenceCase,
  runnerWorldsCase,
} from "@triplex-build/triplex-testkit";
for (const backend of ["kv", "sqlite"] as const)
  for (const [name, program] of Object.entries(runnerCases)) {
    // GitHub's Node 22 runner exceeds the 5 s default for the paged journal corpus.
    it(`${backend}: runner ${name}`, { timeout: 60_000 }, async () => {
      const runtime = Layer.effect(
        TripleStoreRuntime,
        Effect.gen(function* () {
          const base = yield* TripleStoreRuntime;
          return { ...base, now: Clock.currentTimeMillis };
        }),
      ).pipe(Layer.provide(DeterministicTripleStoreRuntimeLive({ now: 0 })));
      const store = (
        backend === "kv"
          ? KvTriplesLive.pipe(Layer.provide(Layer.sync(KvBackend, makeTestKvBackend)))
          : TriplesLive.pipe(
              Layer.provide(SqlQueryExecutorLive),
              Layer.provide(SqliteAdapterLive),
              Layer.provide(Layer.succeed(CurrentDialect, SqliteDialect)),
              Layer.provide(SqliteTestLayer),
            )
      ).pipe(Layer.provide(runtime));
      await Effect.runPromise(
        program.pipe(Effect.scoped, Effect.provide(store), Effect.provide(TestClock.layer())),
      );
    });
  }

for (const backend of ["kv", "sqlite"] as const)
  it(`${backend}: close/reopen runner persistence`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "triplex-runner-"));
    const kv = makeTestKvBackend();
    const runtime = Layer.effect(
      TripleStoreRuntime,
      Effect.map(TripleStoreRuntime, (base) => ({ ...base, now: Clock.currentTimeMillis })),
    ).pipe(Layer.provide(TripleStoreRuntimeLive));
    const open = () =>
      (backend === "kv"
        ? KvTriplesLive.pipe(Layer.provide(Layer.succeed(KvBackend, kv)))
        : TriplesLive.pipe(
            Layer.provide(SqlQueryExecutorLive),
            Layer.provide(SqliteAdapterLive),
            Layer.provide(Layer.succeed(CurrentDialect, SqliteDialect)),
            Layer.provide(makeSqliteLayer(join(directory, "world.sqlite"))),
          )
      ).pipe(Layer.provide(runtime));
    try {
      await Effect.runPromise(runnerPersistenceCase(open).pipe(Effect.provide(TestClock.layer())));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

for (const backend of ["kv", "sqlite"] as const)
  it(`${backend}: sixteen independent worlds`, async () => {
    const runtime = Layer.effect(
      TripleStoreRuntime,
      Effect.map(TripleStoreRuntime, (base) => ({ ...base, now: Clock.currentTimeMillis })),
    ).pipe(Layer.provide(TripleStoreRuntimeLive));
    const open = () =>
      (backend === "kv"
        ? KvTriplesLive.pipe(Layer.provide(Layer.sync(KvBackend, makeTestKvBackend)))
        : TriplesLive.pipe(
            Layer.provide(SqlQueryExecutorLive),
            Layer.provide(SqliteAdapterLive),
            Layer.provide(Layer.succeed(CurrentDialect, SqliteDialect)),
            Layer.provide(Layer.fresh(SqliteTestLayer)),
          )
      ).pipe(Layer.provide(runtime));
    await Effect.runPromise(runnerWorldsCase(open).pipe(Effect.provide(TestClock.layer())));
  });
