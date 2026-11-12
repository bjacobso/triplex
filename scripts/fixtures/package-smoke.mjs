import { Effect } from "effect";
import { CanonicalJson } from "@triplex-build/triplex/content";

if (
  CanonicalJson.encodeOrThrow({ z: -0, a: [undefined, 1] }) !==
  JSON.stringify({ a: [null, 1], z: 0 })
) {
  throw new Error("Public canonical JSON encoding is unavailable or inconsistent");
}
import { EntityId, Triples, string } from "@triplex-build/triplex";
import { Runtime, DatabaseScope } from "@triplex-build/triplex/runtime";
import * as Derivation from "@triplex-build/triplex/derivation";
import { LiveQuery } from "@triplex-build/triplex/live-query";
void LiveQuery;
import { Why } from "@triplex-build/triplex/why";
import * as Database from "@triplex-build/triplex/database";
import { SqliteTriples } from "@triplex-build/triplex/sqlite";

if (typeof Database.layer !== "function" || typeof Database.Database !== "function") {
  throw new Error("Public database entry point is unavailable");
}

if (typeof Runtime.define !== "function" || typeof DatabaseScope.test("packed") !== "string") {
  throw new Error("Public runtime entry point is unavailable");
}

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const triples = yield* Triples;
    const alice = EntityId.make("person:alice");
    const bob = EntityId.make("person:bob");
    yield* triples.assert({
      entityId: alice,
      attribute: ":person/name",
      value: string("Alice"),
      validFrom: 0,
      validTo: 5,
    });
    const query = {
      find: ["?name"],
      where: [["?person", ":person/name", "?name"]],
    };
    const definition = yield* Derivation.make({
      name: "person.names",
      query,
      identity: ["?name"],
      configSnapshot: "config:consumer-smoke",
    });
    yield* Derivation.Materialization.materialize(triples, definition, {
      basis: { validAt: 1 },
    });
    const preview = yield* Derivation.Overlay.evaluateOverlay(triples, definition, {
      basis: { validAt: 1 },
      overlay: {
        assertions: [
          {
            entityId: bob,
            attribute: ":person/name",
            value: string("Bob"),
          },
        ],
      },
    });
    return {
      query: yield* triples.query(query, { basis: { validAt: 1 } }),
      preview,
      materialization: yield* Derivation.Materialization.current(triples, definition, {
        basis: { validAt: 1 },
      }),
    };
  }).pipe(Effect.provide(SqliteTriples.layerMemory)),
);

if (
  result.query.results.length !== 1 ||
  result.query.results[0]?.["?name"] !== "Alice" ||
  result.preview.candidates.length !== 2 ||
  result.preview.nextTemporalBoundary !== 5 ||
  !result.preview.candidates.some((candidate) =>
    candidate.sources.some((source) => source.hypothetical === true),
  ) ||
  result.materialization.status !== "current" ||
  result.materialization.nextTemporalBoundary !== 5 ||
  result.materialization.candidates.length !== 1
) {
  throw new Error("Unexpected packaged SQLite/Datalog result: " + JSON.stringify(result));
}

void Why;
