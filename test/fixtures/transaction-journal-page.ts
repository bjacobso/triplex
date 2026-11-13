import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { EntityId, Triples, number } from "@triplex-build/triplex";
import { makeSqlTransactionJournalLookup, SqliteDialect } from "@triplex-build/triplex/sql";
import { expect } from "vitest";
import { insertSyntheticTransactions } from "./transaction-prefix-index.js";

/** Counts storage rows a measured `transactions` call reads, when the backend can expose them. */
export interface JournalPageMeter {
  readonly reset: () => void;
  readonly rows: () => number;
}

/**
 * An unfiltered `transactions({ after })` page must seek from `after`: with 10 or
 * 10000 earlier commands it returns the same page and, when metered, reads the
 * same number of storage rows.
 */
export const transactionJournalPagePlan = (
  backend: "sqlite" | "postgres",
  meter?: JournalPageMeter,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const t = yield* Triples;
    const wanted = [];
    for (let i = 0; i < 3; i++)
      wanted.push(
        yield* t.transact(
          [
            {
              op: "assert",
              entityId: EntityId.make(`journal:${i}`),
              attribute: ":journal/value",
              value: number(i),
            },
          ],
          { actor: "journal:fixture" },
        ),
      );
    const base = wanted.at(-1)!.position;
    const first = yield* t.transactions({ limit: 2 });
    expect(first.transactions.map((record) => record.txId)).toEqual(
      wanted.slice(0, 2).map((result) => result.txId),
    );
    expect(first.transactions.every((record) => record.actor === "journal:fixture")).toBe(true);
    const measurements = [];
    for (const count of [10, 10000]) {
      yield* insertSyntheticTransactions(base, count);
      yield* sql.unsafe("ANALYZE triples");
      const tail = base + count - 2;
      meter?.reset();
      const page = yield* t.transactions({ after: tail, limit: 2 });
      const rows = meter?.rows();
      expect(page.transactions.map((record) => record.position)).toEqual([tail + 1, tail + 2]);
      expect(page.transactions.map((record) => record.changes[0]?.entityId)).toEqual([
        `noise:${count - 2}`,
        `noise:${count - 1}`,
      ]);
      expect(page.next).toBe(base + count);
      expect((yield* t.transactions({ after: page.next! })).transactions).toEqual([]);
      const resumed = yield* t.transactions({ after: wanted[1]!.position, limit: 2 });
      expect(resumed.transactions.map((record) => record.txId)).toEqual([
        wanted[2]!.txId,
        expect.stringMatching(/^_tx\//),
      ]);
      let captured: { statement: string; params: readonly unknown[] } | undefined;
      const dialect =
        backend === "postgres"
          ? {
              ...SqliteDialect,
              name: "postgresql" as const,
              paramPlaceholder: (i: number) => `$${i + 1}`,
            }
          : SqliteDialect;
      yield* makeSqlTransactionJournalLookup(
        {
          run: (statement, params) => {
            captured = { statement, params };
            return Effect.succeed([]);
          },
        },
        dialect,
      )(tail, 2);
      const plan = JSON.stringify(
        yield* sql.unsafe(
          `${backend === "postgres" ? "EXPLAIN (ANALYZE, FORMAT JSON)" : "EXPLAIN QUERY PLAN"} ${captured!.statement}`,
          captured!.params,
        ),
      );
      if (backend === "sqlite") {
        expect(plan).toContain("idx_attribute_history");
        expect(plan).not.toContain("TEMP B-TREE");
      } else if (count === 10000) {
        // A tiny table may sequentially scan; a large journal must seek, not sort.
        expect(plan).toContain("idx_attribute_history");
        expect(plan).not.toContain('"Sort"');
      }
      measurements.push({ earlierCommands: count, rows, plan });
    }
    if (meter) expect(measurements[0]!.rows).toBe(measurements[1]!.rows);
    return measurements;
  });
