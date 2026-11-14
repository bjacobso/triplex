/**
 * The SQL transaction journal: `triplex_transactions` (one row per journaled
 * transaction) and `triplex_transaction_entities` (one row per changed entity),
 * shared by the SQLite, PostgreSQL and Cloudflare adapters.
 */
import { Effect } from "effect";
import {
  ReadError,
  WriteError,
  checkedJournalEntry,
  createParamCollector,
  decodeJournalChanges,
  encodeJournalChanges,
  transactionPrefixBounds,
  type JournalEntry,
  type SqlDialect,
  type TripleRow,
} from "@triplex-internal/core/internal";
import type { StorageAdapterService } from "@triplex-internal/core/runtime";
import type { SqlStatementRunner } from "./SqlQueryExecutor.js";

interface TransactionRow {
  readonly tx_id: string;
  readonly position: number | string;
  readonly instant: number | string;
  readonly actor: string | null;
  readonly command_id: string | null;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly config_snapshot: string | null;
  readonly changes: string;
}

const COLUMNS =
  "tx_id, position, instant, actor, command_id, correlation_id, causation_id, config_snapshot, changes";
const qualified = (alias: string) =>
  COLUMNS.split(", ")
    .map((column) => `${alias}.${column}`)
    .join(", ");

const decodeRow = (row: TransactionRow): JournalEntry =>
  checkedJournalEntry({
    txId: row.tx_id,
    position: Number(row.position),
    instant: Number(row.instant),
    ...(row.actor === null ? {} : { actor: row.actor }),
    ...(row.command_id === null ? {} : { commandId: row.command_id }),
    ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
    ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
    ...(row.config_snapshot === null ? {} : { configSnapshot: row.config_snapshot }),
    changes: decodeJournalChanges(row.changes),
  });

export interface SqlTransactionJournalOptions {
  /**
   * Most bound parameters in one statement. Defaults to 1,500, far below
   * SQLite's and PostgreSQL's limits; Durable Object SQL allows 100.
   */
  readonly maxParameters?: number;
}

export type SqlTransactionJournal = Pick<
  StorageAdapterService,
  | "appendTransaction"
  | "transactionEntry"
  | "transactionEntryByCommand"
  | "transactionEntriesAfter"
  | "transactionEntriesForEntityPrefix"
  | "transactionEntriesForEntity"
  | "getByIds"
  | "recordedPositionAt"
>;

export const makeSqlTransactionJournal = (
  runner: SqlStatementRunner,
  dialect: SqlDialect,
  options: SqlTransactionJournalOptions = {},
): SqlTransactionJournal => {
  const maxParameters = options.maxParameters ?? 1_500;
  /** Entity rows per insert (three parameters each) and fact IDs per read. */
  const entityRows = Math.max(1, Math.floor(maxParameters / 3));
  const factIds = Math.max(1, maxParameters);
  const read = (statement: string, params: readonly unknown[], message: string) =>
    runner.run<TransactionRow & Record<string, unknown>>(statement, params).pipe(
      Effect.flatMap((rows) =>
        Effect.try({
          try: () => rows.map(decodeRow),
          catch: (cause) => new ReadError({ message: `${message}: corrupt journal entry`, cause }),
        }),
      ),
      Effect.mapError((cause) =>
        cause instanceof ReadError ? cause : new ReadError({ message, cause }),
      ),
    );

  const first = (entries: readonly JournalEntry[]) => entries[0] ?? null;

  const commandOwner = (commandId: string) => {
    const p = createParamCollector(dialect);
    return runner.run<{ readonly tx_id: string }>(
      `SELECT tx_id FROM triplex_transactions WHERE command_id = ${p.add(commandId)}`,
      p.params,
    );
  };

  const appendTransaction: StorageAdapterService["appendTransaction"] = (entry) =>
    Effect.gen(function* () {
      const p = createParamCollector(dialect);
      const values = [
        entry.txId,
        entry.position,
        entry.instant,
        entry.actor ?? null,
        entry.commandId ?? null,
        entry.correlationId ?? null,
        entry.causationId ?? null,
        entry.configSnapshot ?? null,
        encodeJournalChanges(entry.changes),
      ].map((value) => p.add(value));
      const insert = `INSERT INTO triplex_transactions (${COLUMNS}) VALUES (${values.join(", ")})`;
      if (entry.commandId === undefined) {
        yield* runner.run(insert, p.params);
      } else {
        // The unique command ID decides concurrent writers: first committed wins.
        const inserted = yield* runner.run<{ readonly tx_id: string }>(
          `${insert} ON CONFLICT (command_id) DO NOTHING RETURNING tx_id`,
          p.params,
        );
        if (inserted.length === 0) {
          const [owner] = yield* commandOwner(entry.commandId);
          if (owner === undefined)
            return yield* new WriteError({
              message: `Command ${entry.commandId} conflicted without an original transaction`,
            });
          return owner.tx_id;
        }
      }
      for (let start = 0; start < entry.entities.length; start += entityRows) {
        const chunk = entry.entities.slice(start, start + entityRows);
        const q = createParamCollector(dialect);
        const rows = chunk.map(
          (entityId) => `(${q.add(entityId)}, ${q.add(entry.position)}, ${q.add(entry.txId)})`,
        );
        yield* runner.run(
          `INSERT INTO triplex_transaction_entities (entity_id, position, tx_id) VALUES ${rows.join(", ")}`,
          q.params,
        );
      }
      return null;
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof WriteError
          ? cause
          : new WriteError({
              message: `Failed to append transaction ${entry.txId} to the journal: ${String(cause)}`,
              cause,
            }),
      ),
    );

  const transactionEntry: StorageAdapterService["transactionEntry"] = (txId) => {
    const p = createParamCollector(dialect);
    return read(
      `SELECT ${COLUMNS} FROM triplex_transactions WHERE tx_id = ${p.add(txId)}`,
      p.params,
      "Failed to read transaction",
    ).pipe(Effect.map(first));
  };

  const transactionEntryByCommand: StorageAdapterService["transactionEntryByCommand"] = (
    commandId,
  ) => {
    const p = createParamCollector(dialect);
    return read(
      `SELECT ${COLUMNS} FROM triplex_transactions WHERE command_id = ${p.add(commandId)}`,
      p.params,
      "Failed to read command transaction",
    ).pipe(Effect.map(first));
  };

  /** Seeks the unique position index from `after`; never reads the whole journal. */
  const transactionEntriesAfter: StorageAdapterService["transactionEntriesAfter"] = (
    after,
    limit,
  ) => {
    const p = createParamCollector(dialect);
    return read(
      `SELECT ${COLUMNS} FROM triplex_transactions WHERE position > ${p.add(after)} ORDER BY position LIMIT ${p.add(limit)}`,
      p.params,
      "Failed to read transaction journal page",
    );
  };

  /** A range on the entity rows' primary key, deduplicated by position. */
  const transactionEntriesForEntityPrefix: StorageAdapterService["transactionEntriesForEntityPrefix"] =
    (prefix, after, limit) => {
      const bounds = transactionPrefixBounds(prefix);
      if (bounds === null || (dialect.name === "postgresql" && prefix.includes("\0")))
        return Effect.succeed([]);
      const p = createParamCollector(dialect);
      const where = [`e.entity_id >= ${p.add(bounds.lower)}`, `e.position > ${p.add(after)}`];
      if (bounds.upper !== undefined) where.push(`e.entity_id < ${p.add(bounds.upper)}`);
      return read(
        `SELECT ${COLUMNS} FROM triplex_transactions WHERE position IN (SELECT DISTINCT e.position FROM triplex_transaction_entities e WHERE ${where.join(" AND ")} ORDER BY e.position LIMIT ${p.add(limit)}) ORDER BY position`,
        p.params,
        "Failed to read entity-prefix transaction journal page",
      );
    };

  const transactionEntriesForEntity: StorageAdapterService["transactionEntriesForEntity"] = (
    entityId,
    snapshotPosition,
    beforePosition,
    limit,
  ) => {
    const p = createParamCollector(dialect);
    const where = [
      `e.entity_id = ${p.add(entityId)}`,
      `e.position <= ${p.add(snapshotPosition)}`,
      ...(beforePosition === undefined ? [] : [`e.position < ${p.add(beforePosition)}`]),
    ];
    return read(
      `SELECT ${qualified("t")} FROM triplex_transaction_entities e JOIN triplex_transactions t ON t.position = e.position WHERE ${where.join(" AND ")} ORDER BY e.position DESC LIMIT ${p.add(limit)}`,
      p.params,
      "Failed to read entity transaction journal",
    );
  };

  const getByIds: StorageAdapterService["getByIds"] = (ids) =>
    Effect.gen(function* () {
      const rows: TripleRow[] = [];
      for (let start = 0; start < ids.length; start += factIds) {
        const chunk = ids.slice(start, start + factIds);
        const p = createParamCollector(dialect);
        rows.push(
          ...(yield* runner.run<TripleRow>(
            `SELECT * FROM triples WHERE id IN (${chunk.map((id) => p.add(id)).join(", ")})`,
            p.params,
          )),
        );
      }
      return rows;
    }).pipe(
      Effect.mapError(
        (cause) => new ReadError({ message: "Failed to read journal facts by ID", cause }),
      ),
    );

  /** Instants are integers, so `instant <= x` is `instant <= floor(x)` and stays indexable. */
  const recordedPositionAt: StorageAdapterService["recordedPositionAt"] = (instant, head) => {
    const p = createParamCollector(dialect);
    return runner
      .run<{ readonly position: number | string | null }>(
        `SELECT MAX(position) AS position FROM triplex_transactions WHERE instant <= ${p.add(Math.floor(instant))} AND position <= ${p.add(head)}`,
        p.params,
      )
      .pipe(
        Effect.map((rows) => Number(rows[0]?.position ?? 0)),
        Effect.mapError(
          (cause) => new ReadError({ message: "Failed to resolve recorded basis", cause }),
        ),
      );
  };

  return {
    appendTransaction,
    transactionEntry,
    transactionEntryByCommand,
    transactionEntriesAfter,
    transactionEntriesForEntityPrefix,
    transactionEntriesForEntity,
    getByIds,
    recordedPositionAt,
  };
};
