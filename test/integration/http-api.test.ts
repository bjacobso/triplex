import {
  EntityId,
  KvTriples,
  TransactionConflictError,
  Triples,
  type TripleInput,
  type TriplesService,
} from "@bjacobso/triplex";
import { Attribute, ConfigStore, EntityType } from "@bjacobso/triplex/config";
import { EntityHttp, HttpAuthorizationAllowAll } from "@bjacobso/triplex-http";
import { SqliteTriples } from "@bjacobso/triplex-sqlite";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

const EmployerName = Attribute.text(":employer/name");
const EmployerNote = Attribute.text(":employer/note");
const EmployerTag = Attribute.text(":employer/tag");
const Employer = EntityType.make("Employer", {
  attributes: {
    name: Attribute.use(EmployerName, { required: true, unique: true }),
    note: Attribute.use(EmployerNote),
    tags: Attribute.use(EmployerTag, { cardinality: "many" }),
  },
});
const EmploymentEmployer = Attribute.ref(":employment/employer", Employer);
const EmploymentRole = Attribute.enumOf(":employment/role", ["engineer", "manager"]);
const Employment = EntityType.make("Employment", {
  attributes: {
    employer: Attribute.use(EmploymentEmployer, { required: true }),
    role: Attribute.use(EmploymentRole, { required: true }),
  },
});

const uniqueNodes = async () => {
  const nodes = await Effect.runPromise(Effect.all([Employer.nodes, Employment.nodes]));
  return [...new Map(nodes.flat().map((node) => [`${node.kind}\u0000${node.key}`, node])).values()];
};

const makeWebHandler = async (triplesLayer: Layer.Layer<any, any, any>) => {
  const objects = await uniqueNodes();
  const database = ConfigStore.layer.pipe(Layer.provideMerge(triplesLayer));
  let snapshotId = "";
  let configStore: ConfigStore.ConfigStoreService | undefined;
  let triplesStore: TriplesService | undefined;
  const seeded = Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* ConfigStore.ConfigStore;
      configStore = store;
      triplesStore = yield* Triples;
      const release = yield* store.commit({ label: "v1", objects, ref: "live" });
      snapshotId = release.snapshot.id;
    }),
  ).pipe(Layer.provideMerge(database));
  const routes = EntityHttp.layer({
    basePath: "/api",
    docs: true,
    exposure: { collections: { Employer: "employers", Employment: "employments" } },
  }).pipe(Layer.provide(HttpAuthorizationAllowAll), Layer.provide(seeded));
  const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
  // Route construction is lazy; force initialization before returning the captured snapshot.
  await web.handler(new Request("http://triplex.test/api/rest/latest/schema"));
  return {
    ...web,
    snapshotId: () => snapshotId,
    advanceLive: async () => {
      if (configStore === undefined) throw new Error("HTTP test ConfigStore was not initialized");
      return (await Effect.runPromise(configStore.commit({ label: "v2", objects, ref: "live" })))
        .snapshot.id;
    },
    assertFact: async (input: TripleInput) => {
      if (triplesStore === undefined) throw new Error("HTTP test Triples was not initialized");
      return Effect.runPromise(triplesStore.assert(input));
    },
    history: async (id: string) => {
      if (triplesStore === undefined) throw new Error("HTTP test Triples was not initialized");
      return Effect.runPromise(triplesStore.history(EntityId.make(id)));
    },
  };
};

const cases = [
  ["in-memory KV", KvTriples.layer],
  ["SQLite", SqliteTriples.layerMemory],
] as const;

describe.each(cases)("configuration-derived HTTP API over %s", (_name, triplesLayer) => {
  it("provides exact entity pages and insertion-race preconditions", async () => {
    const result = await Effect.runPromise(
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
        const conflict = yield* Effect.result(
          triples.transact([{ op: "retract", id: original.id }], {
            preconditions: [
              {
                _tag: "EntityState",
                entityId: "race:1",
                tripleIds: observed.map((fact) => fact.id),
              },
            ],
          }),
        );

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
          value: { type: "string", value: "later" },
        });
        const second = yield* triples.entityPage({
          entityType: "Paged",
          limit: 2,
          cursor: first.nextCursor!,
        });
        return { conflict, first, second };
      }).pipe(Effect.provide(triplesLayer)),
    );

    expect(result.conflict._tag).toBe("Failure");
    if (result.conflict._tag === "Failure") {
      expect(result.conflict.failure).toBeInstanceOf(TransactionConflictError);
    }
    expect(result.first.entities.map((facts) => facts[0]?.entityId)).toEqual(["page:a", "page:b"]);
    expect(result.second.entities.map((facts) => facts[0]?.entityId)).toEqual(["page:c"]);
    expect(result.second.snapshot).toEqual(result.first.snapshot);
  });

  it("serves schema/OpenAPI and round-trips atomic CRUD", async () => {
    const web = await makeWebHandler(triplesLayer);
    try {
      const schema = await web.handler(new Request("http://triplex.test/api/rest/latest/schema"));
      expect(schema.status).toBe(200);
      expect(schema.headers.get("x-triplex-config-snapshot")).toBe(web.snapshotId());
      expect((await schema.json()).entities).toHaveLength(2);

      const docs = await web.handler(new Request("http://triplex.test/api/rest/latest/docs"));
      expect(docs.status).toBe(200);
      expect(await docs.text()).toContain("api-reference-container");

      const openapi = await web.handler(
        new Request("http://triplex.test/api/rest/latest/openapi.json"),
      );
      expect(openapi.status).toBe(200);
      const latestOpenApi = await openapi.json();
      expect(Object.keys(latestOpenApi.paths)).toContain("/api/rest/latest/employers");
      expect(latestOpenApi.paths["/api/rest/latest/employers"].post).toBeDefined();

      const historicalOpenApi = await web.handler(
        new Request(`http://triplex.test/api/rest/${web.snapshotId()}/openapi.json`),
      );
      expect(historicalOpenApi.status).toBe(200);
      expect(
        (await historicalOpenApi.json()).paths[`/api/rest/${web.snapshotId()}/employers`].post,
      ).toBeUndefined();

      const invalid = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attributes: { name: "not-a-wire-alias" } }),
        }),
      );
      expect(invalid.status).toBe(400);
      expect(invalid.headers.get("x-triplex-config-snapshot")).toBe(web.snapshotId());

      const malformed = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
      );
      expect(malformed.status).toBe(400);

      const created = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            attributes: {
              ":employer/name": "Acme",
              ":employer/note": "old",
              ":employer/tag": ["z", "a", "a"],
            },
          }),
        }),
      );
      expect(created.status).toBe(201);
      expect(created.headers.get("location")).toMatch(/\/employers\/employer%3A/);
      const employer = await created.json();
      expect(employer.attributes[":employer/tag"]).toEqual(["a", "z"]);

      const replaced = await web.handler(
        new Request(
          `http://triplex.test/api/rest/latest/employers/${encodeURIComponent(employer.id)}`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ attributes: { ":employer/name": "Acme, Inc." } }),
          },
        ),
      );
      expect(replaced.status).toBe(200);
      expect((await replaced.json()).attributes).toEqual({ ":employer/name": "Acme, Inc." });

      const wrongCollection = await web.handler(
        new Request(
          `http://triplex.test/api/rest/latest/employments/${encodeURIComponent(employer.id)}`,
        ),
      );
      expect(wrongCollection.status).toBe(404);

      const invalidReference = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            attributes: {
              ":employment/employer": "employer:missing",
              ":employment/role": "engineer",
            },
          }),
        }),
      );
      expect(invalidReference.status).toBe(409);

      const invalidEnum = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            attributes: {
              ":employment/employer": employer.id,
              ":employment/role": "intern",
            },
          }),
        }),
      );
      expect(invalidEnum.status).toBe(400);

      const employment = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            attributes: {
              ":employment/employer": employer.id,
              ":employment/role": "engineer",
            },
          }),
        }),
      );
      expect(employment.status).toBe(201);

      const duplicate = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attributes: { ":employer/name": "Acme, Inc." } }),
        }),
      );
      expect(duplicate.status).toBe(409);

      const badTemporalRead = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employers?validAt=not-an-instant"),
      );
      expect(badTemporalRead.status).toBe(400);

      const secondEmployer = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attributes: { ":employer/name": "Beta" } }),
        }),
      );
      expect(secondEmployer.status).toBe(201);
      const secondEmployerBody = await secondEmployer.json();

      const page = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employers?limit=1"),
      );
      expect(page.status).toBe(200);
      const pageBody = await page.json();
      expect(pageBody.items).toHaveLength(1);
      expect(pageBody.nextCursor).toEqual(expect.any(String));

      const nextSnapshot = await web.advanceLive();
      expect(nextSnapshot).not.toBe(web.snapshotId());
      const movedContinuation = await web.handler(
        new Request(
          `http://triplex.test/api/rest/latest/employers?limit=1&cursor=${encodeURIComponent(pageBody.nextCursor)}`,
        ),
      );
      expect(movedContinuation.status).toBe(409);
      expect((await movedContinuation.json()).code).toBe("cursor_conflict");

      const historicalWrite = await web.handler(
        new Request(`http://triplex.test/api/rest/${web.snapshotId()}/employers`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attributes: { ":employer/name": "Historical" } }),
        }),
      );
      expect(historicalWrite.status).toBe(405);
      expect(historicalWrite.headers.get("allow")).toBe("GET");
      expect(historicalWrite.headers.get("x-triplex-config-snapshot")).toBe(web.snapshotId());

      const disposable = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attributes: { ":employer/name": "Disposable" } }),
        }),
      );
      expect(disposable.status).toBe(201);
      const disposableBody = await disposable.json();
      const deleted = await web.handler(
        new Request(
          `http://triplex.test/api/rest/latest/employers/${encodeURIComponent(disposableBody.id)}`,
          { method: "DELETE" },
        ),
      );
      expect(deleted.status).toBe(204);
      expect(await web.history(disposableBody.id)).not.toHaveLength(0);

      await web.assertFact({
        entityId: "employer:corrupt",
        entityType: "Employer",
        attribute: ":employer/name",
        value: { type: "number", value: 42 },
      });
      const corrupt = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employers/employer%3Acorrupt"),
      );
      expect(corrupt.status).toBe(409);
      expect((await corrupt.json()).code).toBe("data_shape_conflict");

      await web.assertFact({
        entityId: secondEmployerBody.id,
        entityType: "Employer",
        attribute: ":employer/note",
        value: { type: "string", value: "scheduled" },
        validFrom: Date.now() + 60_000,
      });
      const scheduledReplace = await web.handler(
        new Request(
          `http://triplex.test/api/rest/latest/employers/${encodeURIComponent(secondEmployerBody.id)}`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ attributes: { ":employer/name": "Beta renamed" } }),
          },
        ),
      );
      expect(scheduledReplace.status).toBe(409);
      expect((await scheduledReplace.json()).code).toBe("scheduled_facts");

      const blockedDelete = await web.handler(
        new Request(
          `http://triplex.test/api/rest/latest/employers/${encodeURIComponent(employer.id)}`,
          { method: "DELETE" },
        ),
      );
      expect(blockedDelete.status).toBe(409);
    } finally {
      await web.dispose();
    }
  });
});
