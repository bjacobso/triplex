/** Explicit composition for tests that inspect SQL, adapters, or dialect internals. */
import { Layer } from "effect";
import {
  CurrentDialect,
  makeTripleStoreRuntimeLayer,
  TriplesLive,
} from "@triplex-build/triplex/internal";
import { SqlQueryExecutorLive } from "@triplex-build/triplex-sql";
import { SqliteAdapterLive, SqliteDialect, SqliteTestLayer } from "../src/index.js";

export const sqliteInternalLayer = (scope = "sqlite:internal-test") =>
  TriplesLive.pipe(
    Layer.provideMerge(SqlQueryExecutorLive),
    Layer.provideMerge(SqliteAdapterLive),
    Layer.provideMerge(Layer.succeed(CurrentDialect, SqliteDialect)),
    Layer.provideMerge(SqliteTestLayer),
    Layer.provide(makeTripleStoreRuntimeLayer(scope)),
  );
