import { EntityId, KvTriples, Triples, type TriplesService } from "@triplex-build/triplex";
import { Attribute, ConfigStore, EntityType } from "@triplex-build/triplex/config";
import { KeyProvider, Sensitive, ValueCodec } from "@triplex-build/triplex/sensitive";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { describe, expect, it } from "vitest";

import { layerAllowAll as HttpAuthorizationAllowAll } from "../src/Authorization.js";
import * as EntityHttp from "../src/EntityHttp.js";

const PersonName = Attribute.text(":person/name");
const PersonSsn = Attribute.sensitive(Attribute.text(":person/ssn"));
const PersonAlias = Attribute.sensitive(Attribute.text(":person/alias"));
const Person = EntityType.make("Person", {
  name: Attribute.use(PersonName, { required: true }),
  ssn: Attribute.use(PersonSsn, { unique: true }),
  aliases: Attribute.use(PersonAlias, { cardinality: "many" }),
});

const PLANTED = "zq-http-planted-123-45-6789";

const sealedLayer = Sensitive.layer({ database: "http-test", attributes: [Person] }).pipe(
  Layer.provide(ValueCodec.aesGcm),
  Layer.provide(KeyProvider.test({ seed: "http-sensitive-test" })),
  Layer.provide(Layer.fresh(KvTriples.layer)),
);

const makeWebHandler = async (triplesLayer: Layer.Layer<Triples, unknown>) => {
  const objects = await Effect.runPromise(Person.nodes);
  let triplesStore: TriplesService | undefined;
  const seeded = Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* ConfigStore.ConfigStore;
      triplesStore = yield* Triples;
      yield* store.commit({ label: "v1", objects, ref: "live" });
    }),
  ).pipe(Layer.provideMerge(ConfigStore.layer.pipe(Layer.provideMerge(triplesLayer))));
  const routes = EntityHttp.layer({
    basePath: "/api",
    docs: true,
    exposure: { collections: { Person: "people" } },
  }).pipe(Layer.provide(HttpAuthorizationAllowAll), Layer.provide(seeded));
  const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
  await web.handler(new Request("http://triplex.test/api/rest/latest/schema"));
  return {
    ...web,
    triples: () => {
      if (triplesStore === undefined) throw new Error("Triples was not initialized");
      return triplesStore;
    },
  };
};

const post = (body: unknown) =>
  new Request("http://triplex.test/api/rest/latest/people", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

interface PersonDocument {
  readonly id: string;
  readonly attributes: Record<string, unknown>;
}

describe("sensitive attributes over HTTP", () => {
  it("seals writes and returns sealed markers from create, get and list", async () => {
    const web = await makeWebHandler(sealedLayer);
    try {
      const created = await web.handler(
        post({
          attributes: {
            ":person/name": "Ada",
            ":person/ssn": PLANTED,
            ":person/alias": ["first-alias", "second-alias"],
          },
        }),
      );
      const createdText = await created.text();
      expect(created.status).toBe(201);
      expect(createdText).not.toContain(PLANTED);
      expect(createdText).not.toContain("first-alias");
      const document = JSON.parse(createdText) as PersonDocument;
      expect(document.attributes[":person/name"]).toBe("Ada");
      expect(document.attributes[":person/ssn"]).toEqual({
        $sealed: { valueType: "string", keyId: "test:v1" },
      });
      expect(document.attributes[":person/alias"]).toHaveLength(2);

      const fetched = await web.handler(
        new Request(
          `http://triplex.test/api/rest/latest/people/${encodeURIComponent(document.id)}`,
        ),
      );
      const fetchedText = await fetched.text();
      expect(fetched.status).toBe(200);
      expect(fetchedText).not.toContain(PLANTED);
      expect((JSON.parse(fetchedText) as PersonDocument).attributes[":person/ssn"]).toEqual({
        $sealed: { valueType: "string", keyId: "test:v1" },
      });

      const listed = await web.handler(new Request("http://triplex.test/api/rest/latest/people"));
      const listedText = await listed.text();
      expect(listed.status).toBe(200);
      expect(listedText).not.toContain(PLANTED);
      expect(listedText).toContain("$sealed");

      const facts = await Effect.runPromise(web.triples().entity(EntityId.make(document.id)));
      const ssn = facts.find((fact) => fact.attribute === ":person/ssn");
      expect(ssn?.value.type).toBe("sealed");
      expect(JSON.stringify(facts)).not.toContain(PLANTED);

      // Uniqueness still holds over blind tokens through enforced HTTP writes.
      const duplicate = await web.handler(
        post({ attributes: { ":person/name": "Grace", ":person/ssn": PLANTED } }),
      );
      expect(duplicate.status).toBe(409);
      expect(await duplicate.text()).not.toContain(PLANTED);

      const openApi = await web.handler(
        new Request("http://triplex.test/api/rest/latest/openapi.json"),
      );
      const openApiText = await openApi.text();
      expect(openApi.status).toBe(200);
      expect(openApiText).toContain("$sealed");
    } finally {
      await web.dispose();
    }
  });

  it("fails closed when Triples is not decorated with Sensitive.layer", async () => {
    const web = await makeWebHandler(Layer.fresh(KvTriples.layer));
    try {
      const response = await web.handler(
        post({ attributes: { ":person/name": "Ada", ":person/ssn": PLANTED } }),
      );
      const body = await response.text();
      expect(response.status).toBe(500);
      expect(JSON.parse(body)).toMatchObject({
        error: { code: "http.sensitive-storage-required", retryable: false },
      });
      expect(body).toMatch(/requires a Sensitive.layer/);
      expect(body).not.toContain(PLANTED);
      const stored = await Effect.runPromise(web.triples().match({ attribute: ":person/ssn" }));
      expect(stored).toEqual([]);
    } finally {
      await web.dispose();
    }
  });

  it("renders sealed values as markers even for a non-sensitive release", async () => {
    const Plain = EntityType.make("Person", {
      name: Attribute.use(PersonName, { required: true }),
      ssn: Attribute.use(Attribute.text(":person/ssn")),
    });
    const objects = await Effect.runPromise(Plain.nodes);
    let triplesStore: TriplesService | undefined;
    const seeded = Layer.effectDiscard(
      Effect.gen(function* () {
        const store = yield* ConfigStore.ConfigStore;
        triplesStore = yield* Triples;
        yield* store.commit({ label: "v1", objects, ref: "live" });
      }),
    ).pipe(Layer.provideMerge(ConfigStore.layer.pipe(Layer.provideMerge(sealedLayer))));
    const routes = EntityHttp.layer({
      basePath: "/api",
      exposure: { collections: { Person: "people" } },
    }).pipe(Layer.provide(HttpAuthorizationAllowAll), Layer.provide(seeded));
    const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
    try {
      await web.handler(new Request("http://triplex.test/api/rest/latest/schema"));
      const triples = triplesStore!;
      await Effect.runPromise(
        triples.transact([
          {
            op: "assert",
            entityId: EntityId.make("person:sealed"),
            attribute: ":person/name",
            value: { type: "string", value: "Ada" },
            entityType: "Person",
          },
        ]),
      );
      // The host's sealing policy marks :person/ssn sensitive; this release does not.
      await Effect.runPromise(
        triples.transact([
          {
            op: "assert",
            entityId: EntityId.make("person:sealed"),
            attribute: ":person/ssn",
            value: { type: "string", value: PLANTED },
            entityType: "Person",
          },
        ]),
      );
      const fetched = await web.handler(
        new Request("http://triplex.test/api/rest/latest/people/person%3Asealed"),
      );
      const text = await fetched.text();
      expect(text).not.toContain(PLANTED);
      expect(fetched.status).toBe(200);
      expect((JSON.parse(text) as PersonDocument).attributes[":person/ssn"]).toEqual({
        $sealed: { valueType: "string", keyId: "test:v1" },
      });
    } finally {
      await web.dispose();
    }
  });
});
