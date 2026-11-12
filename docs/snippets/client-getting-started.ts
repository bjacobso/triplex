import { Effect, Layer, Schema } from "effect";
import { EntityId, KvTriples } from "@triplex-build/triplex";
import { Attribute, ConfigStore, EntityType } from "@triplex-build/triplex/config";
import * as Database from "@triplex-build/triplex/database";

const Company = EntityType.make("Company", {
  name: Attribute.text(":company/name").required(),
});
const Person = EntityType.make("Person", {
  name: Attribute.text(":person/name").required(),
  employer: Attribute.ref(":person/employer", Company).required(),
});
const alice = EntityId.make("person:alice");
const acme = EntityId.make("company:acme");
const Store = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));
const Client = Database.layer({ schema: { types: [Person, Company] } });

const publish = Effect.gen(function* () {
  const config = yield* ConfigStore.ConfigStore;
  yield* config.commit({
    label: "people-v1",
    objects: yield* EntityType.nodesOf(Person, Company),
    ref: "live",
  });
});

const program = Effect.gen(function* () {
  const db = yield* Database.Database;
  const receipt = yield* db.command(
    { actor: "user:pat", commandId: "quickstart/create-alice/v1" },
    (tx) =>
      Effect.gen(function* () {
        yield* tx.create(Company, acme, { name: "Acme" }, { validFrom: 0 });
        yield* tx.create(Person, alice, { name: "Alice", employer: acme }, { validFrom: 0 });
      }),
  );
  const person = yield* db.get(Person, alice);
  const relationships = yield* db.query(
    {
      find: ["?person", "?company"],
      where: [
        ...Person.where("?id", { name: "?person", employer: "?employer" }),
        ...Company.where("?employer", { name: "?company" }),
      ],
    },
    { decode: Schema.Struct({ "?person": Schema.String, "?company": Schema.String }) },
  );
  const then = yield* db.asOf({ recordedPosition: receipt.position, validAt: 0 });
  return {
    person: person?.values,
    relationships: relationships.results,
    knownThen: (yield* then.get(Person, alice))?.values,
  };
});

// Publish before acquiring the client, and share the same Store for both effects.
export const result = await Effect.runPromise(
  publish.pipe(Effect.andThen(program.pipe(Effect.provide(Client))), Effect.provide(Store)),
);
console.log(JSON.stringify(result, null, 2));
