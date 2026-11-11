import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphConstraint } from "@triplex-build/triplex/config";
import { expect, it } from "vitest";

it("reports actionable diagnostics and exits nonzero over a SQLite file", () => {
  const dir = mkdtempSync(join(tmpdir(), "triplex-diagnostics-"));
  const invoke = (args: string[], input?: unknown) => {
    const file = join(dir, "input.json");
    if (input !== undefined) writeFileSync(file, JSON.stringify(input));
    return spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        'process.argv.splice(1, 0, "triplex"); globalThis.__TRIPLEX_CLI_VERSION__ = "test"; await import("./src/cli.ts")',
        "--",
        "--sqlite",
        join(dir, "db.sqlite"),
        ...args,
        ...(input === undefined ? [] : ["--input", file]),
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );
  };
  const failure = (args: string[], input: unknown, code: string, path?: string) => {
    const result = invoke(args, input);
    expect(result.status, result.stderr).not.toBe(0);
    const body = JSON.parse(result.stderr);
    expect(body).toMatchObject({
      ok: false,
      command: args[0] === "query" ? "query.run" : args.slice(0, 2).join("."),
      error: { code, fix: expect.any(String), retryable: false, ...(path ? { path } : {}) },
    });
    if (!args.includes("--debug")) expect(body.cause).toBeUndefined();
    return body;
  };
  try {
    failure(
      ["query", "run"],
      { find: ["?missing"], where: [["?e", ":name", "?name"]] },
      "datalog.unbound-variable",
      "find",
    );
    failure(
      ["query", "--sqlite", join(dir, "db.sqlite"), "run"],
      { find: ["?missing"], where: [["?e", ":name", "?name"]] },
      "cli.arguments",
      "$args",
    );
    failure(
      ["query", "run", "--debug=false"],
      { find: ["?missing"], where: [["?e", ":name", "?name"]] },
      "datalog.unbound-variable",
      "find",
    );
    const debug = failure(
      ["query", "run", "--debug"],
      { find: ["?missing"], where: [["?e", ":name", "?name"]] },
      "datalog.unbound-variable",
      "find",
    );
    expect(debug.cause).toContain("UnboundVariableError");
    const request = {
      operations: [
        {
          op: "assert",
          entityId: "person:a",
          entityType: "Person",
          attribute: ":name",
          value: { type: "string", value: "A" },
        },
      ],
      meta: { actor: "test", commandId: "one" },
    };
    const success = invoke(["transaction", "apply"], request);
    expect(success.status, success.stderr).toBe(0);
    failure(["transaction", "apply"], request, "transaction.command-already-committed");
    failure(
      ["transaction", "apply"],
      {
        ...request,
        operations: [{ ...request.operations[0], entityId: "person:b" }],
        meta: {
          actor: "test",
          commandId: "two",
          enforce: { constraints: [GraphConstraint.unique("Person", ":name").rule] },
        },
      },
      "constraint.violation",
      expect.any(String),
    );
    failure(["transaction", "apply"], { operations: "wrong" }, "cli.input-schema", "$.operations");
    writeFileSync(join(dir, "bad.json"), "{");
    const malformed = invoke(["query", "run", "--input", join(dir, "bad.json")]);
    expect(malformed.status).not.toBe(0);
    expect(JSON.parse(malformed.stderr)).toMatchObject({
      error: { code: "cli.input-json", path: "$" },
    });
    const missing = invoke(["query", "run", "--input", join(dir, "missing.json")]);
    expect(missing.status).not.toBe(0);
    expect(JSON.parse(missing.stderr)).toMatchObject({
      error: { code: "cli.input-read", fix: expect.any(String) },
    });
    const badArgs = invoke(["entity", "list", "--limit", "bad"]);
    expect(badArgs.status).not.toBe(0);
    expect(JSON.parse(badArgs.stderr)).toMatchObject({
      error: { code: "cli.arguments", fix: expect.any(String) },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
