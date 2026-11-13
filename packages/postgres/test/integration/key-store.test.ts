import { describe, expect, it } from "vitest";
import { Context, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { EntityId, Triples } from "@triplex-internal/core";
import { Attribute } from "@triplex-internal/core/config";
import { RootKey, Sensitive, ValueCodec } from "@triplex-internal/core/sensitive";
import { SqlKeyStore } from "@triplex-build/triplex-sql";
import { PgTriples } from "@triplex-build/triplex-postgres";
import {
  ERASURE_CONFORMANCE_DATABASE,
  erasureConformanceLayer,
  makeErasureSuite,
  KEY_STORE_CONFORMANCE_DATABASE,
  SENSITIVE_CONFORMANCE_DATABASE,
  makeKeyStoreSuite,
  makeSensitiveConformanceSuite,
  sensitiveConformanceLayer,
} from "@triplex-build/triplex-testkit";
import { postgresSchemaLayer } from "@triplex-build/triplex-testkit/postgres";
import {
  checkDockerAvailable,
  PgConnectionInfo,
  PgContainerLayer,
} from "../fixtures/PgTestLayer.js";

const DOCKER_AVAILABLE = checkDockerAvailable();

const ROOT = new Uint8Array(32).fill(11);
const rootKey = Layer.orDie(
  RootKey.fromBytes({ current: { id: "root-pg", key: Redacted.make(ROOT) } }),
);

/** A fresh schema with its `Triples` and the `SqlClient` bound to it. */
const withFreshDatabase = <A, E>(
  use: (context: {
    readonly triples: Layer.Layer<Triples>;
    readonly sql: SqlClient.SqlClient;
  }) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { url } = yield* PgConnectionInfo;
      const context = yield* Layer.build(
        postgresSchemaLayer({ url, triples: PgTriples.layerFromSqlClient }),
      );
      const sql = Context.get(context, SqlClient.SqlClient);
      const triples = Layer.succeed(Triples, Context.get(context, Triples));
      return yield* use({ triples, sql });
    }).pipe(Effect.scoped, Effect.provide(PgContainerLayer)),
  );

const keyStore = (database: string, sql: SqlClient.SqlClient) =>
  SqlKeyStore.layer({ database }).pipe(
    Layer.provide(rootKey),
    Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
  );

describe("PostgreSQL erasure", () => {
  it.skipIf(!DOCKER_AVAILABLE)(
    "passes the erasure contract with test keys",
    { timeout: 120_000 },
    async () => {
      await withFreshDatabase(({ triples }) =>
        makeErasureSuite().pipe(Effect.provide(erasureConformanceLayer(triples))),
      );
    },
  );

  it.skipIf(!DOCKER_AVAILABLE)(
    "passes the erasure contract with stored keys and leaves no token in any table",
    { timeout: 120_000 },
    async () => {
      const leaked = await withFreshDatabase(({ triples, sql }) =>
        Effect.gen(function* () {
          const t = yield* Triples;
          yield* t.assert({
            entityId: EntityId.make("er:ada"),
            attribute: ":er-person/ssn",
            value: { type: "string", value: "999-99-9999" },
          });
          const before = yield* sql<{ value_blind: string }>`
            SELECT value_blind FROM triples WHERE entity_id = 'er:ada' AND value_blind IS NOT NULL
          `;
          yield* makeErasureSuite();
          const tables = yield* sql<{ table_name: string }>`
            SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()
          `;
          let dump = "";
          for (const { table_name } of tables) {
            dump += JSON.stringify(
              yield* sql.unsafe(`SELECT * FROM "${table_name.replaceAll('"', '""')}"`),
              (_key, field: unknown) => (typeof field === "bigint" ? field.toString() : field),
            );
          }
          expect(before).toHaveLength(1);
          return before.filter(({ value_blind }) =>
            dump.includes(value_blind.slice(value_blind.indexOf(":") + 1)),
          );
        }).pipe(
          Effect.provide(
            erasureConformanceLayer(triples, keyStore(ERASURE_CONFORMANCE_DATABASE, sql)),
          ),
        ),
      );
      expect(leaked).toEqual([]);
    },
  );
});

describe("PostgreSQL key store", () => {
  it.skipIf(!DOCKER_AVAILABLE)("passes the key store contract", { timeout: 120_000 }, async () => {
    await withFreshDatabase(({ sql }) =>
      makeKeyStoreSuite().pipe(Effect.provide(keyStore(KEY_STORE_CONFORMANCE_DATABASE, sql))),
    );
  });

  it.skipIf(!DOCKER_AVAILABLE)(
    "passes the sensitive decorator contract with stored keys",
    { timeout: 120_000 },
    async () => {
      await withFreshDatabase(({ triples, sql }) =>
        makeSensitiveConformanceSuite().pipe(
          Effect.provide(
            sensitiveConformanceLayer(
              triples,
              ValueCodec.aesGcm.pipe(Layer.provide(keyStore(SENSITIVE_CONFORMANCE_DATABASE, sql))),
            ),
          ),
        ),
      );
    },
  );

  it.skipIf(!DOCKER_AVAILABLE)(
    "opens with a new key store instance and never stores the root key",
    { timeout: 120_000 },
    async () => {
      const Ssn = Attribute.sensitive(Attribute.text(":person/ssn"));
      const person = EntityId.make("person:1");
      const result = await withFreshDatabase(({ triples, sql }) =>
        Effect.gen(function* () {
          const decorated = () =>
            Sensitive.layer({ database: "acme/main", attributes: [Ssn] }).pipe(
              Layer.provide(ValueCodec.aesGcm.pipe(Layer.provide(keyStore("acme/main", sql)))),
              Layer.provide(triples),
            );
          yield* Effect.gen(function* () {
            const t = yield* Triples;
            yield* t.assert({
              entityId: person,
              attribute: ":person/ssn",
              value: { type: "string", value: "917-55-4321" },
            });
          }).pipe(Effect.provide(decorated()));
          // A second instance has an empty cache, so it reads and unwraps the stored key.
          const opened = yield* Effect.gen(function* () {
            const t = yield* Triples;
            return yield* Sensitive.open(yield* t.entity(person));
          }).pipe(Effect.provide(Layer.fresh(decorated())));
          const tables = yield* sql<{ table_name: string }>`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = current_schema() ORDER BY table_name
          `;
          const parts: string[] = [];
          for (const { table_name } of tables) {
            const rows = yield* sql.unsafe(`SELECT * FROM "${table_name.replaceAll('"', '""')}"`);
            parts.push(
              JSON.stringify(rows, (_key, field: unknown) =>
                typeof field === "bigint" ? field.toString() : field,
              ),
            );
          }
          const [keys] = yield* sql<{ count: number }>`
            SELECT count(*)::int AS count FROM triplex_data_keys WHERE root_key_id = 'root-pg'
          `;
          return { opened, dump: parts.join("\n"), keys: keys!.count };
        }),
      );
      expect(result.opened[0]!.value).toEqual({ type: "string", value: "917-55-4321" });
      expect(result.keys).toBe(1);
      const root = Buffer.from(ROOT);
      expect(result.dump).not.toContain(root.toString("hex"));
      expect(result.dump).not.toContain(root.toString("base64url"));
      expect(result.dump).not.toContain(root.toString("base64"));
    },
  );
});
