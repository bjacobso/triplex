/**
 * Ask 0019 (A), conditions 4 and 5, on KV and SQLite.
 *
 * 4. The transaction feed, live queries and subscriptions see every journaled
 *    transaction exactly once, across unjournaled maintenance writes (which
 *    consume positions without a journal entry), rejected commands and
 *    multi-entity commits. The runner reads the same feed; its corpus
 *    (`runnerCases`) runs against these backends as well.
 * 5. `why` explains a fact back to its transaction, actor and command.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
  KvTriplesLive,
  TriplesLive,
  CurrentDialect,
  DeterministicTripleStoreRuntimeLive,
  makeTestKvBackend,
  KvBackend,
  Triples,
  string,
  type TransactionRecord,
} from "@triplex-build/triplex/internal";
import { EntityId } from "@triplex-build/triplex";
import { SqliteAdapterLive, SqliteDialect, SqliteTestLayer } from "@triplex-build/triplex/sqlite";
import { SqlQueryExecutorLive } from "@triplex-build/triplex/sql";
import { DatabaseScope } from "@triplex-build/triplex/runtime";
import { LiveQuery } from "@triplex-build/triplex/live-query";
import { ConsumerCheckpoint } from "@triplex-build/triplex/operational";
import { makeSubscriptionManager } from "@triplex-build/triplex/subscriptions";
import { Why } from "@triplex-build/triplex/why";
import { whyTestLayer } from "@triplex-build/triplex/testkit";

const store = (backend: "kv" | "sqlite") =>
  (backend === "kv"
    ? KvTriplesLive.pipe(Layer.provide(Layer.sync(KvBackend, makeTestKvBackend)))
    : TriplesLive.pipe(
        Layer.provide(SqlQueryExecutorLive),
        Layer.provide(SqliteAdapterLive),
        Layer.provide(Layer.succeed(CurrentDialect, SqliteDialect)),
        Layer.provide(SqliteTestLayer),
      )
  ).pipe(Layer.provide(DeterministicTripleStoreRuntimeLive({ now: 0 })));

const eid = EntityId.make;
const assert = (entity: string, value: string) => ({
  op: "assert" as const,
  entityId: eid(entity),
  attribute: ":consumer/value",
  value: string(value),
});

for (const backend of ["kv", "sqlite"] as const) {
  describe(`${backend}: ask 0019 (A) journal consumers`, () => {
    it("condition 4: feed, live queries and subscriptions see each transaction once", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const t = yield* Triples;
          const live = yield* LiveQuery;
          const subscriptions = yield* makeSubscriptionManager;
          yield* subscriptions.register("values", {
            find: ["?e", "?v"],
            where: [["?e", ":consumer/value", "?v"]],
          });
          const metadata = yield* Stream.toPull(
            live.watch({ find: ["?tx", "?p"], where: [["?tx", ":_tx/position", "?p"]] }),
          );
          yield* metadata;

          const journaled: { txId: string; position: number }[] = [];
          const emitted: number[] = [];
          const record = (result: { txId: string; position: number }) =>
            Effect.gen(function* () {
              journaled.push(result);
              // One emission per commit, at that commit's position.
              const snapshot = (yield* metadata)[0];
              emitted.push(snapshot.position);
              expect(snapshot.position).toBe(result.position);
            });
          let checkpoint = 0;
          for (let round = 0; round < 6; round++) {
            yield* record(
              yield* t.transact(
                [assert(`consumer:${round}:a`, `a${round}`), assert(`consumer:${round}:b`, "b")],
                { actor: "consumer-test", commandId: `consumer-${round}` },
              ),
            );
            // A retried command is rejected and journals nothing.
            const retry = yield* t
              .transact([assert(`consumer:${round}:retry`, "x")], {
                commandId: `consumer-${round}`,
              })
              .pipe(Effect.flip);
            expect(retry._tag).toBe("CommandAlreadyCommittedError");
            if (round % 2 === 1) {
              // Unjournaled maintenance: a position without a journal entry.
              const next = yield* t.currentPosition();
              yield* ConsumerCheckpoint.advance(t, {
                consumer: "consumer-test",
                expectedPosition: checkpoint,
                nextPosition: next,
              });
              checkpoint = next;
              const gap = (yield* metadata)[0];
              expect(gap.position).toBe(yield* t.currentPosition());
            }
          }
          yield* record(
            yield* t.transact(
              [{ op: "retract-pattern", pattern: { attribute: ":consumer/value" } }],
              {
                actor: "consumer-test",
              },
            ),
          );
          const head = yield* t.currentPosition();
          // Unjournaled maintenance consumed positions: the journal has gaps.
          expect(head).toBe(journaled.at(-1)!.position);
          expect(journaled.length).toBeLessThan(head);

          // The feed, paged two at a time, holds each journaled transaction once, in order.
          const feed: TransactionRecord[] = [];
          for (let after = 0; ; ) {
            const page = yield* t.transactions({ after, limit: 2 });
            feed.push(...page.transactions);
            if (page.next === undefined) break;
            after = page.next;
          }
          expect(feed.map((tx) => [tx.txId, tx.position])).toEqual(
            journaled.map((tx) => [tx.txId, tx.position]),
          );
          // The entity-prefix feed returns a transaction once even when several entities match.
          const prefixed = yield* t.transactions({ entityIdPrefix: "consumer:", limit: 1000 });
          expect(prefixed.transactions.map((tx) => tx.position)).toEqual(
            journaled.map((tx) => tx.position),
          );
          // Live metadata: one emission per journaled commit, and each transaction once in the result.
          expect(emitted).toEqual(journaled.map((tx) => tx.position));
          const final = yield* t.queryAll({
            find: ["?tx", "?p"],
            where: [["?tx", ":_tx/position", "?p"]],
          });
          expect(final.results.map((row) => row["?tx"]).sort()).toEqual(
            journaled.map((tx) => tx.txId).sort(),
          );
          // Subscriptions fed from the feed: every change-bearing transaction affects them once.
          let affected = 0;
          for (const tx of feed) {
            const result = yield* subscriptions.checkAffected(
              tx.changes.map((change) => ({
                entityId: change.entityId,
                attribute: change.attribute,
                operation: change.op,
              })),
            );
            affected += result.affected.length;
          }
          expect(affected).toBe(feed.length);
        }).pipe(
          Effect.provide(LiveQuery.layer({ scope: DatabaseScope.test(`consumers:${backend}`) })),
          Effect.provide(store(backend)),
          Effect.scoped,
          Effect.provide(TestClock.layer()),
        ),
      );
    }, 30_000);

    it("condition 5: why explains a fact back to its transaction, actor and command", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const t = yield* Triples;
          const written = yield* t.transact([assert("why:subject", "explained")], {
            actor: "why-actor",
            commandId: "why-command",
            correlationId: "why-correlation",
          });
          const fact = written.triples[0]!;
          const retracted = yield* t.transact([{ op: "retract", id: fact.id }], {
            actor: "why-retractor",
            commandId: "why-retract",
          });
          const why = yield* Why;
          const explanation = yield* why.why(
            { kind: "fact", tripleId: fact.id },
            { basis: { recordedPosition: retracted.position, validAt: 1 } },
          );
          expect(explanation.facts).toEqual([
            expect.objectContaining({
              tripleId: fact.id,
              assertion: written.txId,
              retraction: retracted.txId,
            }),
          ]);
          expect(explanation.transactions).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                txId: written.txId,
                position: written.position,
                actor: "why-actor",
                commandId: "why-command",
                correlationId: "why-correlation",
              }),
              expect.objectContaining({
                txId: retracted.txId,
                actor: "why-retractor",
                commandId: "why-retract",
              }),
            ]),
          );
          expect(explanation.gaps).toEqual([]);
        }).pipe(
          Effect.provide(whyTestLayer.pipe(Layer.provideMerge(store(backend)))),
          Effect.scoped,
        ),
      );
    });
  });
}
