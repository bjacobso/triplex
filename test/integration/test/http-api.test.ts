import {
  EntityId,
  KvTriples,
  TransactionConflictError,
  Triples,
  type TripleInput,
  type TriplesService,
} from "@triplex-build/triplex";
import { Attribute, ConfigStore, EntityType } from "@triplex-build/triplex/config";
import {
  EntityHttp,
  ForbiddenError,
  HttpAuthorization,
  HttpAuthorizationAllowAll,
  UnauthorizedError,
} from "@triplex-build/triplex-http";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { describe, expect, it } from "vitest";

const EmployerName = Attribute.text(":employer/name");
const EmployerNote = Attribute.text(":employer/note");
const EmployerTag = Attribute.text(":employer/tag");
const Employer = EntityType.make("Employer", {
  name: Attribute.use(EmployerName, { required: true, unique: true }),
  note: Attribute.use(EmployerNote),
  tags: Attribute.use(EmployerTag, { cardinality: "many" }),
});
const EmploymentEmployer = Attribute.ref(":employment/employer", Employer);
const EmploymentRole = Attribute.enumOf(":employment/role", ["engineer", "manager"]);
const Employment = EntityType.make("Employment", {
  employer: Attribute.use(EmploymentEmployer, { required: true }),
  role: Attribute.use(EmploymentRole, { required: true }),
});

const uniqueNodes = () => Effect.runPromise(EntityType.nodesOf(Employer, Employment));

interface ErrorResponse {
  readonly error: { readonly code: string };
}

interface DocumentResponse {
  readonly id: string;
  readonly attributes: Record<string, unknown>;
}

interface OpenApiResponse {
  readonly paths: Record<string, { readonly post?: unknown }>;
}

interface ListResponse {
  readonly items: readonly unknown[];
  readonly nextCursor: string;
}

const responseJson = <A>(response: Response): Promise<A> => response.json() as Promise<A>;

const makeWebHandler = async (
  triplesLayer: Layer.Layer<Triples, unknown>,
  authorizationLayer: Layer.Layer<HttpAuthorization> = HttpAuthorizationAllowAll,
) => {
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
  }).pipe(Layer.provide(authorizationLayer), Layer.provide(seeded));
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
    position: async () => {
      if (triplesStore === undefined) throw new Error("HTTP test Triples was not initialized");
      return Effect.runPromise(triplesStore.currentPosition());
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
  it("reports retryable transaction conflicts with Retry-After", async () => {
    let conflict = false;
    const failing = Layer.effect(
      Triples,
      Effect.map(Triples, (triples) => ({
        ...triples,
        transact: (...args: Parameters<TriplesService["transact"]>) =>
          conflict
            ? Effect.fail(new TransactionConflictError({ message: "Concurrent update" }))
            : triples.transact(...args),
      })),
    ).pipe(Layer.provide(triplesLayer));
    const web = await makeWebHandler(failing);
    try {
      conflict = true;
      const response = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attributes: { ":employer/name": "Race" } }),
        }),
      );
      expect(response.status).toBe(409);
      expect(response.headers.get("retry-after")).toBe("0");
      expect(await response.json()).toEqual({
        error: {
          code: "transaction.conflict.precondition",
          message: "Concurrent update",
          retryable: true,
          fix: "Reload current facts and retry the whole command.",
        },
      });
    } finally {
      await web.dispose();
    }
  });

  it("preserves commit-position entity reads and collection cursors", async () => {
    const web = await makeWebHandler(triplesLayer);
    try {
      for (const [suffix, name] of [
        ["a", "Alice"],
        ["b", "Bob"],
      ] as const)
        await web.assertFact({
          entityId: EntityId.make(`employer:pos-${suffix}`),
          entityType: "Employer",
          attribute: ":employer/name",
          value: { type: "string", value: name },
          validFrom: 0,
        });
      const position = await web.position();
      const renamed = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employers/employer%3Apos-a", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attributes: { ":employer/name": "Alicia" } }),
        }),
      );
      expect(renamed.status).toBe(200);
      await web.assertFact({
        entityId: EntityId.make("employer:pos-c"),
        entityType: "Employer",
        attribute: ":employer/name",
        value: { type: "string", value: "Carol" },
        validFrom: 0,
      });
      const historical = await web.handler(
        new Request(
          `http://triplex.test/api/rest/latest/employers/employer%3Apos-a?recordedPosition=${position}`,
        ),
      );
      expect(historical.status).toBe(200);
      expect((await responseJson<DocumentResponse>(historical)).attributes).toEqual({
        ":employer/name": "Alice",
      });
      const first = await web.handler(
        new Request(
          `http://triplex.test/api/rest/latest/employers?recordedPosition=${position}&limit=1`,
        ),
      );
      const page = await responseJson<{ items: DocumentResponse[]; nextCursor: string }>(first);
      expect(page.items.map((item) => item.id)).toEqual(["employer:pos-a"]);
      const next = await web.handler(
        new Request(
          `http://triplex.test/api/rest/latest/employers?cursor=${encodeURIComponent(page.nextCursor)}&limit=10`,
        ),
      );
      expect(
        (await responseJson<{ items: DocumentResponse[] }>(next)).items.map((item) => item.id),
      ).toEqual(["employer:pos-b"]);
      const emptyEntity = await web.handler(
        new Request(
          "http://triplex.test/api/rest/latest/employers/employer%3Apos-a?recordedPosition=0",
        ),
      );
      expect(emptyEntity.status).toBe(404);
      const empty = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employers?recordedPosition=0"),
      );
      expect((await responseJson<{ items: DocumentResponse[] }>(empty)).items).toEqual([]);
      for (const value of ["-1", "0.5", "Infinity", "9007199254740992", "invalid", ""]) {
        expect(
          (
            await web.handler(
              new Request(
                `http://triplex.test/api/rest/latest/employers?recordedPosition=${value}`,
              ),
            )
          ).status,
        ).toBe(400);
      }
      expect(
        (
          await web.handler(
            new Request(
              `http://triplex.test/api/rest/latest/employers?recordedPosition=${position}&recordedAt=1`,
            ),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await web.handler(
            new Request(
              `http://triplex.test/api/rest/latest/employers?recordedPosition=${position}`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  attributes: { ":employer/name": "Forbidden temporal write" },
                }),
              },
            ),
          )
        ).status,
      ).toBe(400);
    } finally {
      await web.dispose();
    }
  });
  it("maps host authorization failures to 401 and 403", async () => {
    const authorization = Layer.succeed(
      HttpAuthorization,
      HttpAuthorization.of({
        authorize: ({ request }) => {
          const token = request.headers["authorization"];
          return token === undefined
            ? Effect.fail(
                new UnauthorizedError({
                  code: "http.unauthorized",
                  message: "Authentication required",
                }),
              )
            : token !== "Bearer allowed"
              ? Effect.fail(
                  new ForbiddenError({ code: "http.forbidden", message: "Access denied" }),
                )
              : Effect.void;
        },
        canReadEntity: () => Effect.succeed(true),
        actor: () => Effect.succeed(undefined),
      }),
    );
    const web = await makeWebHandler(triplesLayer, authorization);
    try {
      const unauthorized = await web.handler(
        new Request("http://triplex.test/api/rest/latest/schema"),
      );
      expect(unauthorized.status).toBe(401);
      expect((await responseJson<ErrorResponse>(unauthorized)).error.code).toBe(
        "http.unauthorized",
      );

      const forbidden = await web.handler(
        new Request("http://triplex.test/api/rest/latest/schema", {
          headers: { authorization: "Bearer denied" },
        }),
      );
      expect(forbidden.status).toBe(403);
      expect((await responseJson<ErrorResponse>(forbidden)).error.code).toBe("http.forbidden");
    } finally {
      await web.dispose();
    }
  });

  it("provides exact entity pages and insertion-race preconditions", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const raceId = EntityId.make("race:1");
        const original = yield* triples.assert({
          entityId: raceId,
          entityType: "Race",
          attribute: ":race/name",
          value: { type: "string", value: "before" },
        });
        const observed = yield* triples.entity(raceId);
        yield* triples.assert({
          entityId: raceId,
          entityType: "Race",
          attribute: ":race/note",
          value: { type: "string", value: "concurrent" },
        });
        const conflict = yield* Effect.result(
          triples.transact([{ op: "retract", id: original.id }], {
            preconditions: [
              {
                _tag: "EntityState",
                entityId: raceId,
                tripleIds: observed.map((fact) => fact.id),
              },
            ],
          }),
        );

        yield* triples.assertBatch(
          ["a", "b", "c"].map((suffix) => ({
            entityId: EntityId.make(`page:${suffix}`),
            entityType: "Paged",
            attribute: ":page/name",
            value: { type: "string" as const, value: suffix },
          })),
        );
        const first = yield* triples.entityPage({ entityType: "Paged", limit: 2 });
        yield* triples.assert({
          entityId: EntityId.make("page:aa"),
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
      expect(
        (await responseJson<{ readonly entities: readonly unknown[] }>(schema)).entities,
      ).toHaveLength(2);

      const docs = await web.handler(new Request("http://triplex.test/api/rest/latest/docs"));
      expect(docs.status).toBe(200);
      expect(await docs.text()).toContain("api-reference-container");

      const openapi = await web.handler(
        new Request("http://triplex.test/api/rest/latest/openapi.json"),
      );
      expect(openapi.status).toBe(200);
      const latestOpenApi = await responseJson<OpenApiResponse>(openapi);
      expect(Object.keys(latestOpenApi.paths)).toContain("/api/rest/latest/employers");
      expect(latestOpenApi).toMatchObject({
        components: {
          schemas: {
            TriplexHttpError: {
              properties: { error: { $ref: "#/components/schemas/TriplexDiagnostic" } },
              required: ["error"],
            },
            TriplexDiagnostic: {
              required: ["code", "message", "retryable"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                retryable: { type: "boolean" },
                fix: { type: "string" },
                path: { type: "string" },
                details: { type: "object" },
              },
            },
          },
        },
      });
      expect(latestOpenApi.paths["/api/rest/latest/employers"].post).toBeDefined();

      const historicalOpenApi = await web.handler(
        new Request(`http://triplex.test/api/rest/${web.snapshotId()}/openapi.json`),
      );
      expect(historicalOpenApi.status).toBe(200);
      expect(
        (await responseJson<OpenApiResponse>(historicalOpenApi)).paths[
          `/api/rest/${web.snapshotId()}/employers`
        ]?.post,
      ).toBeUndefined();

      const invalid = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attributes: { name: "not-a-wire-alias" } }),
        }),
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.clone().json()).toMatchObject({
        error: {
          code: "http.invalid-request",
          path: expect.any(String),
          fix: expect.any(String),
          retryable: false,
        },
      });
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
      const employer = await responseJson<DocumentResponse>(created);
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
      expect((await responseJson<DocumentResponse>(replaced)).attributes).toEqual({
        ":employer/name": "Acme, Inc.",
      });

      const wrongCollection = await web.handler(
        new Request(
          `http://triplex.test/api/rest/latest/employments/${encodeURIComponent(employer.id)}`,
        ),
      );
      expect(wrongCollection.status).toBe(404);
      expect(await wrongCollection.json()).toMatchObject({
        error: {
          code: "http.entity-not-found",
          fix: expect.any(String),
          retryable: false,
        },
      });

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
      expect(await invalidReference.json()).toMatchObject({
        error: {
          code: "constraint.violation",
          path: expect.any(String),
          fix: expect.any(String),
          retryable: false,
        },
      });

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
      const secondEmployerBody = await responseJson<DocumentResponse>(secondEmployer);

      const page = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employers?limit=1"),
      );
      expect(page.status).toBe(200);
      const pageBody = await responseJson<ListResponse>(page);
      expect(pageBody.items).toHaveLength(1);
      expect(pageBody.nextCursor).toEqual(expect.any(String));

      const forgedCursor = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employers?cursor=forged"),
      );
      expect(forgedCursor.status).toBe(400);
      expect((await responseJson<ErrorResponse>(forgedCursor)).error.code).toBe(
        "http.invalid-request",
      );

      const nextSnapshot = await web.advanceLive();
      expect(nextSnapshot).not.toBe(web.snapshotId());
      const movedContinuation = await web.handler(
        new Request(
          `http://triplex.test/api/rest/latest/employers?limit=1&cursor=${encodeURIComponent(pageBody.nextCursor)}`,
        ),
      );
      expect(movedContinuation.status).toBe(409);
      expect(await movedContinuation.json()).toMatchObject({
        error: {
          code: "http.cursor-conflict",
          fix: expect.any(String),
          retryable: false,
        },
      });

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
      const disposableBody = await responseJson<DocumentResponse>(disposable);
      const deleted = await web.handler(
        new Request(
          `http://triplex.test/api/rest/latest/employers/${encodeURIComponent(disposableBody.id)}`,
          { method: "DELETE" },
        ),
      );
      expect(deleted.status).toBe(204);
      expect(await web.history(disposableBody.id)).not.toHaveLength(0);

      await web.assertFact({
        entityId: EntityId.make("employer:corrupt"),
        entityType: "Employer",
        attribute: ":employer/name",
        value: { type: "number", value: 42 },
      });
      const corrupt = await web.handler(
        new Request("http://triplex.test/api/rest/latest/employers/employer%3Acorrupt"),
      );
      expect(corrupt.status).toBe(409);
      expect((await responseJson<ErrorResponse>(corrupt)).error.code).toBe(
        "http.data-shape-conflict",
      );

      await web.assertFact({
        entityId: EntityId.make(secondEmployerBody.id),
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
      expect((await responseJson<ErrorResponse>(scheduledReplace)).error.code).toBe(
        "http.scheduled-facts",
      );

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
