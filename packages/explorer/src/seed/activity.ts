/**
 * Commits small, realistic changes to a seeded database so the explorer's live
 * view has something to follow: pay changes from today, incident status moves,
 * and new incident reports. Each commit pins the live release, without
 * enforcement for the reason given in seed.ts.
 *
 *   pnpm --filter @triplex-build/triplex-explorer activity -- --sqlite ./explorer.db [--once] [--every 20]
 */
import { resolve } from "node:path";

import { NodeRuntime } from "@effect/platform-node";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";
import { Change, EntityId, Triples, type TransactOp } from "@triplex-internal/core";
import { ConfigStore } from "@triplex-internal/core/config";
import { Effect, Layer } from "effect";

import { Incident } from "./model.js";
import { summaries } from "./names.js";

const args = process.argv.slice(2);
const target = args[args.indexOf("--sqlite") + 1];
if (!args.includes("--sqlite") || target === undefined) {
  throw new Error("Usage: activity --sqlite <database.db> [--once] [--every <seconds>]");
}
const filename = resolve(target);
const every = Number(args.includes("--every") ? args[args.indexOf("--every") + 1] : 20);
const pick = <A>(values: readonly A[]): A => values[Math.floor(Math.random() * values.length)]!;
const pad = (n: number) => String(n).padStart(4, "0");

const step = Effect.gen(function* () {
  const triples = yield* Triples;
  const release = yield* (yield* ConfigStore.ConfigStore).resolveRef("live");
  if (release === undefined) return yield* Effect.fail(new Error("Seed the database first"));
  const now = Date.now();
  const commit = (
    actor: string,
    ops: readonly TransactOp[],
    change?: Change.Change,
    extra: Record<string, string> = {},
  ) =>
    triples.transact([...ops, ...(change?.ops ?? [])], {
      actor,
      commandId: `activity:${now}:${Math.random().toString(36).slice(2, 8)}`,
      configSnapshot: release.id,
      ...(change && change.preconditions.length > 0 ? { preconditions: change.preconditions } : {}),
      ...extra,
    });
  const kind = pick(["rate", "rate", "incident", "report"] as const);
  if (kind === "rate") {
    const id = EntityId.make(`worker:${pad(1 + Math.floor(Math.random() * 1200))}`);
    const rate = (yield* triples.entity(id)).find(
      (fact) => fact.attribute === ":worker/hourly-rate",
    );
    if (rate === undefined || rate.value.type !== "number" || rate.validFrom >= now) return;
    const value = Math.round((rate.value.value + pick([-1, 0.5, 1, 1.5, 2])) * 4) / 4;
    const result = yield* commit(
      "sync:payroll",
      [],
      Change.replace(rate, { type: "number", value }, now),
      {
        correlationId: "payroll:live",
      },
    );
    return yield* Effect.log(`#${result.position} ${id} rate ${rate.value.value} -> ${value}`);
  }
  if (kind === "incident") {
    const id = EntityId.make(`incident:${pad(1 + Math.floor(Math.random() * 160))}`);
    const status = (yield* triples.entity(id)).find(
      (fact) => fact.attribute === ":incident/status",
    );
    if (
      status === undefined ||
      status.value.type !== "string" ||
      status.value.value === "closed" ||
      status.validFrom >= now
    )
      return;
    const next = status.value.value === "open" ? "investigating" : "closed";
    const result = yield* commit("user:sam", [], Incident.replace(status, { status: next }, now));
    return yield* Effect.log(`#${result.position} ${id} ${status.value.value} -> ${next}`);
  }
  const count =
    (yield* triples.queryPage({
      inner: { find: ["?i"], where: [["?i", ":incident/summary", "?s"]] },
      limit: 1,
      includeCount: true,
    })).totalCount ?? 0;
  const id = EntityId.make(`incident:${pad(count + 1)}`);
  const sites = yield* triples.queryPage({
    inner: { find: ["?s"], where: [["?s", ":site/name", "?n"]] },
    limit: 30,
  });
  const result = yield* commit(
    "app:field",
    Incident.assert(
      id,
      {
        site: EntityId.make(String(pick(sites.results)["?s"])),
        summary: pick(summaries),
        severity: pick(["low", "medium", "high"] as const),
        status: "open",
        reportedBy: EntityId.make(`worker:${pad(1 + Math.floor(Math.random() * 1200))}`),
      },
      { validFrom: now },
    ),
  );
  return yield* Effect.log(`#${result.position} reported ${id}`);
});

const program = args.includes("--once")
  ? step
  : Effect.forever(step.pipe(Effect.andThen(Effect.sleep(`${every} seconds`))));

program.pipe(
  Effect.provide(ConfigStore.layer.pipe(Layer.provideMerge(SqliteTriples.layer({ filename })))),
  NodeRuntime.runMain,
);
