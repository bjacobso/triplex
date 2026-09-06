/** Complete `Triples` composition for one Durable Object SQLite database. */

import { Effect, Layer } from "effect";
import {
  QueryExecutor,
  TriplesLive,
  makeTripleStoreRuntimeLayer,
} from "@bjacobso/triplex/internal";
import { makeSqlQueryExecutor, type SqlStatementRunner } from "@bjacobso/triplex-sql";
import { makeCloudflareAdapterLayer, type DOState, type SqlStorageValue } from "./storage/index.js";

export interface CloudflareTriplesOptions {
  /** The Durable Object state whose SQLite database owns this instance. */
  readonly state: DOState;
  /**
   * Stable, complete database identity used to bind opaque pagination cursors.
   * Include environment, tenant, database, and generation.
   */
  readonly scope: string;
}

const queryExecutorLayer = (state: DOState) => {
  const runner: SqlStatementRunner = {
    run: <Row extends Record<string, unknown>>(sql: string, params: readonly unknown[]) =>
      Effect.try({
        try: () =>
          state.storage.sql.exec<Row>(sql, ...(params as readonly SqlStorageValue[])).toArray(),
        catch: (error) => error,
      }),
  };
  return Layer.succeed(QueryExecutor, makeSqlQueryExecutor(runner));
};

const layer = ({ state, scope }: CloudflareTriplesOptions) =>
  TriplesLive.pipe(
    Layer.provide(makeCloudflareAdapterLayer(state)),
    Layer.provide(queryExecutorLayer(state)),
    Layer.provide(makeTripleStoreRuntimeLayer(scope)),
  );

export const CloudflareTriples = { layer } as const;

export type CloudflareTriplesLayer = ReturnType<typeof CloudflareTriples.layer>;
