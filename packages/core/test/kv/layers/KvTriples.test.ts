/**
 * Tests for the merged KV `Triples` layer.
 *
 * Exercises writes and Datalog reads through the single service, including a
 * regression test for retract/query cache coherence.
 */

import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { KvTriples, TransactionConflictError, Triples } from "../../../src/index.js";
import type { TripleId } from "../../../src/Branded.js";
import { makeTestKvBackend } from "../../../src/kv/kv/InMemoryKvBackend.js";
import { KvBackend } from "../../../src/kv/kv/KvBackend.js";
import { KvTriplesLive } from "../../../src/kv/layers/KvTriplesLive.js";
import { TripleStoreRuntime } from "../../../src/store/TripleStoreRuntime.js";

const run = <A, E>(effect: Effect.Effect<A, E, Triples>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(KvTriples.layer)));

describe("KvTriples (merged service)", () => {
  it("asserts and reads a fact back through match + datalog query", async () => {
    const result = await run(
      Effect.gen(function* () {
        const t = yield* Triples;
        yield* t.assert({
          entityId: "p1",
          attribute: ":name",
          value: { type: "string", value: "Alice" },
          entityType: "Person",
        });

        const matched = yield* t.match({ entityId: "p1", attribute: ":name" });
        const { results } = yield* t.query({
          find: ["?name"],
          where: [["?p", ":name", "?name"]],
        });
        return { matched: matched.length, names: results.map((r) => r["?name"]) };
      }),
    );

    expect(result.matched).toBe(1);
    expect(result.names).toContain("Alice");
  });

  it("transact writes ordered provenance datoms", async () => {
    const attrs = await run(
      Effect.gen(function* () {
        const t = yield* Triples;
        const tx = yield* t.transact(
          [
            {
              op: "assert",
              entityId: "p2",
              attribute: ":age",
              value: { type: "number", value: 30 },
              entityType: "Person",
            },
          ],
          { actor: "alice" },
        );
        const txTriples = yield* t.match({ entityId: tx.txId });
        return txTriples.map((tr) => tr.attribute as string);
      }),
    );

    expect(attrs).toContain(":_tx/instant");
    expect(attrs).toContain(":_tx/position");
    expect(attrs).toContain(":_tx/actor");
  });

  it("pages transaction journals from a durable commit position", async () => {
    const result = await run(
      Effect.gen(function* () {
        const t = yield* Triples;
        const first = yield* t.transact([
          {
            op: "assert",
            entityId: "event:1",
            attribute: ":event/name",
            value: { type: "string", value: "first" },
          },
        ]);
        const second = yield* t.transact([
          {
            op: "assert",
            entityId: "event:2",
            attribute: ":event/name",
            value: { type: "string", value: "second" },
          },
        ]);
        return {
          first,
          second,
          page: yield* t.transactions({ after: first.position, limit: 1 }),
          empty: yield* t.transactions({ after: second.position }),
        };
      }),
    );

    expect(result.second.position).toBe(result.first.position + 1);
    expect(result.page.transactions.map((record) => record.txId)).toEqual([result.second.txId]);
    expect(result.page.next).toBe(result.second.position);
    expect(result.empty).toEqual({ transactions: [] });
  });

  it("keeps paged results stable when every transaction has the same millisecond", async () => {
    let id = 0;
    const nextId = () => String(++id).padStart(26, "0");
    const layer = KvTriplesLive.pipe(
      Layer.provide(Layer.succeed(KvBackend, makeTestKvBackend())),
      Layer.provide(
        Layer.succeed(TripleStoreRuntime, {
          scope: "test:pagination-position",
          now: Effect.succeed(1_800_000_000_000),
          nextTxId: Effect.sync(() => `_tx/${nextId()}`),
          nextTripleId: Effect.sync(() => nextId() as TripleId),
        }),
      ),
    );

    const pages = await Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* Triples;
        const seeded = yield* t.assertBatch(
          ["a", "b", "c", "d"].map((suffix, index) => ({
            entityId: `same-time:${suffix}`,
            attribute: ":page/rank",
            value: { type: "number" as const, value: index === 3 ? 2 : 1 },
          })),
        );
        const query = {
          inner: {
            find: ["?entity", "?rank"],
            where: [["?entity", ":page/rank", "?rank"]],
          },
          orderBy: [{ variable: "?rank", direction: "asc" }],
          limit: 2,
        } as const;
        const first = yield* t.queryPage(query);
        yield* t.assert({
          entityId: "same-time:later",
          attribute: ":page/rank",
          value: { type: "number", value: 0 },
        });
        yield* t.retract(seeded[2]!.id);
        const second = yield* t.queryPage({ ...query, cursor: first.nextCursor });
        return { first, second };
      }).pipe(Effect.provide(layer)),
    );

    expect(pages.first.results.map((row) => row["?entity"])).toEqual([
      "same-time:a",
      "same-time:b",
    ]);
    expect(pages.second.results.map((row) => row["?entity"])).toEqual([
      "same-time:c",
      "same-time:d",
    ]);
  });

  it("persists a causal transaction journal and rejects stale replacements", async () => {
    const result = await run(
      Effect.gen(function* () {
        const t = yield* Triples;
        const current = yield* t.assert({
          entityId: "task:1",
          attribute: ":task/status",
          value: { type: "string", value: "open" },
        });
        const committed = yield* t.transact(
          [
            { op: "retract", id: current.id },
            {
              op: "assert",
              entityId: "task:1",
              attribute: ":task/status",
              value: { type: "string", value: "claimed" },
            },
          ],
          {
            actor: "agent:worker-7",
            commandId: "claim:task:1",
            correlationId: "routine:42",
            causationId: "event:41",
            configSnapshot: "sha256:config",
            preconditions: [{ _tag: "TripleLive", id: current.id }],
          },
        );
        const conflict = yield* t
          .transact(
            [
              { op: "retract", id: current.id },
              {
                op: "assert",
                entityId: "task:1",
                attribute: ":task/status",
                value: { type: "string", value: "cancelled" },
              },
            ],
            { preconditions: [{ _tag: "TripleLive", id: current.id }] },
          )
          .pipe(Effect.flip);
        return {
          currentId: current.id,
          conflict,
          journal: yield* t.transaction(committed.txId),
          status: yield* t.match({ entityId: "task:1", attribute: ":task/status" }),
        };
      }),
    );

    expect(result.conflict).toBeInstanceOf(TransactionConflictError);
    expect(result.status.map((triple) => triple.value)).toEqual([
      { type: "string", value: "claimed" },
    ]);
    expect(result.journal).toEqual(
      expect.objectContaining({
        actor: "agent:worker-7",
        commandId: "claim:task:1",
        correlationId: "routine:42",
        causationId: "event:41",
        configSnapshot: "sha256:config",
        changes: expect.arrayContaining([
          expect.objectContaining({ op: "retract", tripleId: result.currentId }),
          expect.objectContaining({ op: "assert", entityId: "task:1" }),
        ]),
      }),
    );
  });

  it("rejects replacement after an insertion-only entity race", async () => {
    const result = await run(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const original = yield* triples.assert({
          entityId: "race:1",
          entityType: "Race",
          attribute: ":race/name",
          value: { type: "string", value: "before" },
        });
        const observed = yield* triples.entity("race:1");
        yield* triples.assert({
          entityId: "race:1",
          entityType: "Race",
          attribute: ":race/note",
          value: { type: "string", value: "concurrent" },
        });
        return yield* Effect.result(
          triples.transact(
            [
              { op: "retract", id: original.id },
              {
                op: "assert",
                entityId: "race:1",
                entityType: "Race",
                attribute: ":race/name",
                value: { type: "string", value: "after" },
              },
            ],
            {
              preconditions: [
                {
                  _tag: "EntityState",
                  entityId: "race:1",
                  tripleIds: observed.map((fact) => fact.id),
                },
              ],
            },
          ),
        );
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(TransactionConflictError);
  });

  it("materializes entity pages at one exact commit cut", async () => {
    const pages = await run(
      Effect.gen(function* () {
        const triples = yield* Triples;
        yield* triples.assertBatch(
          ["a", "b", "c"].map((suffix) => ({
            entityId: `page:${suffix}`,
            entityType: "Paged",
            attribute: ":page/name",
            value: { type: "string" as const, value: suffix },
          })),
        );
        const first = yield* triples.entityPage({ entityType: "Paged", limit: 2 });
        yield* triples.assert({
          entityId: "page:aa",
          entityType: "Paged",
          attribute: ":page/name",
          value: { type: "string", value: "inserted later" },
        });
        const second = yield* triples.entityPage({
          entityType: "Paged",
          limit: 2,
          cursor: first.nextCursor,
        });
        return { first, second };
      }),
    );

    expect(pages.first.entities.map((facts) => facts[0]?.entityId)).toEqual(["page:a", "page:b"]);
    expect(pages.second.entities.map((facts) => facts[0]?.entityId)).toEqual(["page:c"]);
    expect(pages.second.snapshot).toEqual(pages.first.snapshot);
  });

  it("rolls back every KV write when a transaction dies partway through", async () => {
    let generated = 0;
    const layer = KvTriplesLive.pipe(
      Layer.provide(Layer.succeed(KvBackend, makeTestKvBackend())),
      Layer.provide(
        Layer.succeed(TripleStoreRuntime, {
          scope: "test:kv",
          now: Effect.succeed(1_800_000_000_000),
          nextTxId: Effect.succeed("_tx/01AAAAAAAAAAAAAAAAAAAAAAAA"),
          nextTripleId: Effect.sync(() => {
            generated++;
            if (generated === 2) throw new Error("injected id failure");
            return `01${String(generated).padStart(24, "A")}` as TripleId;
          }),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* Triples;
        yield* Effect.exit(
          t.transact([
            {
              op: "assert",
              entityId: "partial:1",
              attribute: ":value",
              value: { type: "string", value: "first" },
            },
            {
              op: "assert",
              entityId: "partial:2",
              attribute: ":value",
              value: { type: "string", value: "second" },
            },
          ]),
        );
        const committed = yield* t.transact([
          {
            op: "assert",
            entityId: "complete:1",
            attribute: ":value",
            value: { type: "string", value: "complete" },
          },
        ]);
        return {
          committed,
          partial: yield* t.match({ entityId: "partial:1" }),
          complete: yield* t.match({ entityId: "complete:1" }),
        };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.partial).toEqual([]);
    expect(result.complete).toHaveLength(1);
    expect(result.committed.position).toBe(1);
  });

  // Regression: retracts must invalidate the same hexastore cache used by
  // Datalog queries.
  it("does not surface a write-path retraction as a stale datalog result", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const t = yield* Triples;
        const triple = yield* t.assert({
          entityId: "widget:1",
          attribute: ":active",
          value: { type: "boolean", value: true },
          entityType: "Widget",
        });

        // Query once so any cache is warm, then retract via the write path.
        yield* t.query({ find: ["?e"], where: [["?e", ":active", true]] });
        yield* t.retract(triple.id);

        const { results } = yield* t.query({
          find: ["?e"],
          where: [["?e", ":active", true]],
        });
        return results.map((r) => r["?e"]);
      }),
    );

    expect(seen).not.toContain("widget:1");
  });

  it("evaluates recursive rules through the merged service (KV fixpoint)", async () => {
    const ancestors = await run(
      Effect.gen(function* () {
        const t = yield* Triples;
        yield* t.assertBatch([
          { entityId: "a", attribute: ":parent", value: { type: "ref", value: "b" } },
          { entityId: "b", attribute: ":parent", value: { type: "ref", value: "c" } },
          { entityId: "c", attribute: ":parent", value: { type: "ref", value: "d" } },
          { entityId: "unrelated", attribute: ":parent", value: { type: "ref", value: "other" } },
        ]);

        const { results } = yield* t.query({
          find: ["?ancestor"],
          where: [["ancestor", "a", "?ancestor"]],
          rules: [
            { name: "ancestor", body: [["?x", ":parent", "?y"]] },
            {
              name: "ancestor",
              body: [
                ["?x", ":parent", "?z"],
                ["ancestor", "?z", "?y"],
              ],
            },
          ],
        });
        return results.map((r) => r["?ancestor"]).sort();
      }),
    );

    expect(ancestors).toEqual(["b", "c", "d"]);
  });
});
