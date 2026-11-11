import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { CommitValidation, CommitRejectedError, Triples, WriteError } from "@triplex-build/triplex";
import {
  CurrentDialect,
  RuntimeServicesLive,
  SqliteDialect,
  StorageAdapter,
  type StorageAdapterService,
  TriplesLive,
  TripleStoreRuntimeLayer,
} from "@triplex-build/triplex/internal";
import { SqlQueryExecutorLive } from "@triplex-build/triplex-sql";
import { SqliteAdapterLive } from "@triplex-build/triplex-sqlite";

it("preserves a validator rejection wrapped by a custom adapter", async () => {
  let wrapped = false;
  const wrappingAdapter = Layer.effect(
    StorageAdapter,
    Effect.map(StorageAdapter, (adapter) => {
      const withTransaction: StorageAdapterService["withTransaction"] = (effect) =>
        adapter.withTransaction(effect).pipe(
          Effect.mapError((cause) => {
            wrapped = true;
            return new WriteError({ message: "Custom adapter transaction failed", cause });
          }),
        );
      return { ...adapter, withTransaction };
    }),
  ).pipe(Layer.provide(SqliteAdapterLive));
  const database = TriplesLive.pipe(
    Layer.provideMerge(SqlQueryExecutorLive),
    Layer.provideMerge(wrappingAdapter),
    Layer.provideMerge(Layer.succeed(CurrentDialect, SqliteDialect)),
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
    Layer.provide(TripleStoreRuntimeLayer),
    Layer.provideMerge(RuntimeServicesLive),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const triples = yield* Triples;
      const reject = CommitValidation.make("custom.reject", () =>
        Effect.succeed([{ code: "refused", message: "Refused" }]),
      );
      const error = yield* triples.transact([], { validate: [reject] }).pipe(Effect.flip);
      expect(wrapped).toBe(true);
      expect(error).toBeInstanceOf(CommitRejectedError);
      expect(yield* triples.currentPosition()).toBe(0);
    }).pipe(Effect.provide(database)),
  );
});
