import { expect, it } from "vitest";
import { Command, Flag } from "effect/cli";
import { invocation, makeCommand, invocationOptions } from "../src/invocation.js";
import { Effect } from "effect";

const run = makeCommand(
  "run",
  { novel: Flag.String("novel").pipe(Flag.withAlias("N")) },
  () => Effect.void,
);
const query = Command.make("query").pipe(Command.withSubcommands([run]));
const root = Command.make("triplex").pipe(
  Command.annotate(invocationOptions, {
    sqlite: Flag.String("sqlite"),
    debug: Flag.Boolean("debug"),
  }),
  Command.withSubcommands([query]),
);

it("derives new value flags and aliases from the command definition", () => {
  for (const args of [
    ["--sqlite", "query", "query", "run"],
    ["query", "--novel", "query", "run"],
    ["query", "-N", "query", "run"],
    ["--sqlite=x", "query", "run"],
  ])
    expect(invocation(root, args)).toEqual({ command: "query.run", debug: false });
});

it("keeps command aliases canonical and ignores operands after the leaf", () => {
  const tx = Command.make("transaction").pipe(
    Command.withAlias("tx"),
    Command.withSubcommands([Command.make("apply")]),
  );
  const tree = Command.make("triplex").pipe(Command.withSubcommands([tx]));
  expect(invocation(tree, ["tx", "apply", "query"])).toEqual({
    command: "transaction.apply",
    debug: false,
  });
  expect(invocation(tree, ["tx"])).toEqual({ command: "transaction.unknown", debug: false });
  expect(invocation(tree, [])).toEqual({ command: "triplex", debug: false });
});

it("tracks explicit boolean values without treating them as commands", () => {
  for (const [args, debug] of [
    [["--debug", "query", "run"], true],
    [["--debug", "false", "query", "run"], false],
    [["--debug=true", "query", "run"], true],
    [["--", "--debug", "query", "run"], false],
  ] as const)
    expect(invocation(root, args)).toEqual({ command: "query.run", debug });
});
