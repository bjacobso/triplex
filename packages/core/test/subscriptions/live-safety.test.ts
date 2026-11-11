import { expect, it } from "vitest";
import { extractDependencies } from "../../src/subscriptions/extract-dependencies.js";
import { checkInvalidation } from "../../src/subscriptions/invalidation.js";

it("mixed dynamic dependencies bypass every namespace and entity filter", () => {
  const deps = extractDependencies({
    find: ["?v"],
    where: [
      ["fixed:a", ":fixed/name", "?v"],
      ["?e", "?attr", "?other"],
    ],
  });
  expect(
    checkInvalidation(deps, [
      { entityId: "elsewhere:b", attribute: ":elsewhere/status", operation: "assert" },
    ]).affected,
  ).toBe(true);
});
it("a rule constant cannot narrow unrelated base relation entity ids", () => {
  const deps = extractDependencies({
    find: ["?worker"],
    where: [["worker", "placement:a", "?worker"]],
    rules: [
      {
        name: "worker",
        body: [
          ["?placement", ":placement/worker", "?worker"],
          ["?worker", ":worker/ready", true],
        ],
      },
    ],
  });
  expect(
    checkInvalidation(deps, [
      { entityId: "worker:b", attribute: ":worker/ready", operation: "assert" },
    ]).affected,
  ).toBe(true);
});
