import { Effect } from "effect";
import {
  ReadError,
  createParamCollector,
  transactionPrefixBounds,
  TxAttributes,
  type SqlDialect,
} from "@triplex-build/triplex/internal";
import type { StorageAdapterService } from "@triplex-build/triplex/runtime";
import type { SqlStatementRunner } from "./SqlQueryExecutor.js";

/** Candidate discovery for the shipped SQLite/PostgreSQL adapters. */
export const makeSqlTransactionPrefixLookup =
  (
    runner: SqlStatementRunner,
    dialect: SqlDialect,
  ): StorageAdapterService["transactionIdsForEntityPrefix"] =>
  (prefix, after, limit) => {
    const bounds = transactionPrefixBounds(prefix);
    if (bounds === null || (dialect.name === "postgresql" && prefix.includes("\0")))
      return Effect.succeed([]);
    const p = createParamCollector(dialect);
    const column =
      dialect.name === "postgresql" ? 'value_string COLLATE "C"' : "value_string COLLATE BINARY";
    const where = [
      "attribute = '" + TxAttributes.CHANGED_ENTITY + "'",
      "entity_type = '_Transaction'",
      "value_type = 'ref'",
      "retracted_at IS NULL",
      `${column} >= ${p.add(bounds.lower)}`,
      `recorded_position > ${p.add(after)}`,
    ];
    if (bounds.upper !== undefined) where.push(`${column} < ${p.add(bounds.upper)}`);
    return runner
      .run<{ entity_id: string; recorded_position: number | string }>(
        `SELECT DISTINCT entity_id, recorded_position FROM triples WHERE ${where.join(" AND ")} ORDER BY recorded_position, entity_id LIMIT ${p.add(limit)}`,
        p.params,
      )
      .pipe(
        Effect.flatMap((rows) =>
          Effect.try(() =>
            rows.map((row) => {
              const position = Number(row.recorded_position);
              if (!Number.isSafeInteger(position) || position <= after)
                throw new Error("Invalid journal candidate position");
              return { txId: row.entity_id, position };
            }),
          ),
        ),
        Effect.mapError(
          (cause) =>
            new ReadError({
              message: "Failed to read entity-prefix transaction candidates",
              cause,
            }),
        ),
      );
  };
