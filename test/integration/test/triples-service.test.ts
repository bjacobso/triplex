/**
 * End-to-end tests for the merged `Triples` service on the SQLite backend,
 * driven through the one-line `SqliteTriples` convenience layer.
 *
 * Runs the shared testkit conformance suite (asserting SQL/KV parity for the
 * merged API, transact provenance, and write/Datalog coherence) plus a couple
 * of SQLite-specific recursive-rule checks.
 */

import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { EntityId, Triples } from "@triplex-build/triplex";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";
import {
  triplesConformanceCases,
  makeTriplesConformanceSuite,
} from "@triplex-build/triplex-testkit";

const eid = EntityId.make;

const provide = <A, E>(effect: Effect.Effect<A, E, Triples>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteTriples.layerMemory)));

describe("SqliteTriples convenience layer", () => {
  it("passes the full Triples conformance suite", async () => {
    await provide(makeTriplesConformanceSuite());
  });

  for (const c of triplesConformanceCases) {
    it(`conformance: ${c.name}`, async () => {
      await provide(c.run as Effect.Effect<void, unknown, Triples>);
    });
  }

  it("evaluates recursive rules via SQL CTEs", async () => {
    const ancestors = await provide(
      Effect.gen(function* () {
        const t = yield* Triples;
        yield* t.assertBatch([
          { entityId: eid("a"), attribute: ":parent", value: { type: "ref", value: eid("b") } },
          { entityId: eid("b"), attribute: ":parent", value: { type: "ref", value: eid("c") } },
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
        return results.map((r) => r["?ancestor"]);
      }),
    );
    expect(ancestors).toContain("b");
    expect(ancestors).toContain("c");
  });
});
