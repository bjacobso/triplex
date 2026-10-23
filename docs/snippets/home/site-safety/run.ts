/**
 * Runs the homepage site-safety scenario end to end and writes every output the
 * homepage displays. `--check` fails instead of writing when an output drifts,
 * so the published answers are always produced by the published code.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { EntityId, Triples, type TransactionChange } from "@triplex-build/triplex";
import { ConfigStore } from "@triplex-build/triplex/config";
import { ContentId } from "@triplex-build/triplex/content";

import {
  Api,
  InMemory,
  MAR_2,
  Placement,
  PlacementV2,
  Site,
  Worker,
  audit,
  harbor,
  maria,
  openWork,
  placeWorker,
  publish,
} from "./app.ts";
import { JUN_1, correctTraining, onboard, pier, placeWorkerOnce, recordTraining } from "./story.ts";

const day = (instant: number) => new Date(instant).toISOString().slice(0, 10);

// `+` asserts and `−` retracts; valid time is the half-open interval [validFrom, validTo).
const describe = (change: TransactionChange) => {
  const value =
    change.value?.type === "ref" ? change.value.value : JSON.stringify(change.value?.value);
  const from = change.validFrom === undefined ? "" : day(change.validFrom);
  const valid = change.validTo === undefined ? `from ${from}` : `[${from}, ${day(change.validTo)})`;
  return `${change.op === "assert" ? "+" : "−"} \`${change.attribute}\` \`${value}\` ${valid}`;
};

// Recorded time comes from the wall clock; keep each step on a distinct instant.
const tick = Effect.sleep("5 millis");

// Serve the `Api` layer in process and read Maria as of March 2, as known then and now.
const readOverHttp = (recordedAt: number) =>
  Effect.gen(function* () {
    const database = yield* Effect.context<Triples | ConfigStore.ConfigStore>();
    const { handler, dispose } = HttpRouter.toWebHandler(
      Api.pipe(Layer.provide(Layer.succeedContext(database))),
      { disableLogger: true },
    );
    const read = (query: string) =>
      Effect.promise(async () => {
        const url = `http://triplex.local/api/rest/latest/workers/${maria}?validAt=${MAR_2}${query}`;
        const response = await handler(new Request(url));
        if (!response.ok) throw new Error(`${url} → ${response.status} ${await response.text()}`);
        return response.json();
      });
    const asKnownThen = yield* read(`&recordedAt=${recordedAt}`);
    const asKnownNow = yield* read("");
    yield* Effect.promise(dispose);
    return { asKnownThen, asKnownNow };
  });

const scenario = Effect.gen(function* () {
  const triples = yield* Triples;
  const release = yield* publish("hr-2026.1", [Site, Worker, Placement]);
  yield* tick;
  yield* onboard;
  yield* tick;
  yield* recordTraining;
  yield* tick;
  const placed = yield* placeWorker(
    release.snapshot,
    EntityId.make("placement:maria-harbor"),
    maria,
    harbor,
  );
  yield* tick;
  const retried = yield* placeWorkerOnce(release.snapshot);
  if (retried !== placed.position) {
    throw new Error("a retried command must return its first receipt");
  }
  yield* tick;
  const next = yield* publish("hr-2026.2", [Site, Worker, PlacementV2]);
  yield* tick;
  // The same command under today's rules is rejected atomically.
  const rejected = yield* placeWorker(
    next.snapshot,
    EntityId.make("placement:maria-pier"),
    maria,
    pier,
  ).pipe(Effect.flip);
  yield* tick;
  yield* correctTraining;

  const config = yield* ConfigStore.ConfigStore;
  const journal = yield* triples.transactions({ after: 0, limit: 1_000 });
  const rows = [
    "| Position | Actor | Command | Changes (+ assert, − retract; valid time) |",
    "| --- | --- | --- | --- |",
  ];
  for (const transaction of journal.transactions) {
    const pinned = transaction.configSnapshot;
    const changed =
      transaction.actor === "triplex/config-store" &&
      pinned !== undefined &&
      ContentId.isContentId(pinned)
        ? `Release \`${(yield* config.snapshotById(pinned))?.label}\`; \`live\` moved to it`
        : transaction.changes.map(describe).join("<br>");
    rows.push(
      `| ${transaction.position} | \`${transaction.actor}\` | ${transaction.commandId === undefined ? "—" : `\`${transaction.commandId}\``} | ${changed} |`,
    );
  }
  const snapshot = release.snapshot.id;
  return {
    timeline: `${rows.join("\n")}\n`,
    audit: yield* audit,
    rejected: {
      error: rejected._tag,
      ...(rejected._tag === "ConstraintViolationError"
        ? { violations: [...new Set(rejected.violations.map((violation) => violation.message))] }
        : {}),
    },
    "open-work": {
      [day(Date.UTC(2026, 2, 3))]: yield* openWork(snapshot, Date.UTC(2026, 2, 3)),
      [day(Date.UTC(2026, 3, 1))]: yield* openWork(snapshot, Date.UTC(2026, 3, 1)),
      [day(JUN_1)]: yield* openWork(snapshot, JUN_1),
    },
    http: yield* readOverHttp(placed.instant),
  };
});

const outputs = await Effect.runPromise(scenario.pipe(Effect.provide(InMemory)));

// How long each layer of the stack is, counted from the regions the homepage shows.
const source = await readFile(resolve(import.meta.dirname, "app.ts"), "utf8");
const stack: Record<string, number> = {};
for (const [, name, body] of source.matchAll(/#region (\w+)\n([\s\S]*?)\/\/ #endregion/g)) {
  stack[name!] = body!.split("\n").filter((line) => line.trim() !== "").length;
}
stack["total"] = Object.values(stack).reduce((sum, lines) => sum + lines, 0);

const check = process.argv.includes("--check");
const files: Record<string, string> = {
  "stack.json": JSON.stringify(stack),
  "timeline.md": outputs.timeline,
  "audit.json": JSON.stringify(outputs.audit),
  "rejected.json": JSON.stringify(outputs.rejected),
  "open-work.json": JSON.stringify(outputs["open-work"]),
  "http.json": JSON.stringify(outputs.http),
};

// Format exactly as the repository formatter would, so `pnpm format` never fights `--check`.
const staging = await mkdtemp(join(tmpdir(), "triplex-home-"));
for (const [name, body] of Object.entries(files)) await writeFile(join(staging, name), body);
execFileSync(resolve(import.meta.dirname, "../../../../node_modules/.bin/oxfmt"), [staging], {
  stdio: "ignore",
});

const outputDirectory = resolve(import.meta.dirname, "output");
const drift: string[] = [];
for (const name of Object.keys(files)) {
  const expected = await readFile(join(staging, name), "utf8");
  const path = join(outputDirectory, name);
  if (!check) await writeFile(path, expected);
  else if ((await readFile(path, "utf8").catch(() => "")) !== expected) drift.push(path);
}
await rm(staging, { recursive: true, force: true });

if (drift.length > 0) {
  console.error("Homepage outputs are stale. Run `pnpm docs:outputs` and commit:");
  for (const path of drift) console.error(`  ${path}`);
  process.exit(1);
}
console.log(check ? "Homepage outputs match the scenario." : "Wrote homepage outputs.");
