import { execFileSync } from "node:child_process";
import { platform, arch } from "node:os";
import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { EntityId, Triples } from "@triplex-build/triplex";
import { Outbox } from "@triplex-build/triplex/operational";
import type { ContentId } from "@triplex-build/triplex/content";
import { makeSqlOperationalEntryStorage, SqliteDialect } from "@triplex-build/triplex/sql";
import { expect } from "vitest";

/** Synthetic acknowledged history; actual public append/read/ack around each size. */
export const operationalEntryIndexPlan = (backend: "sqlite" | "postgres") =>
  Effect.gen(function* () {
    const evidence = [];
    const sql = yield* SqlClient.SqlClient;
    const databaseVersion = yield* sql.unsafe(
      backend === "postgres" ? "SELECT version() AS version" : "SELECT sqlite_version() AS version",
    );
    const t = yield* Triples;
    const scope = EntityId.make("entry:plan");
    const templateKey = "template";
    yield* t.transact([
      Outbox.append({ scope, idempotencyKey: templateKey, payload: { intent: "stored" } }),
    ]);
    const entry = (yield* Outbox.get(t, Outbox.id(scope, templateKey)))!;
    const tokens = yield* sql<{
      scope_token: ContentId;
    }>`SELECT scope_token FROM triplex_operational_entries WHERE id = ${entry.id}`;
    const template = {
      ...entry,
      payload: JSON.stringify(entry.payload),
      scopeToken: tokens[0]!.scope_token,
    };
    yield* t.transact([Outbox.acknowledge(template.id)]);
    for (const count of [10, 10000]) {
      yield* sql`DELETE FROM triplex_operational_entries`;
      // Keep identities and canonical bodies valid, while avoiding 10,000 unrelated
      // transaction receipts in an index test. All rows are already acknowledged.
      for (let offset = 0; offset < count; offset += 100) {
        const rows = Array.from({ length: Math.min(100, count - offset) }, (_, i) => {
          const key = `history:${offset + i}`;
          return {
            id: Outbox.id(scope, key),
            kind: "outbox",
            scope: JSON.stringify(scope),
            scope_token: template.scopeToken,
            idempotency_key: JSON.stringify(key),
            payload: template.payload,
            recorded_position: template.recordedPosition,
            recorded_at: template.recordedAt,
            tx_id: template.txId,
            acknowledged_position: template.recordedPosition,
            acknowledged_at: template.recordedAt,
            acknowledged_tx_id: template.txId,
          };
        });
        yield* sql`INSERT INTO triplex_operational_entries ${sql.insert(rows)}`;
      }
      // Unrelated pending work exercises a selective entity range as well.
      yield* t.transact(
        Array.from({ length: 128 }, (_, i) =>
          Outbox.append({
            scope: EntityId.make(`entry:other:${i}`),
            idempotencyKey: "pending",
            payload: i,
          }),
        ),
      );
      const key = `pending:${count}`;
      const started = performance.now();
      yield* t.transact([
        Outbox.append({ scope, idempotencyKey: key, payload: { intent: "stored" } }),
      ]);
      const appendMs = performance.now() - started;
      const readStarted = performance.now();
      const pending = yield* Outbox.pending(t, { scope, limit: 1 });
      expect(pending.entries.map((entry) => entry.id)).toEqual([Outbox.id(scope, key)]);
      expect((yield* Outbox.pending(t, { limit: 1 })).entries).toHaveLength(1);
      const readMs = performance.now() - readStarted;
      yield* sql.unsafe("ANALYZE triplex_operational_entries");
      const statements: { statement: string; params: readonly unknown[] }[] = [];
      // Capture the shared production query builder; only placeholder spelling
      // differs between dialects. Both SQLite and PostgreSQL accept numbered $n.
      const builder = makeSqlOperationalEntryStorage(
        {
          run: (statement, params) => {
            statements.push({ statement, params });
            return Effect.succeed([]);
          },
        },
        SqliteDialect,
      );
      yield* builder.getOperationalEntry(Outbox.id(scope, key));
      yield* builder.pendingOperationalEntries({ kind: "outbox", limit: 2 });
      yield* builder.pendingOperationalEntries({
        kind: "outbox",
        scopeToken: template.scopeToken,
        limit: 2,
        after: { recordedPosition: pending.entries[0]!.recordedPosition - 1, id: template.id },
      });
      yield* builder.acknowledgeOperationalEntry(Outbox.id(scope, key), 999999, 1, template.txId);
      const plans = [];
      for (const [index, query] of statements.entries()) {
        const statement =
          backend === "postgres"
            ? query.statement.replace(/\?(\d+)/g, (_, n: string) => `$${n}`)
            : query.statement;
        const plan = yield* sql.unsafe(
          `${backend === "postgres" ? (index === 3 ? "EXPLAIN (FORMAT JSON)" : "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)") : "EXPLAIN QUERY PLAN"} ${statement}`,
          query.params,
        );
        const encoded = JSON.stringify(plan);
        if (backend === "sqlite" || count === 10000) {
          if (index === 3) expect(encoded).toMatch(/(?:Index Scan|USING INDEX)/);
          else
            expect(encoded).toContain(
              index === 0
                ? backend === "postgres"
                  ? "triplex_operational_entries_pkey"
                  : "sqlite_autoindex_triplex_operational_entries"
                : index === 1
                  ? "idx_operational_pending_global"
                  : "idx_operational_pending_scope",
            );
        }
        plans.push({ statement, plan });
      }
      const ackStarted = performance.now();
      yield* t.transact([Outbox.acknowledge(Outbox.id(scope, key))]);
      const ackMs = performance.now() - ackStarted;
      expect((yield* Outbox.pending(t, { scope, limit: 1 })).entries).toHaveLength(0);
      expect((yield* Outbox.get(t, Outbox.id(scope, key)))!.payload).toEqual({ intent: "stored" });
      evidence.push({ backend, acknowledgedHistory: count, appendMs, readMs, ackMs, plans });
      if (process.env["TRIPLEX_EXPLAIN"]) console.info(JSON.stringify(evidence.at(-1)));
    }
    const evidencePath = process.env["TRIPLEX_OPERATIONAL_PLANS"];
    if (evidencePath)
      writeFileSync(
        evidencePath,
        JSON.stringify(
          {
            sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
            dirty:
              execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length >
              0,
            platform: platform(),
            arch: arch(),
            databaseVersion,
            node: process.version,
            measuredAt: new Date().toISOString(),
            evidence,
          },
          null,
          2,
        ) + "\n",
      );
  });
