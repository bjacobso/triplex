import { Effect } from "effect";
import {
  ReadError,
  WriteError,
  createParamCollector,
  type SqlDialect,
} from "@triplex-internal/core/internal";
import type { StorageAdapterService, OperationalEntryRecord } from "@triplex-internal/core/runtime";
import type { SqlStatementRunner } from "./SqlQueryExecutor.js";

type EntryStorage = Pick<
  StorageAdapterService,
  | "getOperationalEntry"
  | "pendingOperationalEntries"
  | "insertOperationalEntry"
  | "acknowledgeOperationalEntry"
>;

const decode = (row: Record<string, unknown>): OperationalEntryRecord => ({
  id: row["id"] as OperationalEntryRecord["id"],
  kind: row["kind"] as OperationalEntryRecord["kind"],
  scope: JSON.parse(row["scope"] as string) as OperationalEntryRecord["scope"],
  scopeToken: row["scope_token"] as OperationalEntryRecord["scopeToken"],
  idempotencyKey: JSON.parse(row["idempotency_key"] as string) as string,
  payload: row["payload"] as string,
  recordedPosition: Number(row["recorded_position"]),
  recordedAt: Number(row["recorded_at"]),
  txId: row["tx_id"] as OperationalEntryRecord["txId"],
  ...(row["acknowledged_position"] == null
    ? {}
    : {
        acknowledgedPosition: Number(row["acknowledged_position"]),
        acknowledgedAt: Number(row["acknowledged_at"]),
        acknowledgedTxId: row["acknowledged_tx_id"] as OperationalEntryRecord["txId"],
      }),
});

/** Indexed entry persistence. The caller owns transaction serialization and validation. */
export const makeSqlOperationalEntryStorage = (
  runner: SqlStatementRunner,
  dialect: SqlDialect,
): EntryStorage => {
  const read = (statement: string, params: readonly unknown[]) =>
    runner.run(statement, params).pipe(
      Effect.flatMap((rows) => Effect.try(() => rows.map(decode))),
      Effect.mapError(
        (cause) => new ReadError({ message: "Failed to read operational entries", cause }),
      ),
    );
  const write = (statement: string, params: readonly unknown[]) =>
    runner.run(statement, params).pipe(
      Effect.asVoid,
      Effect.mapError(
        (cause) => new WriteError({ message: "Failed to write operational entry", cause }),
      ),
    );
  return {
    getOperationalEntry: (id) => {
      const p = createParamCollector(dialect);
      return read(
        `SELECT * FROM triplex_operational_entries WHERE id = ${p.add(id)}`,
        p.params,
      ).pipe(Effect.map((rows) => rows[0] ?? null));
    },
    pendingOperationalEntries: (scan) => {
      const p = createParamCollector(dialect);
      const where = [`kind = ${p.add(scan.kind)}`, "acknowledged_position IS NULL"];
      if (scan.scopeToken !== undefined) where.push(`scope_token = ${p.add(scan.scopeToken)}`);
      if (scan.after !== undefined)
        where.push(
          `(recorded_position, id) > (${p.add(scan.after.recordedPosition)}, ${p.add(scan.after.id)})`,
        );
      return read(
        `SELECT * FROM triplex_operational_entries WHERE ${where.join(" AND ")} ORDER BY recorded_position, id LIMIT ${p.add(scan.limit)}`,
        p.params,
      );
    },
    insertOperationalEntry: (record) => {
      const p = createParamCollector(dialect);
      const values = [
        record.id,
        record.kind,
        JSON.stringify(record.scope),
        record.scopeToken,
        JSON.stringify(record.idempotencyKey),
        record.payload,
        record.recordedPosition,
        record.recordedAt,
        record.txId,
      ];
      return write(
        `INSERT INTO triplex_operational_entries (id, kind, scope, scope_token, idempotency_key, payload, recorded_position, recorded_at, tx_id) VALUES (${values.map((value) => p.add(value)).join(", ")})`,
        p.params,
      );
    },
    acknowledgeOperationalEntry: (id, position, instant, txId) => {
      const p = createParamCollector(dialect);
      return write(
        `UPDATE triplex_operational_entries SET acknowledged_position = ${p.add(position)}, acknowledged_at = ${p.add(instant)}, acknowledged_tx_id = ${p.add(txId)} WHERE id = ${p.add(id)} AND acknowledged_position IS NULL`,
        p.params,
      );
    },
  };
};
