/**
 * Ask 0019 (A), condition 2 on PostgreSQL: concurrent transactions on a pool
 * of connections race one command ID; the unique `command_id` keeps the first.
 */
import { it } from "vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { Triples } from "@triplex-internal/core";
import { PgTriples } from "@triplex-build/triplex-postgres";
import { postgresSchemaLayer } from "@triplex-build/triplex-testkit/postgres";
import { commandFirstWriterPlan } from "../../../../test/fixtures/command-first-writer.js";
import {
  PgConnectionInfo,
  PgContainerLayer,
  checkDockerAvailable,
} from "../fixtures/PgTestLayer.js";

it.skipIf(!checkDockerAvailable())(
  "keeps first-writer-wins for one command ID across concurrent pooled transactions",
  { timeout: 120_000 },
  async () => {
    const database = Layer.unwrap(
      Effect.gen(function* () {
        const { url } = yield* PgConnectionInfo;
        return postgresSchemaLayer({ url, triples: PgTriples.layerFromSqlClient });
      }),
    ).pipe(Layer.provide(PgContainerLayer));
    await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        yield* SqlClient.SqlClient;
        yield* commandFirstWriterPlan("postgres", [triples, triples, triples, triples]);
      }).pipe(Effect.provide(database), Effect.scoped),
    );
  },
);
