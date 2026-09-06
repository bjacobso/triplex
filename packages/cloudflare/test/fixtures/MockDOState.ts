import Database from "better-sqlite3";
import type { DOState, SqlStorage, SqlStorageCursor, SqlStorageValue } from "../../src/index.js";

const bindValue = (value: SqlStorageValue): string | number | Buffer | null =>
  value instanceof ArrayBuffer ? Buffer.from(value) : value;

export const makeMockDOState = (): DOState => {
  const database = new Database(":memory:");
  const sql: SqlStorage = {
    exec: <Row>(query: string, ...params: SqlStorageValue[]): SqlStorageCursor<Row> => {
      const statement = database.prepare(query);
      const bound = params.map(bindValue);
      const bindings = /\?[1-9][0-9]*/.test(query)
        ? Object.fromEntries(bound.map((value, index) => [String(index + 1), value]))
        : bound;
      const reader = statement.reader;
      const result = Array.isArray(bindings)
        ? reader
          ? statement.all(...bindings)
          : statement.run(...bindings)
        : reader
          ? statement.all(bindings)
          : statement.run(bindings);
      const rows = (reader ? result : []) as Row[];
      const columns = reader ? statement.columns().map((column) => column.name) : [];
      return {
        [Symbol.iterator]: () => rows[Symbol.iterator](),
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
          return rows[0]!;
        },
        raw: function* <R extends SqlStorageValue[]>(): IterableIterator<R> {
          for (const row of rows) {
            yield columns.map((column) => (row as Record<string, SqlStorageValue>)[column]) as R;
          }
        },
        columnNames: columns,
        rowsRead: rows.length,
        rowsWritten: reader ? 0 : Number(result.changes),
      };
    },
  };

  return {
    storage: {
      sql,
      transactionSync: <T>(closure: () => T): T => database.transaction(closure)(),
    },
  };
};
