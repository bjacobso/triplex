import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Absolute path of the built CLI entry that the package publishes. */
export const builtCli = join(root, "dist", "cli.js");

const newestMtime = (directory: string): number =>
  Math.max(
    ...readdirSync(directory, { withFileTypes: true }).map((entry) =>
      entry.isDirectory()
        ? newestMtime(join(directory, entry.name))
        : statSync(join(directory, entry.name)).mtimeMs,
    ),
  );

/**
 * Process-level CLI tests run the built entry rather than transpiling `src` with tsx per
 * invocation, which took over a minute under a parallel workspace run. `pnpm test` builds the
 * package first (see `turbo.json`); a direct `vitest` run against stale output fails loudly here.
 */
export const assertBuiltCliIsFresh = (): void => {
  if (!existsSync(builtCli) || statSync(builtCli).mtimeMs < newestMtime(join(root, "src"))) {
    throw new Error(
      "packages/cli/dist is missing or older than src; run `pnpm --filter @triplex-build/triplex-cli build`",
    );
  }
};

/** Node arguments that run the built CLI with `args`. */
export const cliArgs = (args: readonly string[]): string[] => [
  "--disable-warning=ExperimentalWarning",
  builtCli,
  ...args,
];
