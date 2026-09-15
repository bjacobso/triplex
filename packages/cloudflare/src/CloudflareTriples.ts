/** Complete `Triples` composition for one Durable Object SQLite database. */

import { Effect } from "effect";
import { Runtime, DatabaseScope, Capabilities } from "@triplex-build/triplex/runtime";
import {
  makeSqlQueryExecutorLayer,
  SqliteDialect,
  type SqlStatementRunner,
} from "@triplex-build/triplex-sql";
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
  return makeSqlQueryExecutorLayer(runner, SqliteDialect);
};

/** Public-only adapter example; callers bind identity and select capabilities. */
export const makeCloudflareRuntime = (state: DOState) =>
  Runtime.define({
    name: "cloudflare-do",
    storage: makeCloudflareAdapterLayer(state),
    queries: queryExecutorLayer(state),
  });

const layer = ({ state, scope }: CloudflareTriplesOptions) =>
  makeCloudflareRuntime(state).layer({
    scope: DatabaseScope.make({
      env: "cloudflare",
      tenant: "durable-object",
      database: scope,
      generation: 0,
    }),
    // Preserve the existing convenience entry point's behavior explicitly.
    capabilities: Capabilities.none,
  });

export const CloudflareTriples = { layer } as const;

export type CloudflareTriplesLayer = ReturnType<typeof CloudflareTriples.layer>;
