import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { EntityId, TransactionId, Triples, number } from "@triplex-build/triplex";
import { makeSqlTransactionPrefixLookup, SqliteDialect } from "@triplex-build/triplex-sql";
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
    const row = (
      id: string,
      entity: string,
      attribute: string,
      type: string,
      position: number,
      tx: string,
      entityType: string,
      value: { text?: string; numeric?: number; datetime?: number; json?: string },
    ) => ({
      id,
      entity_id: entity,
      attribute,
      value_type: type,
      value_string: value.text ?? null,
      value_number: value.numeric ?? null,
      value_datetime: value.datetime ?? null,
      value_json: value.json ?? null,
      recorded_at: 0,
      recorded_position: position,
      valid_from: 0,
      tx_id: tx,
      entity_type: entityType,
    });
    for (const count of [10, 10000]) {
      yield* sql`DELETE FROM triples WHERE id LIKE '00000000000000000000%'`;
      for (let offset = 0; offset < count; offset += 100) {
        const rows = Array.from({ length: Math.min(100, count - offset) }, (_, index) => {
          const i = offset + index;
          const tx = `_tx/${fixtureId(100001 + i)}`,
            entity = `noise:${i}`,
            id = fixtureId(i * 5 + 1),
            position = base + i + 1;
          const change = {
            op: "assert",
            tripleId: id,
            entityId: entity,
            entityType: "Noise",
            attribute: ":noise/value",
            value: { type: "number", value: i },
            validFrom: 0,
            recordedAt: 0,
            assertionTxId: tx,
          };
          return [
            row(id, entity, ":noise/value", "number", position, tx, "Noise", { numeric: i }),
            row(fixtureId(i * 5 + 2), tx, ":_tx/position", "number", position, tx, "_Transaction", {
              numeric: position,
            }),
            row(
              fixtureId(i * 5 + 3),
              tx,
              ":_tx/instant",
              "datetime",
              position,
              tx,
              "_Transaction",
              { datetime: 0 },
            ),
            row(
              fixtureId(i * 5 + 4),
              tx,
              ":_tx/changed-entity",
              "ref",
              position,
              tx,
              "_Transaction",
              { text: entity },
            ),
            row(fixtureId(i * 5 + 5), tx, ":_tx/change", "json", position, tx, "_Transaction", {
              json: JSON.stringify(change),
            }),
          ];
        }).flat();
        yield* sql`INSERT INTO triples ${sql.insert(rows)}`;
      }
      yield* sql`UPDATE triplex_commit_position SET position = ${base + count} WHERE singleton = 1`;
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
      yield* sql.unsafe("ANALYZE triples");
      let captured: { statement: string; params: readonly unknown[] } | undefined;
      const dialect =
        backend === "postgres"
          ? {
              ...SqliteDialect,
              name: "postgresql" as const,
              paramPlaceholder: (i: number) => `$${i + 1}`,
            }
          : SqliteDialect;
      const lookup = makeSqlTransactionPrefixLookup(
        {
          run: (statement, params) => {
            captured = { statement, params };
            return Effect.succeed([]);
          },
        },
        dialect,
      );
      yield* lookup("feed:match:", 0, 2);
      const query = captured!;
      const plan = yield* sql.unsafe(
        `${backend === "postgres" ? "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)" : "EXPLAIN QUERY PLAN"} ${query.statement}`,
        query.params,
      );
      if (backend === "sqlite") expect(JSON.stringify(plan)).toContain("idx_ref_target");
      else if (count === 10000) expect(JSON.stringify(plan)).toContain("idx_tx_entity_prefix");
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
