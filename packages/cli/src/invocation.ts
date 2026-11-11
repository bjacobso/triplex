import { Context, Effect } from "effect";
import { Command, Param } from "effect/cli";

// Retain the declared options through command combinators using public annotations.
export const invocationOptions = Context.Reference<Command.Command.Config>(
  "triplex/cli/InvocationOptions",
  { defaultValue: () => ({}) },
);

export const makeCommand = <
  const Name extends string,
  const Config extends Command.Command.Config,
  E,
  R,
>(
  name: Name,
  config: Config,
  handler: (input: Command.Command.Config.Infer<Config>) => Effect.Effect<void, E, R>,
) => Command.make(name, config, handler).pipe(Command.annotate(invocationOptions, config));

type FlagNode =
  | Param.Single<typeof Param.flagKind, unknown>
  | Param.Map<typeof Param.flagKind, unknown, unknown>
  | Param.Transform<typeof Param.flagKind, unknown, unknown>
  | Param.Optional<typeof Param.flagKind, unknown>
  | Param.Variadic<typeof Param.flagKind, unknown>;

const singles = (
  param: Param.Param<typeof Param.flagKind, unknown>,
): readonly Param.Single<typeof Param.flagKind, unknown>[] => {
  const node = param as FlagNode;
  if (node._tag === "Single") return [node];
  const inner = singles(node.param);
  return node._tag === "Transform"
    ? [...inner, ...node.alternatives.flatMap((alternative) => singles(alternative()))]
    : inner;
};

/** Recover the canonical command path even when CLI parsing fails before a handler runs. */
export const invocation = (root: Command.Command.Any, args: readonly string[]) => {
  const flags = new Map<string, Param.Single<typeof Param.flagKind, unknown>>();
  const collectOptions = (config: Command.Command.Config) => {
    for (const value of Object.values(config)) {
      if (Param.isParam(value)) {
        if (value.kind !== Param.flagKind) continue;
        for (const single of singles(value)) {
          for (const name of [single.name, ...single.aliases]) {
            flags.set(`${name.length === 1 ? "-" : "--"}${name}`, single);
          }
        }
      } else collectOptions(value as Command.Command.Config);
    }
  };
  const collect = (command: Command.Command.Any) => {
    collectOptions(Context.get(command.annotations, invocationOptions));
    for (const group of command.subcommands) for (const child of group.commands) collect(child);
  };
  collect(root);
  let current = root;
  const path: string[] = [];
  let debug = false;
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!positional && arg === "--") {
      positional = true;
      continue;
    }
    if (!positional && arg.startsWith("-")) {
      const [name, inlineValue] = arg.split("=", 2);
      const flag = flags.get(name!);
      if (flag !== undefined) {
        if (flag.primitiveType._tag === "Boolean") {
          const next = inlineValue ?? args[i + 1];
          if (flag.name === "debug") debug = next !== "false";
          if (inlineValue === undefined && (next === "true" || next === "false")) i++;
        } else if (inlineValue === undefined && flag.optionalValue === undefined) i++;
      }
      continue;
    }
    const child = current.subcommands
      .flatMap((group) => group.commands)
      .find((command) => command.name === arg || command.alias === arg);
    if (child !== undefined) {
      path.push(child.name);
      current = child;
    }
  }
  if (path.length === 0) return { command: root.name, debug };
  if (current.subcommands.length > 0) path.push("unknown");
  return { command: path.join("."), debug };
};
