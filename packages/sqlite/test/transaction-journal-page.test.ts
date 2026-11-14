import { expect, it } from "vitest";
import { Effect, Layer } from "effect";
import {
  CurrentDialect,
  makeTripleStoreRuntimeLayer,
  StorageAdapter,
  type StorageAdapterService,
  TriplesLive,
} from "@triplex-internal/core/internal";
import { SqlQueryExecutorLive } from "@triplex-build/triplex-sql";
import { SqliteAdapterLive, SqliteDialect, SqliteTestLayer } from "../src/index.js";
import { transactionJournalPagePlan } from "../../../test/fixtures/transaction-journal-page.js";

/** Counts every row or grouped row the adapter hands back to TriplesLive. */
const meteredAdapter = (counter: { rows: number }) =>
  Layer.effect(
    StorageAdapter,
    Effect.gen(function* () {
      const adapter = yield* StorageAdapter;
      const size = (value: unknown): number =>
        Array.isArray(value)
          ? value.length
          : value instanceof Map
            ? [...value.values()].reduce((total: number, rows) => total + size(rows), 0)
            : 0;
      return Object.fromEntries(
        Object.entries(adapter).map(([name, member]) => [
          name,
          typeof member !== "function" || name === "withTransaction"
            ? member
            : (...args: unknown[]) =>
                Effect.tap(
                  (member as (...args: unknown[]) => Effect.Effect<unknown>)(...args),
                  (value) =>
                    Effect.sync(() => {
                      counter.rows += size(value);
                    }),
                ),
        ]),
      ) as unknown as StorageAdapterService;
    }),
  ).pipe(Layer.provide(SqliteAdapterLive));

it(
  "reads the same rows for an unfiltered journal page after 10 and 10000 earlier commands",
  { timeout: 60000 },
  async () => {
    const counter = { rows: 0 };
    const layer = TriplesLive.pipe(
      Layer.provideMerge(SqlQueryExecutorLive),
      Layer.provideMerge(meteredAdapter(counter)),
      Layer.provideMerge(Layer.succeed(CurrentDialect, SqliteDialect)),
      Layer.provideMerge(SqliteTestLayer),
      Layer.provide(makeTripleStoreRuntimeLayer("sqlite:journal-page-test")),
    );
    const measurements = await Effect.runPromise(
      transactionJournalPagePlan("sqlite", {
        reset: () => {
          counter.rows = 0;
        },
        rows: () => counter.rows,
      }).pipe(Effect.provide(layer)),
    );
    // Two journal entries plus their two referenced facts, independent of history.
    expect(measurements.map((measurement) => measurement.rows)).toEqual([4, 4]);
  },
);
