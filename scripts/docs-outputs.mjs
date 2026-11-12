// Regenerates (or, with --check, verifies) every saved output the homepage displays.
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
for (const script of ["docs/snippets/home/site-safety/run.ts", "docs/snippets/home/hero-run.ts"]) {
  execFileSync("tsx", ["--tsconfig", "docs/snippets/tsconfig.json", script, ...args], {
    stdio: "inherit",
  });
}
