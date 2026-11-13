import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { migrations, SchemaVersionError } from "@triplex-build/triplex-sql";

export { SchemaVersionError };

/** Read-only preflight. Connection, permission, and malformed-history errors remain SQL errors. */
export const checkSchemaVersion = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const expectedVersion = Math.max(...migrations.map((migration) => migration.version));
  // Check the current schema explicitly: a table in a fallback search-path schema
  // must never make an unmigrated database appear ready. Avoid deliberately
  // querying a missing table, which would abort a caller's ambient transaction.
  const [history] = yield* sql<{ readonly relation: string | null }>`
    SELECT to_regclass(quote_ident(current_schema()) || '.triplex_schema_migrations')::text AS relation
  `;
  let actualVersion = 0;
  if (history?.relation != null) {
    const [row] = yield* sql<{ readonly version: number | null }>`
      SELECT MAX(version) AS version FROM triplex_schema_migrations
    `;
    actualVersion = Number(row?.version ?? 0);
  }
  if (actualVersion !== expectedVersion) {
    return yield* new SchemaVersionError({ expectedVersion, actualVersion });
  }
});
