/**
 * Runs the hero program and writes the slim, deterministic JSON the homepage hero
 * animation replays. `--check` fails instead of writing when the output drifts.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect } from "effect";
import { main } from "./hero.ts";

const day = (instant: number | null | undefined) =>
  instant === null || instant === undefined ? null : new Date(instant).toISOString().slice(0, 10);

const result = await Effect.runPromise(main);

// Stable short names for triples and transactions; raw IDs and wall-clock instants vary per run.
const tripleNames = new Map<string, string>();
const tripleName = (id: string) => {
  if (!tripleNames.has(id)) tripleNames.set(id, `f${tripleNames.size + 1}`);
  return tripleNames.get(id)!;
};
const receipt = (r: typeof result.hired) => ({
  position: r.position,
  actor: r.actor,
  commandId: r.commandId,
  changes: r.changes.map((c) => ({
    op: c.op,
    fact: tripleName(c.tripleId),
    attribute: c.attribute,
    value: c.value?.type === "string" ? c.value.value : null,
    validFrom: day(c.validFrom),
    validTo: day(c.validTo),
  })),
});

const output = {
  release: { label: "workers-v1", id: result.release.snapshot.id.slice(0, 15) },
  commands: [receipt(result.hired), receipt(result.moved), receipt(result.corrected)],
  knownThen: result.knownThen?.values ?? null,
  now: result.now?.values ?? null,
  why: result.why.transactions.map((t) => ({
    position: t.position,
    actor: t.actor,
    commandId: t.commandId,
    release: t.release.status === "found" ? t.release.label : null,
  })),
};

const file = resolve(import.meta.dirname, "output/hero.json");
const text = `${JSON.stringify(output, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const existing = await readFile(file, "utf8").catch(() => "");
  if (existing !== text) {
    console.error(`${file} is out of date; run pnpm docs:outputs`);
    process.exit(1);
  }
  console.log("Hero output matches the program.");
} else {
  await writeFile(file, text);
  console.log(`Wrote ${file}`);
}
