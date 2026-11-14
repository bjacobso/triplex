import { Effect, Result } from "effect";
import { SqlClient } from "effect/sql";
import {
  CommandAlreadyCommittedError,
  EntityId,
  number,
  type TriplesService,
} from "@triplex-build/triplex";
import { makeSqlTransactionJournal, SqliteDialect } from "@triplex-build/triplex/sql";
import { expect } from "vitest";

/**
 * Ask 0019 (A), condition 2: `transactionByCommand` keeps first-writer-wins
 * under concurrent writers, resting on the unique `command_id` of the journal
 * row. `writers` are independent `Triples` services over one database (separate
 * connections where the backend has them).
 */
export const commandFirstWriterPlan = (
  backend: "sqlite" | "postgres",
  writers: readonly TriplesService[],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const attempts = Array.from({ length: 8 }, (_, index) => writers[index % writers.length]!);
    for (const round of [0, 1, 2]) {
      const commandId = `race:${backend}:${round}`;
      const entity = (index: number) => EntityId.make(`race:${round}:${index}`);
      const results = yield* Effect.forEach(
        attempts,
        (writer, index) =>
          writer
            .transact(
              [
                {
                  op: "assert",
                  entityId: entity(index),
                  attribute: ":race/value",
                  value: number(index),
                },
              ],
              { actor: `writer:${index}`, commandId },
            )
            .pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      const winners = results.flatMap((result, index) =>
        Result.isSuccess(result) ? [{ index, value: result.success }] : [],
      );
      expect(winners).toHaveLength(1);
      const winner = winners[0]!;
      for (const [index, result] of results.entries()) {
        if (index === winner.index) continue;
        expect(Result.isFailure(result)).toBe(true);
        const failure = Result.isFailure(result) ? result.failure : undefined;
        expect(failure).toBeInstanceOf(CommandAlreadyCommittedError);
        expect(failure).toMatchObject({ commandId, transactionId: winner.value.txId });
        // A loser wrote nothing.
        expect(yield* writers[0]!.entity(entity(index))).toEqual([]);
      }
      const receipt = yield* writers[writers.length - 1]!.transactionByCommand(commandId);
      expect(receipt).toMatchObject({
        txId: winner.value.txId,
        position: winner.value.position,
        actor: `writer:${winner.index}`,
        commandId,
      });
      expect(receipt!.changes.map((change) => change.entityId)).toEqual([entity(winner.index)]);
      expect(
        yield* sql<{
          tx_id: string;
        }>`SELECT tx_id FROM triplex_transactions WHERE command_id = ${commandId}`,
      ).toEqual([{ tx_id: winner.value.txId }]);
    }

    // The unique command ID alone decides, without the write path's early lookup:
    // the shared SQL journal append, in two transactions, keeps the first writer.
    const dialect =
      backend === "postgres"
        ? {
            ...SqliteDialect,
            name: "postgresql" as const,
            paramPlaceholder: (i: number) => `$${i + 1}`,
          }
        : SqliteDialect;
    const journal = makeSqlTransactionJournal(
      { run: (statement, params) => sql.unsafe(statement, [...params]) },
      dialect,
    );
    const head = yield* writers[0]!.currentPosition();
    const entry = (txId: string, position: number) => ({
      txId,
      position,
      instant: 1,
      commandId: "race:direct",
      changes: [],
      entities: ["race:direct"],
    });
    const first = `_tx/${"A".repeat(26)}`;
    const second = `_tx/${"B".repeat(26)}`;
    expect(
      yield* sql.withTransaction(journal.appendTransaction(entry(first, head + 1))),
    ).toBeNull();
    expect(yield* sql.withTransaction(journal.appendTransaction(entry(second, head + 2)))).toBe(
      first,
    );
    expect(
      yield* sql<{
        tx_id: string;
      }>`SELECT tx_id FROM triplex_transactions WHERE position >= ${head + 1}`,
    ).toEqual([{ tx_id: first }]);
    expect(
      yield* sql<{
        tx_id: string;
      }>`SELECT tx_id FROM triplex_transaction_entities WHERE entity_id = 'race:direct'`,
    ).toEqual([{ tx_id: first }]);
    // And the constraint itself refuses a second row for the command.
    const duplicate = yield* sql`
      INSERT INTO triplex_transactions (tx_id, position, instant, command_id, changes)
      VALUES (${second}, ${head + 2}, 1, 'race:direct', '[]')`.pipe(Effect.result);
    expect(Result.isFailure(duplicate)).toBe(true);
    yield* sql`DELETE FROM triplex_transaction_entities WHERE entity_id = 'race:direct'`;
    yield* sql`DELETE FROM triplex_transactions WHERE tx_id = ${first}`;
  });
