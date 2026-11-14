/**
 * Ask 0019 (A), condition 1: one commit is still one atomic write. The journal
 * row, the changed-entity rows and the facts commit together or not at all,
 * including when the process is killed in the middle of a commit, and the
 * position sequence stays consistent afterwards.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { EntityId, Triples, string } from "@triplex-internal/core";
import { SqliteTriples } from "../src/SqliteTriples.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "fixtures", "journal-crash-child.ts");
const ROOT = resolve(here, "..", "..", "..");

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const tempFile = async () => {
  const directory = await mkdtemp(join(tmpdir(), "triplex-journal-crash-"));
  directories.push(directory);
  return join(directory, "triplex.db");
};

/** Run the child; in `loop` mode kill it after `killAfter` committed positions. */
const runChild = (filename: string, mode: string, killAfter?: number, delayMs = 0) =>
  new Promise<{ signal: NodeJS.Signals | null; lines: string[] }>((done, fail) => {
    const child = spawn(process.execPath, ["--import", "tsx", CHILD, filename, mode], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (killAfter !== undefined && output.split("\n").length > killAfter && !child.killed)
        setTimeout(() => child.kill("SIGKILL"), delayMs);
    });
    child.on("error", fail);
    child.on("exit", (_code, signal) =>
      done({ signal, lines: output.split("\n").filter((line) => line.length > 0) }),
    );
  });

/** Every invariant tying facts, journal rows, entity rows and the position counter. */
const inspect = (filename: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const triples = yield* Triples;
      const [head] = yield* sql<{ position: number }>`
        SELECT position FROM triplex_commit_position WHERE singleton = 1`;
      const journal = yield* sql<{ position: number; changes: string }>`
        SELECT position, changes FROM triplex_transactions ORDER BY position`;
      const orphanFacts = yield* sql<{ id: string }>`
        SELECT id FROM triples f WHERE NOT EXISTS (
          SELECT 1 FROM triplex_transactions t WHERE t.position = f.recorded_position)`;
      const orphanEntities = yield* sql<{ entity_id: string }>`
        SELECT entity_id FROM triplex_transaction_entities e WHERE NOT EXISTS (
          SELECT 1 FROM triplex_transactions t WHERE t.position = e.position AND t.tx_id = e.tx_id)`;
      const factsByPosition = yield* sql<{ position: number; facts: number }>`
        SELECT recorded_position AS position, COUNT(*) AS facts FROM triples GROUP BY recorded_position`;
      const entitiesByPosition = yield* sql<{ position: number; entities: number }>`
        SELECT position, COUNT(*) AS entities FROM triplex_transaction_entities GROUP BY position`;
      const factEntitiesByPosition = yield* sql<{ position: number; entities: number }>`
        SELECT recorded_position AS position, COUNT(DISTINCT entity_id) AS entities
        FROM triples GROUP BY recorded_position`;
      // Hydration fails if any change references a missing fact.
      const records = [];
      let after = 0;
      for (;;) {
        const page = yield* triples.transactions({ after, limit: 1000 });
        records.push(...page.transactions);
        if (page.next === undefined) break;
        after = page.next;
      }
      return {
        head: Number(head?.position ?? 0),
        positions: journal.map((row) => Number(row.position)),
        changes: new Map(
          journal.map((row) => [Number(row.position), JSON.parse(row.changes).length as number]),
        ),
        orphanFacts: orphanFacts.length,
        orphanEntities: orphanEntities.length,
        facts: new Map(factsByPosition.map((row) => [Number(row.position), Number(row.facts)])),
        entities: new Map(
          entitiesByPosition.map((row) => [Number(row.position), Number(row.entities)]),
        ),
        factEntities: new Map(
          factEntitiesByPosition.map((row) => [Number(row.position), Number(row.entities)]),
        ),
        records,
      };
    }).pipe(Effect.provide(SqliteTriples.layerWithSqlClient({ filename })), Effect.scoped),
  );

const expectConsistent = (state: Awaited<ReturnType<typeof inspect>>) => {
  // Positions are exactly 1..head: no committed transaction without its journal row.
  expect(state.positions).toEqual(Array.from({ length: state.head }, (_, i) => i + 1));
  expect(state.records.map((record) => record.position)).toEqual(state.positions);
  expect(state.orphanFacts).toBe(0);
  expect(state.orphanEntities).toBe(0);
  for (const position of state.positions) {
    // Each committed transaction has all its facts and all its entity rows.
    expect(state.facts.get(position)).toBe(state.changes.get(position));
    expect(state.entities.get(position)).toBe(state.factEntities.get(position));
  }
};

const commitAfterRecovery = (filename: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const triples = yield* Triples;
      const result = yield* triples.transact(
        [
          {
            op: "assert",
            entityId: EntityId.make("crash:after"),
            attribute: ":crash/name",
            value: string("after"),
          },
        ],
        { commandId: "crash-after" },
      );
      return { result, record: yield* triples.transaction(result.txId) };
    }).pipe(Effect.provide(SqliteTriples.layer({ filename }))),
  );

describe("ask 0019 (A) condition 1: a commit is one atomic write", () => {
  for (const mode of ["before-journal", "after-journal"] as const) {
    it(
      `keeps none of a transaction killed ${mode === "before-journal" ? "after its facts and before its journal row" : "after its journal row and before COMMIT"}`,
      { timeout: 60_000 },
      async () => {
        const filename = await tempFile();
        const { signal, lines } = await runChild(filename, mode);
        expect(signal).toBe("SIGKILL");
        expect(lines).toEqual(["committed 3"]);

        const state = await inspect(filename);
        expect(state.head).toBe(3);
        expectConsistent(state);
        const killed = await Effect.runPromise(
          Effect.flatMap(Triples, (triples) =>
            triples.match({ attribute: ":crash/rank", value: { type: "number", value: 49 } }),
          ).pipe(Effect.provide(SqliteTriples.layer({ filename }))),
        );
        expect(killed).toEqual([]);

        // The next commit takes the next position; the killed command ID is free.
        const { result, record } = await commitAfterRecovery(filename);
        expect(result.position).toBe(4);
        expect(record?.commandId).toBe("crash-after");
        expectConsistent(await inspect(filename));
      },
    );
  }

  it(
    "stays consistent when killed at arbitrary points of a commit loop",
    { timeout: 120_000 },
    async () => {
      const filename = await tempFile();
      let committed = 0;
      for (const [round, delay] of [0, 1, 3, 7].entries()) {
        const { signal, lines } = await runChild(filename, "loop", 5, delay);
        expect(signal).toBe("SIGKILL");
        const state = await inspect(filename);
        expectConsistent(state);
        // Everything the child reported committed survived; at most the one in
        // flight is missing, and none is half there.
        const reported = lines.map(Number);
        expect(state.head).toBeGreaterThanOrEqual(Math.max(committed, ...reported));
        expect(state.head).toBeLessThanOrEqual(Math.max(committed, ...reported) + 1);
        committed = state.head;
        expect(round).toBeLessThan(4);
      }
      const { result } = await commitAfterRecovery(filename);
      expect(result.position).toBe(committed + 1);
    },
  );
});
