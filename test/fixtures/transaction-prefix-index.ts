import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { EntityId, TransactionId, Triples, number } from "@triplex-build/triplex";
import { makeSqlTransactionJournal, SqliteDialect } from "@triplex-build/triplex/sql";
import { expect } from "vitest";

const fixtureId = (value: number): string => {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let encoded = "";
  do {
    encoded = alphabet[value % 32]! + encoded;
    value = Math.floor(value / 32);
  } while (value > 0);
  return encoded.padStart(26, "0");
};

/**
 * Replace earlier synthetic rows with `count` complete one-change commands at
 * positions `base + 1 .. base + count` (one fact, one journal row, one entity
 * row each), then advance the commit head.
 */
export const insertSyntheticTransactions = (base: number, count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM triples WHERE id LIKE '00000000000000000000%'`;
    yield* sql`DELETE FROM triplex_transaction_entities WHERE entity_id LIKE 'noise:%'`;
    yield* sql`DELETE FROM triplex_transactions WHERE position > ${base}`;
    for (let offset = 0; offset < count; offset += 100) {
      const batch = Array.from({ length: Math.min(100, count - offset) }, (_, index) => {
        const i = offset + index;
        return {
          i,
          tx: `_tx/${fixtureId(100001 + i)}`,
          entity: `noise:${i}`,
          id: fixtureId(i * 5 + 1),
          position: base + i + 1,
        };
      });
      const facts = batch.map(({ i, tx, entity, id, position }) => ({
        id,
        entity_id: entity,
        attribute: ":noise/value",
        value_type: "number",
        value_string: null,
        value_number: i,
        value_datetime: null,
        value_json: null,
        recorded_at: 0,
        recorded_position: position,
        valid_from: 0,
        tx_id: tx,
        entity_type: "Noise",
      }));
      const journal = batch.map(({ tx, id, position }) => ({
        tx_id: tx,
        position,
        instant: 0,
        changes: JSON.stringify([[id, "assert"]]),
      }));
      const entities = batch.map(({ tx, entity, position }) => ({
        entity_id: entity,
        position,
        tx_id: tx,
      }));
      yield* sql`INSERT INTO triples ${sql.insert(facts)}`;
      yield* sql`INSERT INTO triplex_transactions ${sql.insert(journal)}`;
      yield* sql`INSERT INTO triplex_transaction_entities ${sql.insert(entities)}`;
    }
    yield* sql`UPDATE triplex_commit_position SET position = ${base + count} WHERE singleton = 1`;
  });

/** The journal statements an adapter would run, captured for EXPLAIN. */
export const captureJournalStatement = (
  backend: "sqlite" | "postgres",
  read: (journal: ReturnType<typeof makeSqlTransactionJournal>) => Effect.Effect<unknown, unknown>,
) =>
  Effect.gen(function* () {
    let captured: { statement: string; params: readonly unknown[] } | undefined;
    const dialect =
      backend === "postgres"
        ? {
            ...SqliteDialect,
            name: "postgresql" as const,
            paramPlaceholder: (i: number) => `$${i + 1}`,
          }
        : SqliteDialect;
    yield* read(
      makeSqlTransactionJournal(
        {
          run: (statement, params) => {
            captured = { statement, params };
            return Effect.succeed([]);
          },
        },
        dialect,
      ),
    ).pipe(Effect.ignore);
    return captured!;
  });

/** Complete synthetic unrelated commands plus actual related commands. */
export const transactionPrefixIndexPlan = (backend: "sqlite" | "postgres") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const t = yield* Triples;
    const version = yield* sql.unsafe(
      backend === "postgres" ? "SELECT version() AS version" : "SELECT sqlite_version() AS version",
    );
    const wanted = [];
    for (let i = 0; i < 3; i++)
      wanted.push(
        yield* t.transact(
          [
            {
              op: "assert",
              entityId: EntityId.make(`feed:match:a:${i}`),
              attribute: ":feed/value",
              value: number(i),
            },
            {
              op: "assert",
              entityId: EntityId.make(`feed:match:b:${i}`),
              attribute: ":feed/value",
              value: number(i),
            },
            {
              op: "assert",
              entityId: EntityId.make(`other:included:${i}`),
              attribute: ":feed/value",
              value: number(i),
            },
          ],
          { actor: "feed:fixture" },
        ),
      );
    const base = wanted.at(-1)!.position;
    const evidence = [];
    for (const count of [10, 10000]) {
      yield* insertSyntheticTransactions(base, count);
      const noiseReceipt = yield* t.transaction(TransactionId.make(`_tx/${fixtureId(100001)}`));
      expect(noiseReceipt).toMatchObject({
        position: base + 1,
        changes: [{ op: "assert", entityId: "noise:0" }],
      });
      const page = yield* t.transactions({ entityIdPrefix: "feed:match:", limit: 2 });
      expect(page.transactions.map((record) => record.txId)).toEqual(
        wanted.slice(0, 2).map((result) => result.txId),
      );
      expect(
        page.transactions.every(
          (record) => record.changes.length === 3 && record.actor === "feed:fixture",
        ),
      ).toBe(true);
      const next = yield* t.transactions({
        entityIdPrefix: "feed:match:",
        after: page.next!,
        limit: 2,
      });
      expect(next.transactions.map((record) => record.txId)).toEqual([wanted[2]!.txId]);
      yield* sql.unsafe("ANALYZE triplex_transaction_entities");
      yield* sql.unsafe("ANALYZE triplex_transactions");
      const query = yield* captureJournalStatement(backend, (journal) =>
        journal.transactionEntriesForEntityPrefix("feed:match:", 0, 2),
      );
      const plan = yield* sql.unsafe(
        `${backend === "postgres" ? "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)" : "EXPLAIN QUERY PLAN"} ${query.statement}`,
        query.params,
      );
      // The prefix is a range on the entity rows' primary key.
      if (backend === "sqlite")
        expect(JSON.stringify(plan)).toMatch(
          /SEARCH e USING (COVERING )?INDEX sqlite_autoindex_triplex_transaction_entities_1 \(entity_id>\? AND entity_id<\?\)/,
        );
      else if (count === 10000)
        expect(JSON.stringify(plan)).toContain("triplex_transaction_entities_pkey");
      evidence.push({ backend, unrelatedCommands: count, statement: query.statement, plan });
    }
    const path = process.env["TRIPLEX_FEED_PLANS"];
    if (path)
      writeFileSync(
        path,
        JSON.stringify(
          {
            sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
            dirty:
              execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length >
              0,
            node: process.version,
            databaseVersion: version,
            measuredAt: new Date().toISOString(),
            evidence,
          },
          null,
          2,
        ) + "\n",
      );
  });
