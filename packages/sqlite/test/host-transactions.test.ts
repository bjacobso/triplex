import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import {
  CommitRejectedError,
  CommitValidation,
  EntityId,
  Triples,
  string,
} from "@triplex-build/triplex";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";

const record = EntityId.make("host:record:1");

/** Only an actor named in the command may move a record to `approved`. */
const approvals = CommitValidation.make("host.approvals", (commit) =>
  Effect.succeed(
    commit.changes.flatMap((change) =>
      change.op === "assert" &&
      change.attribute === ":record/status" &&
      change.value?.type === "string" &&
      change.value.value === "approved" &&
      commit.transaction.actor !== "user:approver"
        ? [
            {
              code: "not_approver",
              message: `${commit.transaction.actor ?? "anonymous"} may not approve records`,
              entityId: change.entityId,
              attribute: change.attribute,
            },
          ]
        : [],
    ),
  ),
);

const database = (recordRejections: boolean) =>
  CommitValidation.layer({ validators: [approvals], recordRejections }).pipe(
    Layer.provideMerge(SqliteTriples.layerMemoryWithScope(`host-tx-${recordRejections}`)),
  );

const status = (value: string) =>
  [
    {
      op: "assert",
      entityId: record,
      attribute: ":record/status",
      value: string(value),
    },
  ] as const;

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE host_outbox (id TEXT PRIMARY KEY, body TEXT NOT NULL)`;
});

const outboxCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM host_outbox`;
  return Number(rows[0]?.count ?? 0);
});

const run = <A, E>(
  effect: Effect.Effect<A, E, Triples | SqlClient.SqlClient>,
  recordRejections = false,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* setup;
      return yield* effect;
    }).pipe(Effect.provide(database(recordRejections)), Effect.scoped) as Effect.Effect<A, E>,
  );

describe("SQLite host-owned transactions with commit validators", () => {
  it("exposes the validated Triples service alongside the host SqlClient", async () => {
    const error = await run(
      Effect.gen(function* () {
        const triples = yield* Triples;
        return yield* triples
          .transact(status("approved"), { actor: "user:intruder" })
          .pipe(Effect.flip);
      }),
    );
    expect(error).toBeInstanceOf(CommitRejectedError);
  });

  it("commits host outbox rows and Triplex facts together", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const triples = yield* Triples;
        const committed = yield* sql.withTransaction(
          Effect.gen(function* () {
            const transaction = yield* triples.transact(status("approved"), {
              actor: "user:approver",
              commandId: "approve:1",
            });
            yield* sql`INSERT INTO host_outbox (id, body) VALUES (${transaction.txId}, 'notify')`;
            return transaction;
          }),
        );
        return {
          committed,
          outbox: yield* outboxCount,
          facts: yield* triples.entity(record),
        };
      }),
    );
    expect(result.outbox).toBe(1);
    expect(result.facts.map((fact) => fact.value.value)).toEqual(["approved"]);
  });

  it("rolls back host rows with a rejected transaction; the host records it after rollback", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const triples = yield* Triples;
        const before = yield* triples.currentPosition();
        const rejected = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO host_outbox (id, body) VALUES ('early', 'must roll back')`;
              yield* triples.transact(status("approved"), {
                actor: "user:intruder",
                commandId: "approve:2",
              });
              yield* sql`INSERT INTO host_outbox (id, body) VALUES ('late', 'never written')`;
            }),
          )
          .pipe(Effect.flip);
        // The enclosing transaction has rolled back; now record the refusal.
        const recorded =
          rejected instanceof CommitRejectedError
            ? yield* CommitValidation.recordRejection(triples, rejected)
            : undefined;
        return {
          rejected,
          recorded,
          before,
          after: yield* triples.currentPosition(),
          outbox: yield* outboxCount,
          facts: yield* triples.entity(record),
          receipt: yield* triples.transactionByCommand("approve:2"),
          audit:
            recorded === undefined
              ? null
              : yield* CommitValidation.readRejection(triples, recorded.entityId),
        };
      }),
    );
    expect(result.rejected).toBeInstanceOf(CommitRejectedError);
    expect(result.outbox).toBe(0);
    expect(result.facts).toHaveLength(0);
    expect(result.receipt).toBeNull();
    // Only the rejection record's own system transaction advanced the position.
    expect(result.after).toBe(result.before + 1);
    expect(result.audit?.attempt.commandId).toBe("approve:2");
    expect(result.audit?.rejections.map((finding) => finding.code)).toEqual(["not_approver"]);
  });

  it("discards an automatic record written inside an enclosing transaction that rolls back", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const triples = yield* Triples;
        const rejected = yield* sql
          .withTransaction(triples.transact(status("approved"), { actor: "user:intruder" }))
          .pipe(Effect.flip);
        const recorded = rejected instanceof CommitRejectedError ? rejected.recorded : undefined;
        return {
          recorded,
          audit:
            recorded === undefined
              ? null
              : yield* CommitValidation.readRejection(triples, recorded.entityId),
        };
      }),
      true,
    );
    // The record was written, but inside the host transaction that rolled back.
    expect(result.recorded).toBeDefined();
    expect(result.audit).toBeNull();
  });

  it("keeps automatic records for standalone transactions", async () => {
    const audit = await run(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const rejected = yield* triples
          .transact(status("approved"), { actor: "user:intruder" })
          .pipe(Effect.flip);
        return rejected instanceof CommitRejectedError && rejected.recorded !== undefined
          ? yield* CommitValidation.readRejection(triples, rejected.recorded.entityId)
          : null;
      }),
      true,
    );
    expect(audit?.attempt.actor).toBe("user:intruder");
  });
});
