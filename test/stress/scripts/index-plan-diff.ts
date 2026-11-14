/**
 * Which SQLite query plans change if some `triples` indexes are dropped.
 *
 * Captures every distinct SQL statement Triplex issues while the shared
 * conformance suites run (core Triples, sensitive decorator, sealed storage),
 * then runs `EXPLAIN QUERY PLAN` for each one on a populated file, before and
 * after dropping the indexes named in DROP_INDEXES (default: the three prefix
 * indexes), and prints every statement whose plan changes.
 *
 *   pnpm --filter triplex-stress index-plan-diff
 *
 * To compare two builds instead (for example before and after a storage
 * change), dump every plan with `PLAN_DUMP=plans.json` on the first build and
 * compare against it with `PLAN_BASELINE=plans.json` on the second. The report
 * lists every statement present in both whose plan changed, and counts the
 * statements only one build issues.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import { EntityId, Triples } from "@triplex-build/triplex";
import { SqliteTriples } from "@triplex-build/triplex/sqlite";
import {
  makeSealedStorageSuite,
  makeSensitiveConformanceSuite,
  makeTriplesConformanceSuite,
  sensitiveConformanceLayer,
} from "@triplex-build/triplex/testkit";

const DROP = (
  process.env["DROP_INDEXES"] ?? "idx_entity,idx_attribute,idx_recorded_position"
).split(",");

// Capture statement texts.
const statements = new Set<string>();
for (const name of ["run", "all", "get", "iterate"] as const) {
  const original = StatementSync.prototype[name] as (...args: unknown[]) => unknown;
  (StatementSync.prototype as unknown as Record<string, unknown>)[name] = function (
    this: StatementSync,
    ...args: unknown[]
  ) {
    statements.add(this.sourceSQL);
    return original.apply(this, args);
  };
}

/** With PLAN_HISTORY, items spread over 25 entity types as an application's would. */
const itemType = (tx: number) =>
  process.env["PLAN_HISTORY"] === undefined ? "Item" : `Item${tx % 25}`;

const populate = Effect.gen(function* () {
  const triples = yield* Triples;
  for (let tx = 0; tx < 500; tx++) {
    yield* triples.transact(
      [
        ...Array.from({ length: 6 }, (_, a) => ({
          op: "assert" as const,
          entityId: EntityId.make(`item:${tx}`),
          attribute: `:item/field-${a}`,
          value: { type: "string" as const, value: `value-${tx}-${a}` },
          entityType: itemType(tx),
        })),
        {
          op: "assert" as const,
          entityId: EntityId.make(`item:${tx}`),
          attribute: ":item/rank",
          value: { type: "number" as const, value: tx },
          entityType: itemType(tx),
        },
        {
          op: "assert" as const,
          entityId: EntityId.make(`item:${tx}`),
          attribute: ":item/parent",
          value: { type: "ref" as const, value: `item:${Math.floor(tx / 2)}` },
          entityType: itemType(tx),
        },
      ],
      { actor: "plan-diff", commandId: `plan-diff-${tx}` },
    );
  }
  // History: entities with retracted facts, and a second entity type, so the
  // statistics resemble a database in use rather than an append-only load.
  if (process.env["PLAN_HISTORY"] !== undefined) {
    for (let tx = 0; tx < 500; tx++) {
      const [current] = yield* triples.match({
        entityId: EntityId.make(`item:${tx}`),
        attribute: ":item/field-0",
      });
      for (let round = 0; round < 3; round++) {
        const live =
          round === 0
            ? current!
            : (yield* triples.match({
                entityId: EntityId.make(`item:${tx}`),
                attribute: ":item/field-0",
              }))[0]!;
        yield* triples.transact([
          { op: "retract", id: live.id },
          {
            op: "assert",
            entityId: EntityId.make(`item:${tx}`),
            attribute: ":item/field-0",
            value: { type: "string", value: `value-${tx}-0-${round}` },
            entityType: itemType(tx),
          },
        ]);
      }
      yield* triples.assert({
        entityId: EntityId.make(`other:${tx}`),
        attribute: ":other/name",
        value: { type: "string", value: `other-${tx}` },
        entityType: "Other",
      });
    }
  }
});

const main = async () => {
  const directory = mkdtempSync(join(tmpdir(), "triplex-plan-diff-"));
  try {
    const filename = join(directory, "plans.db");
    // Exercise the read and write paths; every statement is captured.
    await Effect.runPromise(populate.pipe(Effect.provide(SqliteTriples.layer({ filename }))));
    await Effect.runPromise(
      makeTriplesConformanceSuite().pipe(Effect.provide(Layer.fresh(SqliteTriples.layerMemory))),
    );
    await Effect.runPromise(
      makeSensitiveConformanceSuite().pipe(
        Effect.provide(sensitiveConformanceLayer(Layer.fresh(SqliteTriples.layerMemory))),
      ),
    );
    await Effect.runPromise(
      makeSealedStorageSuite().pipe(Effect.provide(Layer.fresh(SqliteTriples.layerMemory))),
    );

    const candidates = [...statements].filter((sql) =>
      /^\s*(SELECT|WITH|UPDATE|DELETE|INSERT)/i.test(sql),
    );
    const db = new DatabaseSync(filename);
    db.exec("ANALYZE");
    const plan = (sql: string): string | undefined => {
      try {
        const explain = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
        const count = explain.sourceSQL.split("?").length - 1;
        return (
          explain.all(...(Array.from({ length: count }, () => null) as never[])) as Array<{
            detail: string;
          }>
        )
          .map((row) => row.detail)
          .join(" | ");
      } catch {
        return undefined;
      }
    };
    const current = new Map(candidates.map((sql) => [sql, plan(sql)]));
    const dump = process.env["PLAN_DUMP"];
    const baselineFile = process.env["PLAN_BASELINE"];
    if (dump !== undefined || baselineFile !== undefined) {
      db.close();
      const plans = Object.fromEntries(
        [...current].filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      if (dump !== undefined) {
        writeFileSync(dump, JSON.stringify(plans, null, 2));
        console.log(`Wrote ${Object.keys(plans).length} plans to ${dump}`);
      }
      if (baselineFile !== undefined) {
        const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as Record<string, string>;
        const shared = Object.keys(plans).filter((sql) => sql in baseline);
        const changed = shared.filter((sql) => baseline[sql] !== plans[sql]);
        console.log(`Statements in both builds: ${shared.length}`);
        console.log(`Only in the baseline: ${Object.keys(baseline).length - shared.length}`);
        console.log(`Only in this build: ${Object.keys(plans).length - shared.length}`);
        console.log(`Shared statements whose plan changed: ${changed.length}`);
        for (const sql of changed) {
          console.log("\n---");
          console.log(sql.replace(/\s+/g, " ").trim().slice(0, 400));
          console.log(`  baseline: ${baseline[sql]}`);
          console.log(`  now:      ${plans[sql]}`);
        }
        if (process.env["PLAN_LIST_NEW"] !== undefined) {
          for (const sql of Object.keys(plans).filter((sql) => !(sql in baseline))) {
            console.log("\n+++");
            console.log(sql.replace(/\s+/g, " ").trim().slice(0, 400));
            console.log(`  now: ${plans[sql]}`);
          }
        }
      }
      return;
    }
    const before = current;
    for (const index of DROP) db.exec(`DROP INDEX IF EXISTS ${index}`);
    db.exec("ANALYZE");
    const after = new Map(candidates.map((sql) => [sql, plan(sql)]));
    db.close();

    const explained = candidates.filter((sql) => before.get(sql) !== undefined);
    const used = explained.filter((sql) =>
      DROP.some((index) => new RegExp(`\\b${index}\\b`).test(before.get(sql)!)),
    );
    const changed = explained.filter((sql) => before.get(sql) !== after.get(sql));
    console.log(`Dropped: ${DROP.join(", ")}`);
    console.log(`Distinct statements captured: ${statements.size}; explained: ${explained.length}`);
    console.log(`Statements whose plan used a dropped index: ${used.length}`);
    console.log(`Statements whose plan changed: ${changed.length}`);
    for (const sql of changed) {
      console.log("\n---");
      console.log(sql.replace(/\s+/g, " ").trim().slice(0, 400));
      console.log(`  before: ${before.get(sql)}`);
      console.log(`  after:  ${after.get(sql)}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
