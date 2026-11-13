import { describe, expect, it } from "vitest";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { runMigrations } from "@triplex-build/triplex-sql";
import { PgTriples } from "@triplex-build/triplex-postgres";
import { postgresSchemaLayer } from "@triplex-build/triplex-testkit/postgres";
import {
  checkDockerAvailable,
  PgConnectionInfo,
  PgContainerLayer,
} from "../fixtures/PgTestLayer.js";

const DOCKER_AVAILABLE = checkDockerAvailable();

describe("PostgreSQL migration v11", () => {
  it.skipIf(!DOCKER_AVAILABLE)(
    "removes blind token copies from journal payloads and snapshots",
    { timeout: 120_000 },
    async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const { url } = yield* PgConnectionInfo;
          const context = yield* Layer.build(
            postgresSchemaLayer({ url, triples: PgTriples.layerFromSqlClient }),
          );
          const sql = Context.get(context, SqlClient.SqlClient);
          const change = JSON.stringify({
            op: "assert",
            tripleId: "00000000000000000000000003",
            entityId: "person:1",
            attribute: ":person/ssn",
            value: {
              type: "sealed",
              valueType: "string",
              keyId: "k1.0",
              ciphertext: "AQ",
              blind: "b1.0:token",
            },
            changeIndex: 0,
          });
          yield* sql`
            INSERT INTO triples (
              id, entity_id, attribute, value_type, value_json,
              recorded_at, recorded_position, valid_from, schema_version, tx_id
            ) VALUES (
              '00000000000000000000000004', '_tx/00000000000000000000000005', ':_tx/change',
              'json', ${change}, 1, 1, 1, 1, '_tx/00000000000000000000000005'
            )
          `;
          const blob = JSON.stringify([
            [
              ":person/ssn",
              {
                type: "sealed",
                valueType: "string",
                keyId: "k1.0",
                ciphertext: "AQ",
                blind: "b1.0:token",
              },
            ],
          ]);
          yield* sql`INSERT INTO entity_blobs (hash, data, byte_size) VALUES ('sealed-blob', ${blob}, 1)`;
          yield* sql`
            INSERT INTO entity_snapshots (entity_id, tx_id, hash, tx_time)
            VALUES ('person:1', '_tx/1', 'sealed-blob', 1)
          `;
          yield* sql`DELETE FROM triplex_schema_migrations WHERE version = 11`;
          yield* runMigrations.pipe(Effect.provideService(SqlClient.SqlClient, sql));
          const [journal] = yield* sql<{ value_json: string }>`
            SELECT value_json FROM triples WHERE attribute = ':_tx/change'
          `;
          const [blobs] = yield* sql<{
            count: number;
          }>`SELECT count(*)::int AS count FROM entity_blobs`;
          const [snapshots] = yield* sql<{ count: number }>`
            SELECT count(*)::int AS count FROM entity_snapshots
          `;
          return {
            journal: JSON.parse(journal!.value_json) as { value: Record<string, unknown> },
            blobs: blobs!.count,
            snapshots: snapshots!.count,
          };
        }).pipe(Effect.scoped, Effect.provide(PgContainerLayer)),
      );
      expect(result.journal.value).toEqual({
        type: "sealed",
        valueType: "string",
        keyId: "k1.0",
        ciphertext: "AQ",
      });
      expect(result.blobs).toBe(0);
      expect(result.snapshots).toBe(0);
    },
  );
});
