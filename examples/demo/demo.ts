import { Effect } from "effect";
import { EntityId, KvTriples, Triples, number, ref, string } from "@triplex-build/triplex";

const program = Effect.gen(function* () {
  const triples = yield* Triples;
  const alice = EntityId.make("person:alice");
  const bob = EntityId.make("person:bob");

  yield* triples.assertBatch([
    {
      entityId: alice,
      attribute: ":person/name",
      value: string("Alice"),
    },
    {
      entityId: alice,
      attribute: ":person/age",
      value: number(34),
    },
    {
      entityId: alice,
      attribute: ":person/friend",
      value: ref(bob),
    },
    {
      entityId: bob,
      attribute: ":person/name",
      value: string("Bob"),
    },
    {
      entityId: bob,
      attribute: ":person/age",
      value: number(28),
    },
  ]);

  const aliceFacts = yield* triples.match({ entityId: alice });

  const { results: adults } = yield* triples.query({
    find: ["?name", "?age"],
    where: [
      ["?person", ":person/name", "?name"],
      ["?person", ":person/age", "?age"],
      [">=", "?age", 30],
    ],
  });

  const { results: friends } = yield* triples.query({
    find: ["?personName", "?friendName"],
    where: [
      ["?person", ":person/name", "?personName"],
      ["?person", ":person/friend", "?friend"],
      ["?friend", ":person/name", "?friendName"],
    ],
  });

  return { aliceFacts, adults, friends };
});

const result = await Effect.runPromise(program.pipe(Effect.provide(KvTriples.layer)));

console.log("Alice's facts:", result.aliceFacts);
console.log("People aged 30 or older:", result.adults);
console.log("Friend relationships:", result.friends);
