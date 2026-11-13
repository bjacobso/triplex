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
 */

import { mkdtempSync, rmSync } from "node:fs";
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
          entityType: "Item",
        })),
        {
          op: "assert" as const,
          entityId: EntityId.make(`item:${tx}`),
          attribute: ":item/rank",
          value: { type: "number" as const, value: tx },
          entityType: "Item",
        },
        {
          op: "assert" as const,
          entityId: EntityId.make(`item:${tx}`),
          attribute: ":item/parent",
          value: { type: "ref" as const, value: `item:${Math.floor(tx / 2)}` },
          entityType: "Item",
        },
      ],
      { actor: "plan-diff", commandId: `plan-diff-${tx}` },
    );
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
    const before = new Map(candidates.map((sql) => [sql, plan(sql)]));
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
