/** PostgreSQL-only fixtures; importing the main testkit does not load a SQL driver. */
import { randomUUID } from "node:crypto";
import { Context, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { Triples } from "@triplex-internal/core";
import { runMigrations } from "@triplex-build/triplex-sql";

export interface PostgresSchemaOptions<E> {
  /** A disposable test database whose user can create and drop schemas. */
  readonly url: string;
  /** Usually `PgTriples.layerFromSqlClient`; injected to avoid a backend dependency cycle. */
  readonly triples: (options: {
    readonly scope: string;
  }) => Layer.Layer<Triples, E, SqlClient.SqlClient>;
}

/**
 * Each acquisition creates a unique schema, migrates it, and exposes its own
 * schema-bound SQL pool and Triples. Close the layer's scope after each test.
 * Cleanup also runs when migrations, layer construction, or the test fail.
 */
export const postgresSchemaLayer = <E>({ url, triples }: PostgresSchemaOptions<E>) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const adminContext = yield* Layer.build(PgClient.layer({ url: Redacted.make(url) }));
      const admin = Context.get(adminContext, SqlClient.SqlClient);
      const schema = `triplex_test_${randomUUID().replaceAll("-", "")}`;
      // Only internally generated ASCII identifiers enter these DDL strings.
      // Register cleanup before any migration or application layer can fail.
      yield* Effect.acquireRelease(admin.unsafe(`CREATE SCHEMA "${schema}"`), () =>
        admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`).pipe(Effect.orDie),
      );
      const scopedUrl = new URL(url);
      const options = scopedUrl.searchParams.get("options") ?? "";
      scopedUrl.searchParams.set(
        "options",
        `${options} -c search_path=${schema},pg_catalog`.trim(),
      );
      const sqlContext = yield* Layer.build(
        PgClient.layer({
          url: Redacted.make(scopedUrl.toString()),
          minConnections: 2,
          maxConnections: 4,
        }),
      );
      yield* runMigrations.pipe(Effect.provide(sqlContext));
      const triplesContext = yield* Layer.build(
        triples({ scope: `test:postgres:${schema}` }).pipe(
          Layer.provide(Layer.succeedContext(sqlContext)),
        ),
      );
      return Context.merge(
        Context.make(SqlClient.SqlClient, Context.get(sqlContext, SqlClient.SqlClient)),
        triplesContext,
      );
    }),
  );
