import { DatabaseId } from "@triplex-build/triplex";
import { ConfigStore } from "@triplex-build/triplex/config";
import { PgTriples, type PostgresqlConfig } from "@triplex-build/triplex-postgres";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";
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

export const databaseLayer = (options: Effect.Success<ReturnType<typeof parseOptions>>) => {
  const triples =
    options.postgresUrl === undefined
      ? SqliteTriples.layer({
          filename:
            options.databaseId === undefined
              ? options.sqlite
              : `${options.dataDir}/${options.databaseId}.db`,
        })
      : options.databaseId === undefined
        ? PgTriples.layerFromUrl(options.postgresUrl)
        : PgTriples.layerForDatabaseMigrated(
            postgresConfig(options.postgresUrl),
            options.databaseId,
          );
  return ConfigStore.layer.pipe(Layer.provideMerge(triples));
};
