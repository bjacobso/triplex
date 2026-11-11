import { expect, it } from "vitest";
import { Effect } from "effect";
import { attributesOf, checkAttributes } from "../../src/datalog/attributes.js";
import type { DatalogQuery } from "../../src/datalog/types.js";

it("collects constant attributes through negation, alternatives, rules and wrappers", () => {
  const query: DatalogQuery = {
    find: ["?e"],
    where: [
      ["?e", ":vendor/status", "?s"],
      ["?e", "?attribute", "?v"],
      ["not", ["?e", ":vendor/blocked", true]],
      [
        "or",
        [
          ["?e", ":vendor/a", true],
          ["not", ["?e", ":vendor/b", false]],
        ],
      ],
    ],
    rules: [
      {
        name: "related",
        body: [
          ["?x", ":vendor/parent", "?y"],
          ["related", "?x", "?y"],
        ],
      },
    ],
  };
  const expected = new Set([
    ":vendor/status",
    ":vendor/blocked",
    ":vendor/a",
    ":vendor/b",
    ":vendor/parent",
  ]);
  expect(attributesOf(query)).toEqual(expected);
  expect(attributesOf({ inner: query })).toEqual(expected);
});

it("reports the key, exact nested path and nearest spelling", async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      checkAttributes(
        {
          find: ["?e"],
          where: [
            ["?e", ":vendor/status", "?s"],
            ["not", ["?e", ":vendor/staus", true]],
          ],
        },
        new Set([":vendor/status"]),
      ),
    ),
  );
  expect(error).toMatchObject({
    _tag: "UnknownAttributeError",
    key: ":vendor/staus",
    path: "where[1][1][1]",
    suggestion: ":vendor/status",
  });
  expect(error.message).toContain('did you mean ":vendor/status"?');
});

it("accepts known and reserved attributes, and omits distant suggestions", async () => {
  await Effect.runPromise(
    checkAttributes(
      {
        find: ["?e"],
        where: [
          ["?e", ":vendor/status", "?s"],
          ["?e", ":triplex/anything", "?x"],
          ["?e", ":_tx/actor", "?a"],
        ],
      },
      new Set([":vendor/status"]),
    ),
  );
  const error = await Effect.runPromise(
    Effect.flip(
      checkAttributes(
        { find: ["?e"], where: [["?e", ":unrelated/xyz", true]] },
        new Set([":vendor/status"]),
      ),
    ),
  );
  expect(error.suggestion).toBeUndefined();
});

it("reports paths in alternatives, rule bodies and wrapped queries", async () => {
  const known = new Set([":vendor/status"]);
  const cases = [
    {
      query: {
        find: ["?e"],
        where: [
          [
            "or",
            [
              ["?e", ":vendor/status", true],
              ["?e", ":vendor/staus", true],
            ],
          ],
        ],
      },
      path: "where[0] alternative 1[1]",
    },
    {
      query: {
        find: ["?e"],
        where: [["related", "?e", "?v"]],
        rules: [{ name: "related", body: [["?x", ":vendor/staus", "?y"]] }],
      },
      path: "rules[0].body[0][1]",
    },
    {
      query: { inner: { find: ["?e"], where: [["?e", ":vendor/staus", true]] } },
      path: "inner.where[0][1]",
    },
  ] as const;
  for (const { query, path } of cases) {
    expect(await Effect.runPromise(Effect.flip(checkAttributes(query, known)))).toMatchObject({
      key: ":vendor/staus",
      path,
    });
  }
});
