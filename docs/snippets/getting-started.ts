import { Effect } from "effect";
import { EntityId, KvTriples, Triples, ref, string } from "@triplex-build/triplex";

const program = Effect.gen(function* () {
  const triples = yield* Triples;
  const alice = EntityId.make("person:alice");
  const acme = EntityId.make("company:acme");

  yield* triples.transact(
    [
      {
        op: "assert",
        entityId: alice,
        entityType: "Person",
        attribute: ":person/name",
        value: string("Alice"),
      },
      {
        op: "assert",
        entityId: alice,
        entityType: "Person",
        attribute: ":person/employer",
        value: ref(acme),
      },
      {
        op: "assert",
        entityId: acme,
        entityType: "Company",
        attribute: ":company/name",
        value: string("Acme"),
      },
    ],
    {
      actor: "quickstart",
      commandId: "quickstart/create-alice/v1",
    },
  );

  const { results } = yield* triples.query({
    find: ["?personName", "?companyName"],
    where: [
      ["?person", ":person/name", "?personName"],
      ["?person", ":person/employer", "?company"],
      ["?company", ":company/name", "?companyName"],
    ],
  });

  return results.map((row) => ({
    person: row["?personName"],
    company: row["?companyName"],
  }));
});

const relationships = await Effect.runPromise(program.pipe(Effect.provide(KvTriples.layer)));

console.log(JSON.stringify({ relationships }, null, 2));
