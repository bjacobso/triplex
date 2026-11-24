/**
 * Triplex's ordered KV contract over a Durable Object's SQLite storage: one
 * table of byte keys and values. SQLite compares BLOBs with memcmp, so its
 * order is the lexicographic byte order the hexastore needs. A transaction
 * buffers its writes and applies them in one `transactionSync` when it
 * succeeds, as the in-memory backend does.
 */
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import {
  KvBackend,
  type KvBackendService,
  type KvEntry,
  type KvTransaction,
  type RangeOptions,
} from "@triplex-build/triplex/runtime";
import { Effect, Layer, Semaphore, Stream } from "effect";

type Row = { readonly k: ArrayBuffer; readonly v: ArrayBuffer };

const blob = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;
const text = (bytes: Uint8Array) => {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
};

export const durableObjectKv = (storage: DurableObjectStorage): KvBackendService => {
  const sql = storage.sql;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS triplex_kv (k BLOB PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID",
  );
  const get = (key: Uint8Array) => {
    const row = sql.exec<Row>("SELECT k, v FROM triplex_kv WHERE k = ?", blob(key)).toArray()[0];
    return row === undefined ? null : new Uint8Array(row.v);
  };
  const range = ({ start, end, limit, reverse }: RangeOptions): KvEntry[] =>
    sql
      .exec<Row>(
        `SELECT k, v FROM triplex_kv WHERE k >= ? AND k < ? ORDER BY k ${reverse ? "DESC" : "ASC"} LIMIT ?`,
        blob(start),
        blob(end),
        limit ?? -1,
      )
      .toArray()
      .map((row) => [new Uint8Array(row.k), new Uint8Array(row.v)] as const);
  const write = (entries: Iterable<readonly [Uint8Array, Uint8Array | null]>) =>
    storage.transactionSync(() => {
      for (const [key, value] of entries) {
        if (value === null) sql.exec("DELETE FROM triplex_kv WHERE k = ?", blob(key));
        else
          sql.exec(
            "INSERT OR REPLACE INTO triplex_kv (k, v) VALUES (?, ?)",
            blob(key),
            blob(value),
          );
      }
    });
  const mutex = Semaphore.makeUnsafe(1);

  return {
    get: (key) => Effect.sync(() => get(key)),
    set: (key, value) => Effect.sync(() => write([[key, value]])),
    delete: (key) => Effect.sync(() => write([[key, null]])),
    getRange: (options) => Stream.suspend(() => Stream.fromIterable(range(options))),
    transact: (fn) =>
      mutex.withPermit(
        Effect.gen(function* () {
          // Keyed by the key's bytes as Latin-1 text, which sorts like the bytes.
          const buffer = new Map<string, readonly [Uint8Array, Uint8Array | null]>();
          const tx: KvTransaction = {
            get: (key) =>
              Effect.sync(() => {
                const buffered = buffer.get(text(key));
                return buffered === undefined ? get(key) : buffered[1];
              }),
            set: (key, value) => Effect.sync(() => void buffer.set(text(key), [key, value])),
            delete: (key) => Effect.sync(() => void buffer.set(text(key), [key, null])),
            getRange: (options) =>
              Stream.suspend(() => {
                const start = text(options.start);
                const end = text(options.end);
                const visible = new Map(
                  range({ start: options.start, end: options.end }).map((entry) => [
                    text(entry[0]),
                    entry,
                  ]),
                );
                for (const [key, entry] of buffer) {
                  if (key < start || key >= end) continue;
                  if (entry[1] === null) visible.delete(key);
                  else visible.set(key, entry as KvEntry);
                }
                const keys = [...visible.keys()].sort();
                if (options.reverse) keys.reverse();
                const selected = options.limit === undefined ? keys : keys.slice(0, options.limit);
                return Stream.fromIterable(selected.map((key) => visible.get(key)!));
              }),
          };
          const result = yield* fn(tx);
          write(buffer.values());
          return result;
        }),
      ),
    setAll: (entries) => Effect.sync(() => write(entries)),
    getMany: (keys) => Effect.sync(() => keys.map((key) => [key, get(key)] as const)),
    clear: () => Effect.sync(() => void sql.exec("DELETE FROM triplex_kv")),
  };
};

export const durableObjectKvLayer = (storage: DurableObjectStorage) =>
  Layer.sync(KvBackend, () => durableObjectKv(storage));
