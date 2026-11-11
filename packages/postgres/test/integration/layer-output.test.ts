import { expect, it } from "vitest";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { DatabaseId, Triples } from "@triplex-build/triplex";
import { PgTriples, makePostgresqlLayerFromUrl } from "@triplex-build/triplex-postgres";
import {
  checkDockerAvailable,
  PgConnectionInfo,
  PgContainerLayer,
} from "../fixtures/PgTestLayer.js";

const serviceKeys = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  Layer.build(layer).pipe(
    Effect.map((context) =>
      Array.from(context.mapUnsafe.keys())
        .filter((key) => key !== Layer.CurrentMemoMap.key)
        .sort(),
    ),
    Effect.scoped,
  );

it.skipIf(!checkDockerAvailable())(
  "exposes only the documented services from every PostgreSQL constructor",
  { timeout: 120_000 },
  async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { url } = yield* PgConnectionInfo;
        const parsed = new URL(url);
        const config = {
          host: parsed.hostname,
          port: Number(parsed.port || 5432),
          database: parsed.pathname.slice(1),
          username: decodeURIComponent(parsed.username),
          password: Redacted.make(decodeURIComponent(parsed.password)),
        };
        for (const layer of [PgTriples.layer(config), PgTriples.layerFromUrl(url)]) {
          expect(yield* serviceKeys(layer)).toEqual([Triples.key]);
        }
        const hostSql = makePostgresqlLayerFromUrl(url);
        for (const layer of [
          PgTriples.layerFromSqlClient({ scope: "output" }),
          PgTriples.layerFromSqlClientMigrated({ scope: "output" }),
        ]) {
          expect(yield* serviceKeys(layer).pipe(Effect.provide(hostSql))).toEqual([Triples.key]);
        }
        const database = DatabaseId.make("layer-output");
        for (const layer of [
          PgTriples.layerForDatabaseMigrated(config, database),
          PgTriples.layerForDatabase(config, database),
        ]) {
          expect(yield* serviceKeys(layer)).toEqual([Triples.key, SqlClient.SqlClient.key].sort());
        }
      }).pipe(Effect.provide(PgContainerLayer)),
    );
  },
);
