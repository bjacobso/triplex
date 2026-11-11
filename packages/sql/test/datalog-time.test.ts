import { Effect } from "effect";
import { expect, it } from "vitest";
import { makeSqlQueryExecutor, type SqlStatementRunner } from "../src/SqlQueryExecutor.js";

it("decodes nullable BIGINT bounds in one statement, with only an optional wrapper count", async () => {
  const calls: string[] = [];
  const runner: SqlStatementRunner = {
    run: <Row extends Record<string, unknown>>(sql: string) => {
      calls.push(sql);
      const row = sql.includes("SELECT COUNT(*)")
        ? { total_count: "2" }
        : {
            "?from": null,
            "?to": null,
            _triplex_value_0_type: "number",
            _triplex_value_0_number: "1700000000123",
            _triplex_value_1_type: null,
            _triplex_value_1_number: null,
          };
      return Effect.succeed([row as unknown as Row]);
    },
  };
  const executor = makeSqlQueryExecutor(runner);
  const query = {
    validTime: "all",
    find: ["?from", "?to"],
    where: [{ pattern: ["?e", ":status", "active"], valid: { from: "?from", to: "?to" } }],
  } as const;
  expect(
    (await Effect.runPromise(executor.execute(query, false, { recordedPosition: 1 }))).results,
  ).toEqual([{ "?from": 1700000000123, "?to": null }]);
  expect(calls).toHaveLength(1);
  calls.length = 0;
  await Effect.runPromise(
    executor.executePage({ inner: query, includeCount: true }, false, { recordedPosition: 1 }),
  );
  expect(calls).toHaveLength(2);
});
