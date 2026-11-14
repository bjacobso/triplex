/**
 * Ask 0019 (A), condition 3: Datalog patterns with a variable attribute see
 * application facts and `:_tx/*` transaction metadata together, with the same
 * rows as when the journal was stored as `_Transaction` facts in `triples`.
 *
 * The expected rows were captured on the storage layout before the journal
 * moved to its own tables (`JOURNAL_ROWS_CAPTURE=1` prints them), with
 * `:_tx/change` filtered out: it is no longer a Datalog attribute.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import {
  CurrentDialect,
  KvTriplesLive,
  SqliteDialect,
  TransactionId,
  TripleId,
  Triples,
  TriplesLive,
  TripleStoreRuntime,
  makeTestKvBackend,
  KvBackend,
  type DatalogQuery,
} from "@triplex-build/triplex/internal";
import { SqlQueryExecutorLive } from "@triplex-build/triplex/sql";
import { SqliteAdapterLive } from "@triplex-build/triplex/sqlite";
import { EntityId } from "@triplex-build/triplex";

const clock = { now: 1_000 };
const runtime = Layer.sync(TripleStoreRuntime, () => {
  let triple = 0;
  let transaction = 0;
  return {
    scope: "journal-variable-attribute",
    now: Effect.sync(() => clock.now),
    nextTripleId: Effect.sync(() => TripleId.make(String(++triple).padStart(26, "0"))),
    nextTxId: Effect.sync(() =>
      TransactionId.make(`_tx/${String(++transaction).padStart(26, "0")}`),
    ),
  };
});

const sqlite = TriplesLive.pipe(
  Layer.provide(SqlQueryExecutorLive),
  Layer.provide(SqliteAdapterLive),
  Layer.provide(Layer.succeed(CurrentDialect, SqliteDialect)),
  Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
  Layer.provide(runtime),
);
const kv = KvTriplesLive.pipe(
  Layer.provide(Layer.sync(KvBackend, makeTestKvBackend)),
  Layer.provide(runtime),
);

const text = (value: string) => ({ type: "string" as const, value });
const eid = EntityId.make;
const notChange = ["!=", "?a", ":_tx/change"] as const;

const queries: Record<string, { readonly query: DatalogQuery; readonly basis?: number }> = {
  // Facts → transaction → every metadata attribute of that transaction.
  journalOfFact: {
    query: {
      find: ["?tx", "?a", "?v"],
      where: [["?e", ":name", "Alice", "?tx"], ["?tx", "?a", "?v"], notChange],
    },
  },
  // Transaction metadata → changed entity → every attribute of that entity.
  factsOfJournal: {
    query: {
      find: ["?e", "?a", "?v"],
      where: [
        ["?tx", ":_tx/actor", "alice"],
        ["?tx", ":_tx/changed-entity", "?e"],
        ["?e", "?a", "?v"],
      ],
    },
  },
  // Every visible fact and metadata value, fully unbound.
  everything: {
    query: { find: ["?x", "?a", "?v"], where: [["?x", "?a", "?v"], notChange] },
  },
  // The same at an earlier recorded cut: the retraction and the third journal are not visible.
  everythingAtTwo: {
    query: { find: ["?x", "?a", "?v"], where: [["?x", "?a", "?v"], notChange] },
    basis: 2,
  },
  // Fourth term over facts and metadata, joined to the asserting actor.
  provenance: {
    query: {
      find: ["?e", "?a", "?actor"],
      where: [["?e", "?a", "?v", "?tx"], ["?tx", ":_tx/actor", "?actor"], notChange],
    },
  },
  // Aggregates over a variable attribute.
  attributeCounts: {
    query: {
      find: ["?a", "?count"],
      where: [["?x", "?a", "?v"], notChange],
      aggregate: [["count", "?x", "?count"]],
    },
  },
  // A variable attribute inside `not`: transactions that changed nothing named Bob.
  notBob: {
    query: {
      find: ["?tx"],
      where: [
        ["?tx", ":_tx/position", "?p"],
        ["not", ["?tx", ":_tx/changed-entity", "?e"], ["?e", "?a", "Bob"]],
      ],
    },
  },
};

const scenario = Effect.gen(function* () {
  const triples = yield* Triples;
  clock.now = 10_000;
  const first = yield* triples.transact(
    [
      { op: "assert", entityId: eid("p1"), attribute: ":name", value: text("Alice") },
      {
        op: "assert",
        entityId: eid("p1"),
        attribute: ":age",
        value: { type: "number", value: 30 },
        entityType: "Person",
      },
    ],
    { actor: "alice", commandId: "c1", correlationId: "corr-1" },
  );
  clock.now = 20_000;
  yield* triples.transact(
    [{ op: "assert", entityId: eid("p2"), attribute: ":name", value: text("Bob") }],
    { actor: "bob", causationId: "c1", configSnapshot: "cfg-1" },
  );
  clock.now = 30_000;
  yield* triples.transact([{ op: "retract", id: first.triples[1]!.id }], { actor: "alice" });
  clock.now = 40_000;
  const results: Record<string, unknown> = {};
  for (const [name, { query, basis }] of Object.entries(queries)) {
    const response = yield* triples.queryAll(
      query,
      basis === undefined ? undefined : { basis: { recordedPosition: basis } },
    );
    results[name] = response.results
      .map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort())))
      .sort();
  }
  return results;
});

const expected: Record<string, readonly string[]> = {
  journalOfFact: [
    '{"?a":":_tx/actor","?tx":"_tx/00000000000000000000000001","?v":"alice"}',
    '{"?a":":_tx/changed-entity","?tx":"_tx/00000000000000000000000001","?v":"p1"}',
    '{"?a":":_tx/command-id","?tx":"_tx/00000000000000000000000001","?v":"c1"}',
    '{"?a":":_tx/correlation-id","?tx":"_tx/00000000000000000000000001","?v":"corr-1"}',
    '{"?a":":_tx/instant","?tx":"_tx/00000000000000000000000001","?v":10000}',
    '{"?a":":_tx/position","?tx":"_tx/00000000000000000000000001","?v":1}',
  ],
  factsOfJournal: ['{"?a":":name","?e":"p1","?v":"Alice"}'],
  everything: [
    '{"?a":":_tx/actor","?v":"alice","?x":"_tx/00000000000000000000000001"}',
    '{"?a":":_tx/actor","?v":"alice","?x":"_tx/00000000000000000000000003"}',
    '{"?a":":_tx/actor","?v":"bob","?x":"_tx/00000000000000000000000002"}',
    '{"?a":":_tx/causation-id","?v":"c1","?x":"_tx/00000000000000000000000002"}',
    '{"?a":":_tx/changed-entity","?v":"p1","?x":"_tx/00000000000000000000000001"}',
    '{"?a":":_tx/changed-entity","?v":"p1","?x":"_tx/00000000000000000000000003"}',
    '{"?a":":_tx/changed-entity","?v":"p2","?x":"_tx/00000000000000000000000002"}',
    '{"?a":":_tx/command-id","?v":"c1","?x":"_tx/00000000000000000000000001"}',
    '{"?a":":_tx/config-snapshot","?v":"cfg-1","?x":"_tx/00000000000000000000000002"}',
    '{"?a":":_tx/correlation-id","?v":"corr-1","?x":"_tx/00000000000000000000000001"}',
    '{"?a":":_tx/instant","?v":10000,"?x":"_tx/00000000000000000000000001"}',
    '{"?a":":_tx/instant","?v":20000,"?x":"_tx/00000000000000000000000002"}',
    '{"?a":":_tx/instant","?v":30000,"?x":"_tx/00000000000000000000000003"}',
    '{"?a":":_tx/position","?v":1,"?x":"_tx/00000000000000000000000001"}',
    '{"?a":":_tx/position","?v":2,"?x":"_tx/00000000000000000000000002"}',
    '{"?a":":_tx/position","?v":3,"?x":"_tx/00000000000000000000000003"}',
    '{"?a":":name","?v":"Alice","?x":"p1"}',
    '{"?a":":name","?v":"Bob","?x":"p2"}',
  ],
  everythingAtTwo: [
    '{"?a":":_tx/actor","?v":"alice","?x":"_tx/00000000000000000000000001"}',
    '{"?a":":_tx/actor","?v":"bob","?x":"_tx/00000000000000000000000002"}',
    '{"?a":":_tx/causation-id","?v":"c1","?x":"_tx/00000000000000000000000002"}',
    '{"?a":":_tx/changed-entity","?v":"p1","?x":"_tx/00000000000000000000000001"}',
    '{"?a":":_tx/changed-entity","?v":"p2","?x":"_tx/00000000000000000000000002"}',
    '{"?a":":_tx/command-id","?v":"c1","?x":"_tx/00000000000000000000000001"}',
    '{"?a":":_tx/config-snapshot","?v":"cfg-1","?x":"_tx/00000000000000000000000002"}',
    '{"?a":":_tx/correlation-id","?v":"corr-1","?x":"_tx/00000000000000000000000001"}',
    '{"?a":":_tx/instant","?v":10000,"?x":"_tx/00000000000000000000000001"}',
    '{"?a":":_tx/instant","?v":20000,"?x":"_tx/00000000000000000000000002"}',
    '{"?a":":_tx/position","?v":1,"?x":"_tx/00000000000000000000000001"}',
    '{"?a":":_tx/position","?v":2,"?x":"_tx/00000000000000000000000002"}',
    '{"?a":":age","?v":30,"?x":"p1"}',
    '{"?a":":name","?v":"Alice","?x":"p1"}',
    '{"?a":":name","?v":"Bob","?x":"p2"}',
  ],
  provenance: [
    '{"?a":":_tx/actor","?actor":"alice","?e":"_tx/00000000000000000000000001"}',
    '{"?a":":_tx/actor","?actor":"alice","?e":"_tx/00000000000000000000000003"}',
    '{"?a":":_tx/actor","?actor":"bob","?e":"_tx/00000000000000000000000002"}',
    '{"?a":":_tx/causation-id","?actor":"bob","?e":"_tx/00000000000000000000000002"}',
    '{"?a":":_tx/changed-entity","?actor":"alice","?e":"_tx/00000000000000000000000001"}',
    '{"?a":":_tx/changed-entity","?actor":"alice","?e":"_tx/00000000000000000000000003"}',
    '{"?a":":_tx/changed-entity","?actor":"bob","?e":"_tx/00000000000000000000000002"}',
    '{"?a":":_tx/command-id","?actor":"alice","?e":"_tx/00000000000000000000000001"}',
    '{"?a":":_tx/config-snapshot","?actor":"bob","?e":"_tx/00000000000000000000000002"}',
    '{"?a":":_tx/correlation-id","?actor":"alice","?e":"_tx/00000000000000000000000001"}',
    '{"?a":":_tx/instant","?actor":"alice","?e":"_tx/00000000000000000000000001"}',
    '{"?a":":_tx/instant","?actor":"alice","?e":"_tx/00000000000000000000000003"}',
    '{"?a":":_tx/instant","?actor":"bob","?e":"_tx/00000000000000000000000002"}',
    '{"?a":":_tx/position","?actor":"alice","?e":"_tx/00000000000000000000000001"}',
    '{"?a":":_tx/position","?actor":"alice","?e":"_tx/00000000000000000000000003"}',
    '{"?a":":_tx/position","?actor":"bob","?e":"_tx/00000000000000000000000002"}',
    '{"?a":":name","?actor":"alice","?e":"p1"}',
    '{"?a":":name","?actor":"bob","?e":"p2"}',
  ],
  attributeCounts: [
    '{"?a":":_tx/actor","?count":3}',
    '{"?a":":_tx/causation-id","?count":1}',
    '{"?a":":_tx/changed-entity","?count":3}',
    '{"?a":":_tx/command-id","?count":1}',
    '{"?a":":_tx/config-snapshot","?count":1}',
    '{"?a":":_tx/correlation-id","?count":1}',
    '{"?a":":_tx/instant","?count":3}',
    '{"?a":":_tx/position","?count":3}',
    '{"?a":":name","?count":2}',
  ],
  notBob: ['{"?tx":"_tx/00000000000000000000000001"}', '{"?tx":"_tx/00000000000000000000000003"}'],
};

describe("ask 0019 (A) condition 3: variable-attribute Datalog over facts and :_tx/*", () => {
  for (const [name, layer] of [
    ["SQLite", sqlite],
    ["KV", kv],
  ] as const) {
    it(`${name} returns the rows captured before the journal moved`, async () => {
      const results = await Effect.runPromise(scenario.pipe(Effect.provide(Layer.fresh(layer))));
      if (process.env["JOURNAL_ROWS_CAPTURE"] !== undefined) {
        console.log(`${name}:\n${JSON.stringify(results, null, 2)}`);
        return;
      }
      expect(results).toEqual(expected);
    });
  }
});
