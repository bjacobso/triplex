import { Effect } from "effect";
import {
  ReadError,
  createParamCollector,
  transactionPrefixBounds,
  TxAttributes,
  type SqlDialect,
} from "@triplex-internal/core/internal";
import type { StorageAdapterService } from "@triplex-internal/core/runtime";
import type { SqlStatementRunner } from "./SqlQueryExecutor.js";

const decodeCandidates =
  (after: number, message: string) =>
  <E>(
    effect: Effect.Effect<readonly { entity_id: string; recorded_position: number | string }[], E>,
  ) =>
    effect.pipe(
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
      Effect.mapError((cause) => new ReadError({ message, cause })),
    );

/**
 * Unfiltered journal page for the shipped SQLite/PostgreSQL adapters. Each
 * transaction writes exactly one `:_tx/position` fact at its commit position, so
 * `idx_attribute_history (attribute, recorded_position, ...)` seeks to `after`
 * and stops after `limit` rows instead of reading the whole journal.
 */
export const makeSqlTransactionJournalLookup =
  (runner: SqlStatementRunner, dialect: SqlDialect): StorageAdapterService["transactionIdsAfter"] =>
  (after, limit) => {
    const p = createParamCollector(dialect);
    // SQLite may otherwise prefer a partial index such as idx_type and sort the journal.
    const from =
      dialect.name === "postgresql" ? "triples" : "triples INDEXED BY idx_attribute_history";
    return runner
      .run<{ entity_id: string; recorded_position: number | string }>(
        `SELECT entity_id, recorded_position FROM ${from} WHERE attribute = '${TxAttributes.POSITION}' AND recorded_position > ${p.add(after)} AND entity_type = '_Transaction' AND retracted_at IS NULL ORDER BY recorded_position LIMIT ${p.add(limit)}`,
        p.params,
      )
      .pipe(decodeCandidates(after, "Failed to read transaction journal page"));
  };

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
      .pipe(decodeCandidates(after, "Failed to read entity-prefix transaction candidates"));
  };
