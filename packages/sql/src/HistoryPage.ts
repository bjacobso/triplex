import { Effect } from "effect";
import {
  ReadError,
  createParamCollector,
  type SqlDialect,
  type TripleRow,
} from "@triplex-internal/core/internal";
import type { StorageAdapterService } from "@triplex-internal/core/runtime";
import type { SqlStatementRunner } from "./SqlQueryExecutor.js";

/**
 * A history page seeks `idx_entity_recorded_position`, or
 * `idx_entity_attribute_history` for one attribute, from the cursor position and
 * stops after `limit` rows, so its cost follows the page, not the entity's history.
 */
export const makeSqlHistoryPage =
  (runner: SqlStatementRunner, dialect: SqlDialect): StorageAdapterService["historyPage"] =>
  (entityId, attribute, snapshotPosition, after, limit) => {
    const p = createParamCollector(dialect);
    const where = [`entity_id = ${p.add(entityId)}`];
    if (attribute !== undefined) where.push(`attribute = ${p.add(attribute)}`);
    where.push(`recorded_position <= ${p.add(snapshotPosition)}`);
    if (after !== undefined) {
      const position = p.add(after.position);
      // The leading range keeps the index seek; the disjunction orders ties by ID.
      where.push(
        `recorded_position >= ${position}`,
        `(recorded_position > ${position} OR id > ${p.add(after.id)})`,
      );
    }
    return runner
      .run<TripleRow>(
        `SELECT * FROM triples WHERE ${where.join(" AND ")} ORDER BY recorded_position, id LIMIT ${p.add(limit)}`,
        p.params,
      )
      .pipe(
        Effect.mapError(
          (cause) => new ReadError({ message: "Failed to read history page", cause }),
        ),
      );
  };
