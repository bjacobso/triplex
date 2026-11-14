/**
 * Where a SQLite write spends its time, per transaction and per asserted triple.
 *
 * 1. Live: commits WRITE_COST_TRANSACTIONS transactions (default 1000, after 50
 *    warm-up ones), each asserting one entity with WRITE_COST_ATTRIBUTES string
 *    attributes (default 10) of 32 characters, with an actor and a command ID,
 *    through `SqliteTriples.layer` on a file (WAL, synchronous NORMAL). Every
 *    `node:sqlite` statement is timed, grouped by kind.
 * 2. Replay: inserts the exact rows that run wrote (facts, and the journal's
 *    transaction and changed-entity rows) into fresh tables with plain
 *    `node:sqlite`, one transaction per Triplex transaction, with and without the
 *    secondary indexes and with and without the journal rows. The differences
 *    are the cost of index maintenance and of the journal at the SQLite level.
 * 3. Profile: a CPU profile of a second live run, self time grouped by where
 *    the code lives (SQLite native calls, Effect, Triplex store, SQL layer...).
 *
 *   pnpm --filter triplex-stress write-cost
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Session } from "node:inspector/promises";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import { EntityId, Triples } from "@triplex-build/triplex";
import { SqliteTriples } from "@triplex-build/triplex/sqlite";

const TRANSACTIONS = Number(process.env["WRITE_COST_TRANSACTIONS"] ?? 1000);
const ATTRIBUTES = Number(process.env["WRITE_COST_ATTRIBUTES"] ?? 10);
const WARMUP = 50;
const ROUNDS = Number(process.env["WRITE_COST_ROUNDS"] ?? 5);
const ASSERTED = TRANSACTIONS * ATTRIBUTES;

// ── Statement timing ─────────────────────────────────────────────────────────

interface Bucket {
  count: number;
  ms: number;
}
const buckets = new Map<string, Bucket>();
let timing = false;

const kindOf = (sql: string): string => {
  const flat = sql.replace(/\s+/g, " ").trim();
  const insert = /^INSERT (?:OR \w+ )?INTO (\w+)/i.exec(flat);
  if (insert) return `INSERT ${insert[1]}`;
  const update = /^UPDATE (\w+)/i.exec(flat);
  if (update) return `UPDATE ${update[1]}`;
  const select = /^SELECT .*? FROM (\w+)/i.exec(flat);
  if (select) return `SELECT ${select[1]}: ${flat.slice(0, 70)}`;
  return flat.slice(0, 40);
};

const wrap = (name: "run" | "all" | "get" | "iterate") => {
  const original = StatementSync.prototype[name] as (...args: unknown[]) => unknown;
  (StatementSync.prototype as unknown as Record<string, unknown>)[name] = function (
    this: StatementSync,
    ...args: unknown[]
  ) {
    if (!timing) return original.apply(this, args);
    const start = performance.now();
    try {
      return original.apply(this, args);
    } finally {
      const key = kindOf(this.sourceSQL);
      const bucket = buckets.get(key) ?? { count: 0, ms: 0 };
      bucket.count += 1;
      bucket.ms += performance.now() - start;
      buckets.set(key, bucket);
    }
  };
};
for (const name of ["run", "all", "get", "iterate"] as const) wrap(name);
const originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
  if (!timing) return originalExec.call(this, sql);
  const start = performance.now();
  try {
    return originalExec.call(this, sql);
  } finally {
    const key = kindOf(sql);
    const bucket = buckets.get(key) ?? { count: 0, ms: 0 };
    bucket.count += 1;
    bucket.ms += performance.now() - start;
    buckets.set(key, bucket);
  }
};

// ── Live run ─────────────────────────────────────────────────────────────────

const value = () => randomBytes(16).toString("hex");

const live = (filename: string, transactions: number, offset: number) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    const times: number[] = [];
    for (let tx = 0; tx < transactions; tx++) {
      const index = offset + tx;
      const start = performance.now();
      yield* triples.transact(
        Array.from({ length: ATTRIBUTES }, (_, a) => ({
          op: "assert" as const,
          entityId: EntityId.make(`item:${index}`),
          attribute: `:item/field-${a}`,
          value: { type: "string" as const, value: value() },
          entityType: "Item",
        })),
        { actor: "write-cost", commandId: `write-cost-${index}` },
      );
      times.push(performance.now() - start);
    }
    return times;
  }).pipe(Effect.provide(Layer.fresh(SqliteTriples.layer({ filename }))));

const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!;

// ── Replay ───────────────────────────────────────────────────────────────────

/** The tables one commit writes: the facts and the journal (row and changed entities). */
const JOURNAL_TABLES = ["triplex_transactions", "triplex_transaction_entities"] as const;
const POSITION: Record<string, string> = {
  triples: "recorded_position",
  triplex_transactions: "position",
  triplex_transaction_entities: "position",
};

const replay = (source: string, directory: string) => {
  const db = new DatabaseSync(source, { readOnly: true });
  const tables = ["triples", ...JOURNAL_TABLES];
  const schema = db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE tbl_name IN (${tables.map(() => "?").join(", ")}) AND sql IS NOT NULL`,
    )
    .all(...tables) as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  // Rows of each table, grouped by the commit position that wrote them.
  const groups = new Map<number, Array<{ table: string; row: Record<string, unknown> }>>();
  for (const table of tables) {
    const rows = db
      .prepare(`SELECT * FROM ${table} ORDER BY ${POSITION[table]}, rowid`)
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const position = Number(row[POSITION[table]!]);
      const group = groups.get(position) ?? [];
      group.push({ table, row });
      groups.set(position, group);
    }
  }
  db.close();
  const transactions = [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, group]) => group)
    .slice(-TRANSACTIONS);
  const isJournal = (table: string) => table !== "triples";

  const variant = (name: string, withIndexes: boolean, withJournal: boolean) => {
    const file = join(directory, `${name}.db`);
    const target = new DatabaseSync(file);
    target.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
    // Tables keep their primary keys and unique constraints (the journal's
    // command and position uniqueness are part of a commit's cost).
    for (const object of schema.filter((o) => o.type === "table")) target.exec(object.sql);
    if (withIndexes)
      for (const object of schema.filter((o) => o.type === "index")) target.exec(object.sql);
    const inserts = new Map<string, StatementSync>();
    const insert = (table: string, row: Record<string, unknown>) => {
      const columns = Object.keys(row);
      const key = `${table}:${columns.join(",")}`;
      let statement = inserts.get(key);
      if (statement === undefined) {
        statement = target.prepare(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        );
        inserts.set(key, statement);
      }
      statement.run(...(columns.map((column) => row[column]) as never[]));
    };
    const start = performance.now();
    for (const group of transactions) {
      target.exec("BEGIN");
      for (const { table, row } of group) {
        if (!withJournal && isJournal(table)) continue;
        insert(table, row);
      }
      target.exec("COMMIT");
    }
    const ms = performance.now() - start;
    target.close();
    return ms;
  };
  const count = (journal: boolean) =>
    transactions.reduce(
      (sum, g) => sum + g.filter((r) => isJournal(r.table) === journal).length,
      0,
    );
  // Each variant runs ROUNDS times, interleaved, and reports its median, so a
  // busy machine skews every variant alike.
  const plans = {
    tableOnlyFacts: () => variant("a", false, false),
    tableOnlyAll: () => variant("b", false, true),
    indexedFacts: () => variant("c", true, false),
    indexedAll: () => variant("d", true, true),
  };
  const samples = Object.fromEntries(
    Object.keys(plans).map((key) => [key, [] as number[]]),
  ) as Record<keyof typeof plans, number[]>;
  for (let round = 0; round < ROUNDS; round++) {
    for (const [index, [key, plan]] of (
      Object.entries(plans) as Array<[keyof typeof plans, () => number]>
    ).entries()) {
      samples[key].push(plan());
      for (const suffix of ["", "-wal", "-shm"])
        rmSync(join(directory, `${"abcd"[index]}.db${suffix}`), { force: true });
    }
  }
  const median = (values: number[]) =>
    [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)]!;
  return {
    facts: count(false),
    journal: count(true),
    indexes: schema.filter((o) => o.type === "index" && o.tbl_name === "triples").length,
    journalIndexes: schema.filter((o) => o.type === "index" && o.tbl_name !== "triples").length,
    ...(Object.fromEntries(
      Object.entries(samples).map(([key, values]) => [key, median(values)]),
    ) as Record<keyof typeof plans, number>),
  };
};

// ── Profile ──────────────────────────────────────────────────────────────────

interface ProfileNode {
  readonly id: number;
  readonly callFrame: { readonly functionName: string; readonly url: string };
  readonly hitCount?: number;
}

const area = (node: ProfileNode): string => {
  const { url, functionName } = node.callFrame;
  if (functionName === "(garbage collector)") return "garbage collection";
  if (functionName === "(idle)" || functionName === "(program)") return "runtime (program, idle)";
  if (url === "" && ["run", "all", "get", "iterate", "exec", "prepare"].includes(functionName))
    return "SQLite (native statements)";
  if (url.includes("/packages/core/") && url.includes("/store/"))
    return "Triplex core: store and journal";
  if (url.includes("/packages/core/")) return "Triplex core: other";
  if (url.includes("/packages/sql/") || url.includes("/packages/sqlite/"))
    return "Triplex SQL and SQLite adapter";
  if (url.includes("/packages/triplex/dist/")) return "Triplex (bundled)";
  if (url.includes("@effect/sql")) return "Effect SQL";
  if (url.includes("effect")) return "Effect runtime";
  if (url === "" || url.startsWith("node:")) return "Node.js";
  return "other";
};

const profile = async (filename: string) => {
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: 100 });
  await session.post("Profiler.start");
  await Effect.runPromise(live(filename, Math.min(TRANSACTIONS, 500), 1_000_000));
  const { profile: result } = (await session.post("Profiler.stop")) as unknown as {
    profile: { nodes: ProfileNode[] };
  };
  session.disconnect();
  const totals = new Map<string, number>();
  let all = 0;
  for (const node of result.nodes) {
    const hits = node.hitCount ?? 0;
    all += hits;
    totals.set(area(node), (totals.get(area(node)) ?? 0) + hits);
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, hits]) => ({ name, share: hits / all }));
};

// ── Report ───────────────────────────────────────────────────────────────────

const us = (ms: number, per: number) => `${((ms * 1000) / per).toFixed(0)}`;

const main = async () => {
  const directory = mkdtempSync(join(tmpdir(), "triplex-write-cost-"));
  try {
    const filename = join(directory, "write-cost.db");
    await Effect.runPromise(live(filename, WARMUP, 0));
    timing = true;
    const wallStart = performance.now();
    const times = await Effect.runPromise(live(filename, TRANSACTIONS, WARMUP));
    const wall = performance.now() - wallStart;
    timing = false;
    const sqlMs = [...buckets.values()].reduce((sum, b) => sum + b.ms, 0);
    const statements = [...buckets.values()].reduce((sum, b) => sum + b.count, 0);

    console.log(`## SQLite write cost\n`);
    console.log(
      `${TRANSACTIONS} transactions × ${ATTRIBUTES} string attributes = ${ASSERTED} asserted triples, file in WAL mode, synchronous NORMAL, Node ${process.version}.\n`,
    );
    console.log("| Measure | Per transaction | Per asserted triple |");
    console.log("| --- | ---: | ---: |");
    console.log(`| Wall time, mean (µs) | ${us(wall, TRANSACTIONS)} | ${us(wall, ASSERTED)} |`);
    console.log(
      `| Wall time, p50 / p95 (µs) | ${(percentile(times, 0.5) * 1000).toFixed(0)} / ${(percentile(times, 0.95) * 1000).toFixed(0)} | |`,
    );
    console.log(
      `| Inside SQLite statements (µs) | ${us(sqlMs, TRANSACTIONS)} | ${us(sqlMs, ASSERTED)} |`,
    );
    console.log(
      `| Outside SQLite: JavaScript (µs) | ${us(wall - sqlMs, TRANSACTIONS)} | ${us(wall - sqlMs, ASSERTED)} |`,
    );
    console.log(
      `| SQL statements executed | ${(statements / TRANSACTIONS).toFixed(1)} | ${(statements / ASSERTED).toFixed(2)} |`,
    );
    console.log("\n### Statements by kind (per transaction)\n");
    console.log("| Statement | Count | µs |");
    console.log("| --- | ---: | ---: |");
    for (const [kind, bucket] of [...buckets.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
      console.log(
        `| \`${kind.replaceAll("|", "\\|")}\` | ${(bucket.count / TRANSACTIONS).toFixed(1)} | ${us(bucket.ms, TRANSACTIONS)} |`,
      );
    }

    const r = replay(filename, directory);
    console.log(
      `\n### Replay of the same rows with plain node:sqlite (µs per transaction, median of ${ROUNDS} interleaved runs)\n`,
    );
    console.log(
      `${(r.facts / TRANSACTIONS).toFixed(1)} fact rows and ${(r.journal / TRANSACTIONS).toFixed(1)} journal rows (one transaction row, one row per changed entity) per transaction; ${r.indexes} indexes on \`triples\`, ${r.journalIndexes} declared indexes on the journal tables besides their keys.\n`,
    );
    console.log("| Rows inserted | Tables and keys only | With every index |");
    console.log("| --- | ---: | ---: |");
    console.log(
      `| Facts only | ${us(r.tableOnlyFacts, TRANSACTIONS)} | ${us(r.indexedFacts, TRANSACTIONS)} |`,
    );
    console.log(
      `| Facts and journal | ${us(r.tableOnlyAll, TRANSACTIONS)} | ${us(r.indexedAll, TRANSACTIONS)} |`,
    );
    console.log(
      `\nIndex maintenance: ${us(r.indexedAll - r.tableOnlyAll, TRANSACTIONS)} µs per transaction. Journal rows: ${us(r.indexedAll - r.indexedFacts, TRANSACTIONS)} µs per transaction (with indexes).`,
    );

    const shares = await profile(join(directory, "profile.db"));
    console.log("\n### CPU profile of a live run (self time)\n");
    console.log("| Where | Share |");
    console.log("| --- | ---: |");
    for (const { name, share } of shares) console.log(`| ${name} | ${(share * 100).toFixed(1)}% |`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
