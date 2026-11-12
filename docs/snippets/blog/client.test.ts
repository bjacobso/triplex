import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

// Use the same source-checkout runner as docs:outputs; the root package does not
// link Triplex to itself. Application snippets still import public package names.
const run = (file: string) =>
  JSON.parse(
    execFileSync(process.execPath, ["--import", "tsx", `docs/snippets/${file}`], {
      encoding: "utf8",
      env: { ...process.env, TSX_TSCONFIG_PATH: "docs/snippets/tsconfig.json" },
    }),
  );

it("runs declare/publish/command/get/projected query/asOf in the first program", () => {
  expect(run("client-getting-started.ts")).toEqual({
    person: { name: "Alice", employer: "company:acme" },
    relationships: [{ "?person": "Alice", "?company": "Acme" }],
    knownThen: { name: "Alice", employer: "company:acme" },
  });
});

it("runs the agent guide with enforcement, retry receipts, audit and derived work", () => {
  const result = run("client-site-safety-run.ts");
  expect(result.retry).toEqual(result.receipt);
  expect(result.audit).toEqual({
    actor: "user:dana",
    governedBy: "site-safety-v1",
    trainedAsKnownThen: false,
    trainedAsKnownNow: false,
  });
  expect(result.work.open).toEqual([{ "?worker": "worker:maria", "?site": "site:harbor" }]);
}, 15000);
