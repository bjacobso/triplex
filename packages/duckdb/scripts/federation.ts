import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { EntityId, Triples, string } from "@bjacobso/triplex";
import { SqliteTriples } from "@bjacobso/triplex-sqlite";
import { makeDuckdbFederation, SnapshotProvider, type FederatedQuery } from "../dist/index.js";

const directory = await mkdtemp(join(tmpdir(), "triplex-duckdb-demo-"));
try {
  const catalog = ["a", "b"].map((id) => ({
    id,
    tenant: `customer-${id}`,
    filename: join(directory, `${id}.sqlite`),
  }));
  for (const database of catalog) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        yield* triples.assertBatch([
          {
            entityId: EntityId.make("person:1"),
            attribute: ":person/email",
            value: string("shared@example.com"),
          },
          {
            entityId: EntityId.make("person:1"),
            attribute: ":person/name",
            value: string(database.id === "a" ? "Alice" : "Bob"),
          },
        ]);
      }).pipe(Effect.provide(SqliteTriples.layer({ filename: database.filename }))),
    );
  }
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const federation = yield* makeDuckdbFederation();
        const shortcut: FederatedQuery = {
          sources: { $a: "a", $b: "b" },
          find: ["?personA", "?personB", "?email"],
          where: [
            ["$a", "?personA", ":person/email", "?email"],
            ["$b", "?personB", ":person/email", "?email"],
          ],
        };
        const membership: FederatedQuery = {
          find: shortcut.find,
          where: [
            ["?dbA", ":triplex/tenant", "customer-a"],
            ["?personA", ":triplex/database", "?dbA"],
            ["?dbB", ":triplex/tenant", "customer-b"],
            ["?personB", ":triplex/database", "?dbB"],
            ["?personA", ":person/email", "?email"],
            ["?personB", ":person/email", "?email"],
          ],
        };
        const a = yield* federation.queryAll(shortcut);
        const b = yield* federation.queryAll(membership);
        if (JSON.stringify(a.results) !== JSON.stringify(b.results))
          throw new Error("Syntax results differ");
        return {
          results: a.results,
          federation: a.federation,
          membershipPlan: yield* federation.explain(membership),
        };
      }),
    ).pipe(Effect.provide(SnapshotProvider.local(catalog))),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
