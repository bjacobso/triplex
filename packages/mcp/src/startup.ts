import { DatabaseId } from "@triplex-internal/core";
import { ConfigStore } from "@triplex-internal/core/config";
import type { PostgresqlConfig } from "@triplex-build/triplex-postgres";
import { Effect, Layer, Redacted, Schema } from "effect";
import { parseArgs } from "node:util";

export const parseOptions = Effect.fn(function* (
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
) {
  const { values } = yield* Effect.try(() =>
    parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: {
        sqlite: { type: "string", default: "./triplex.sqlite" },
        "data-dir": { type: "string", default: "./data" },
        "postgres-url": { type: "string" },
        "database-id": { type: "string" },
      },
    }),
  );
  const databaseId =
    values["database-id"] === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(DatabaseId)(values["database-id"]);
  const postgresUrl = values["postgres-url"] ?? env["TRIPLEX_POSTGRES_URL"];
  return {
    sqlite: values.sqlite,
    dataDir: values["data-dir"],
    ...(databaseId === undefined ? {} : { databaseId }),
    ...(postgresUrl === undefined ? {} : { postgresUrl }),
  };
});

// Match the CLI's managed PostgreSQL connection interpretation.
const postgresConfig = (source: string): PostgresqlConfig => {
  const url = new URL(source);
  return {
    database: url.pathname.slice(1),
    ...(url.hostname === "" ? {} : { host: url.hostname }),
    ...(url.port === "" ? {} : { port: Number.parseInt(url.port, 10) }),
    ...(url.username === "" ? {} : { username: decodeURIComponent(url.username) }),
    ...(url.password === "" ? {} : { password: Redacted.make(decodeURIComponent(url.password)) }),
    ...(url.searchParams.get("ssl") === "true" ? { ssl: true } : {}),
  };
};

export const databaseLayer = (options: Effect.Success<ReturnType<typeof parseOptions>>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const triples =
        options.postgresUrl === undefined
          ? (yield* Effect.promise(
              () => import("@triplex-build/triplex-sqlite"),
            )).SqliteTriples.layer({
              filename:
                options.databaseId === undefined
                  ? options.sqlite
                  : `${options.dataDir}/${options.databaseId}.db`,
            })
          : (() => {
              const url = options.postgresUrl;
              return Layer.unwrap(
                Effect.promise(() => import("@triplex-build/triplex-postgres")).pipe(
                  Effect.map(({ PgTriples }) =>
                    options.databaseId === undefined
                      ? PgTriples.layerFromUrl(url)
                      : PgTriples.layerForDatabaseMigrated(postgresConfig(url), options.databaseId),
                  ),
                ),
              );
            })();
      return ConfigStore.layer.pipe(Layer.provideMerge(triples));
    }),
  );
