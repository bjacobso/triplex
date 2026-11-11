import { Effect } from "effect";
import {
  ReadError,
  createParamCollector,
  type SqlDialect,
  type TripleRow,
} from "@triplex-build/triplex/internal";
import type { StorageAdapterService } from "@triplex-build/triplex/runtime";
import type { SqlStatementRunner } from "./SqlQueryExecutor.js";

/** Uses the existing partial entity index (only unretracted rows). */
export const makeSqlLiveFactsLookup =
  (runner: SqlStatementRunner, dialect: SqlDialect): StorageAdapterService["liveFacts"] =>
  (entityId) => {
    const p = createParamCollector(dialect);
    return runner
      .run<TripleRow>(
        `SELECT * FROM triples WHERE entity_id = ${p.add(entityId)} AND retracted_at IS NULL`,
        p.params,
      )
      .pipe(
        Effect.mapError((cause) => new ReadError({ message: "Failed to read live facts", cause })),
      );
  };

/** Live indexes exclude history; PostgreSQL also uses a selective expression key. */
export const makeSqlLivePreconditionLookup =
  (
    runner: SqlStatementRunner,
    dialect: SqlDialect,
  ): StorageAdapterService["livePreconditionFacts"] =>
  (entityId, attribute, limit) => {
    const p = createParamCollector(dialect);
    const entity = p.add(entityId);
    const where = [`entity_id = ${entity}`, "retracted_at IS NULL"];
    if (attribute !== undefined) {
      const attr = p.add(attribute);
      where.push(`attribute = ${attr}`);
      if (dialect.name === "postgresql")
        where.push(
          `(length(entity_id)::text || ':' || entity_id || attribute) = (length(${entity})::text || ':' || ${entity} || ${attr})`,
        );
    }
    return runner
      .run<TripleRow>(
        `SELECT * FROM triples WHERE ${where.join(" AND ")} LIMIT ${p.add(limit)}`,
        p.params,
      )
      .pipe(
        Effect.mapError(
          (cause) => new ReadError({ message: "Failed to read live precondition facts", cause }),
        ),
      );
  };
