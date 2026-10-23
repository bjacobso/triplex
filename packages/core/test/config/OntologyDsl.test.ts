import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { EntityId } from "../../src/Branded.js";
import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import { Triples } from "../../src/store/Triples.js";
import * as Attribute from "../../src/config/Attribute.js";
import * as ConfigStore from "../../src/config/ConfigStore.js";
import * as EntityType from "../../src/config/EntityType.js";
import * as EntityValidation from "../../src/config/EntityValidation.js";
import * as GraphConstraint from "../../src/config/GraphConstraint.js";

const EmployerName = Attribute.text(":employer/name");
const WorkerName = Attribute.text(":worker/name");

const Employer = EntityType.make("Employer", {
  attributes: {
    name: Attribute.use(EmployerName, { required: true }),
  },
});

const EmployerSummary = EntityType.make("EmployerSummary", {
  attributes: {
    name: Attribute.use(EmployerName, { required: false }),
  },
});

const Worker = EntityType.make("Worker", {
  attributes: {
    name: Attribute.use(WorkerName, { required: true }),
  },
});

const EmploymentEmployer = Attribute.ref(":employment/employer", Employer);
const EmploymentWorker = Attribute.ref(":employment/worker", Worker);

const Employment = EntityType.make("Employment", {
  attributes: {
    employer: Attribute.use(EmploymentEmployer, { required: true }),
    worker: Attribute.use(EmploymentWorker, { required: true }),
  },
});

describe("ontology DSL", () => {
  it.effect("separates global attribute identity from entity-local usage", () =>
    Effect.gen(function* () {
      expect(Employer.name.key).toBe(":employer/name");
      expect(Employer.name.required).toBe(true);
      expect(EmployerSummary.name.key).toBe(Employer.name.key);
      expect(EmployerSummary.name.required).toBe(false);
      expect(Employer.schema.fields[":employer/name"]?.optional).toBe(false);
      expect(EmployerSummary.schema.fields[":employer/name"]?.optional).toBe(true);

      const employerNameNode = yield* EmployerName.node;
      const sharedNameNode = yield* EmployerSummary.name.definition.node;
      expect(sharedNameNode.cid).toBe(employerNameNode.cid);

      const employerNode = yield* Employer.node;
      expect(employerNode.refs).toEqual([
        {
          rel: "uses-attribute",
          kind: Attribute.KIND,
          key: ":employer/name",
        },
      ]);
      expect(Employer.constraints.map(({ rule }) => rule._tag)).toEqual([
        "Required",
        "Cardinality",
      ]);
      expect(employerNode.children).toHaveLength(2);
      expect(employerNode.children.every(({ node }) => node.kind === GraphConstraint.KIND)).toBe(
        true,
      );
    }),
  );

  it("builds typed scalar and reference assertions", () => {
    expect(Employer.name.assertion("Acme", { validFrom: 1_700_000_000_000 })).toEqual({
      attribute: ":employer/name",
      value: { type: "string", value: "Acme" },
      validFrom: 1_700_000_000_000,
    });
    expect(Employment.employer.assertion("employer:acme")).toEqual({
      attribute: ":employment/employer",
      value: { type: "ref", value: "employer:acme" },
    });
    expect(Employment.employer.type).toEqual({
      _tag: "Ref",
      v: 1,
      kind: "Employer",
    });
  });

  it("carries a half-open valid-time interval on assertions", () => {
    expect(Employer.name.assertion("Acme", { validFrom: 10, validTo: 20 })).toEqual({
      attribute: ":employer/name",
      value: { type: "string", value: "Acme" },
      validFrom: 10,
      validTo: 20,
    });
    expect(() => Employer.name.assertion("Acme", { validTo: Number.NaN })).toThrow(/validTo/);
    expect(() => Employer.name.assertion("Acme", { validFrom: 20, validTo: 20 })).toThrow(
      /after validFrom/,
    );
  });

  it("builds typed assert operations for a whole entity", () => {
    const Site = EntityType.make("Site", {
      attributes: { name: Attribute.use(Attribute.text(":site/name"), { required: true }) },
    });
    const Crew = EntityType.make("Crew", {
      attributes: {
        name: Attribute.use(Attribute.text(":crew/name"), { required: true }),
        sites: Attribute.use(Attribute.ref(":crew/site", Site), { cardinality: "many" }),
        size: Attribute.use(Attribute.integer(":crew/size")),
      },
    });
    const crew = EntityId.make("crew:night");
    const harbor = EntityId.make("site:harbor");
    const pier = EntityId.make("site:pier");

    // Declaration order, one operation per many-value, and `undefined` skipped.
    expect(
      Crew.assert(
        crew,
        { size: 4, sites: [harbor, pier], name: "Night", ...{ size: undefined } },
        { validFrom: 10, validTo: 20 },
      ),
    ).toEqual([
      {
        op: "assert",
        entityId: crew,
        entityType: "Crew",
        attribute: ":crew/name",
        value: { type: "string", value: "Night" },
        validFrom: 10,
        validTo: 20,
      },
      ...[harbor, pier].map((site) => ({
        op: "assert",
        entityId: crew,
        entityType: "Crew",
        attribute: ":crew/site",
        value: { type: "ref", value: site },
        validFrom: 10,
        validTo: 20,
      })),
    ]);
    expect(Crew.assert(crew, { sites: [] })).toEqual([]);
    expect(Crew.assert(crew, { size: 0 })).toEqual([
      expect.objectContaining({ attribute: ":crew/size", value: { type: "number", value: 0 } }),
    ]);

    const untyped = Crew.assert as (id: EntityId, values: object) => unknown;
    expect(() => untyped(crew, { title: "Night" })).toThrow(/no attribute alias title/);
    expect(() => untyped(crew, { sites: harbor })).toThrow(/cardinality-many; pass an array/);
    expect(() => untyped(crew, { name: ["Night"] })).toThrow(/cardinality-one; pass a single/);
    expect(() => Crew.assert(crew, { name: "Night" }, { validFrom: 2, validTo: 1 })).toThrow(
      /after validFrom/,
    );
    for (const alias of ["assert", "where", "not"]) {
      expect(() =>
        EntityType.make("Clash", { [alias]: Attribute.text(`:clash/${alias}`) }),
      ).toThrow(/reserved/);
    }
  });

  it.effect("pins a write to one release and enforces that release's constraints", () =>
    Effect.gen(function* () {
      const triples = yield* Triples;
      const config = yield* ConfigStore.ConfigStore;
      const objects = yield* Effect.all([Employer.nodes, Worker.nodes, Employment.nodes]);
      const release = yield* config.commit({
        label: "employment v1",
        objects: objects.flat(),
        ref: "live",
      });
      const pinned = yield* GraphConstraint.pinned(release.snapshot);
      expect(pinned).toEqual({
        configSnapshot: release.snapshot.id,
        enforce: GraphConstraint.enforcement(yield* GraphConstraint.collect(release.snapshot.root)),
      });

      const acme = EntityId.make("employer:acme");
      const ada = EntityId.make("worker:ada");
      const employment = EntityId.make("employment:ada-acme");
      yield* triples.transact(
        [...Employer.assert(acme, { name: "Acme" }), ...Worker.assert(ada, { name: "Ada" })],
        { commandId: "onboard", ...pinned },
      );

      const missingWorker = yield* triples
        .transact(Employment.assert(employment, { employer: acme }), pinned)
        .pipe(Effect.flip);
      expect(missingWorker._tag).toBe("ConstraintViolationError");

      yield* triples.transact(Employment.assert(employment, { employer: acme, worker: ada }), {
        commandId: "hire",
        ...pinned,
      });
      const receipt = yield* triples.transactionByCommand("hire");
      expect(receipt?.configSnapshot).toBe(release.snapshot.id);
    }).pipe(Effect.provide(ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer)))),
  );

  it.effect("declares uses with attribute modifiers and bare definitions", () =>
    Effect.gen(function* () {
      const Name = Attribute.text(":employer/name");
      expect(Name.required()).toEqual(Attribute.use(Name, { required: true }));
      expect(Name.required({ unique: true })).toEqual(
        Attribute.use(Name, { required: true, unique: true }),
      );
      expect(Name.many({ required: true })).toEqual(
        Attribute.use(Name, { required: true, cardinality: "many" }),
      );
      expect(Name.unique()).toEqual(Attribute.use(Name, { unique: true }));

      // The concise form compiles to exactly the same configuration graph.
      const Concise = EntityType.make("Employment", {
        employer: EmploymentEmployer.required(),
        worker: EmploymentWorker.required(),
      });
      expect((yield* Concise.node).cid).toBe((yield* Employment.node).cid);
      expect(Concise.constraints.map(({ rule }) => rule)).toEqual(
        Employment.constraints.map(({ rule }) => rule),
      );

      const Bare = EntityType.make("EmployerSummary", { name: EmployerName });
      expect((yield* Bare.node).cid).toBe((yield* EmployerSummary.node).cid);
      expect(Bare.name.required).toBe(false);
      expect(Bare.name.cardinality).toBe("one");

      expect(() =>
        EntityType.make("Broken", { name: "text" } as unknown as Record<string, never>),
      ).toThrow(/must be an attribute or its use/);
    }),
  );

  it("builds Datalog patterns by alias", () => {
    const Site = EntityType.make("Site", { name: Attribute.text(":site/name").required() });
    const Crew = EntityType.make("Crew", {
      sites: Attribute.ref(":crew/site", Site).many(),
      size: Attribute.integer(":crew/size"),
      night: Attribute.boolean(":crew/night"),
      formed: Attribute.instant(":crew/formed"),
    });
    const harbor = EntityId.make("site:harbor");

    expect(Crew.where("?crew", { night: true, sites: "?site", size: 4 })).toEqual([
      ["?crew", ":crew/site", "?site"],
      ["?crew", ":crew/size", 4],
      ["?crew", ":crew/night", true],
    ]);
    expect(Crew.where(EntityId.make("crew:night"), { sites: harbor })).toEqual([
      ["crew:night", ":crew/site", { type: "ref", value: "site:harbor" }],
    ]);
    expect(Crew.not("?crew", { sites: "?site", night: false })).toEqual([
      "not",
      ["?crew", ":crew/site", "?site"],
      ["?crew", ":crew/night", false],
    ]);

    const untyped = Crew.where as (entity: string, patterns: object) => unknown;
    expect(() => untyped("?crew", { title: "?title" })).toThrow(/no attribute alias title/);
    expect(() => Crew.where("?crew", { formed: 0 })).toThrow(/datetime values/);
    expect(() => Crew.not("?crew", {})).toThrow(/between one and nine/);
  });

  it.effect("answers queries written with entity patterns", () =>
    Effect.gen(function* () {
      const triples = yield* Triples;
      const acme = EntityId.make("employer:acme");
      const ada = EntityId.make("worker:ada");
      const grace = EntityId.make("worker:grace");
      yield* triples.transact([
        ...Employer.assert(acme, { name: "Acme" }),
        ...Worker.assert(ada, { name: "Ada" }),
        ...Worker.assert(grace, { name: "Grace" }),
        ...Employment.assert(EntityId.make("employment:ada"), { employer: acme, worker: ada }),
      ]);

      const unemployed = yield* triples.queryAll({
        find: ["?name"],
        where: [
          ...Worker.where("?worker", { name: "?name" }),
          Employment.not("?employment", { worker: "?worker" }),
        ],
      });
      expect(unemployed.results).toEqual([{ "?name": "Grace" }]);

      const employees = yield* triples.queryAll({
        find: ["?name"],
        where: [
          ...Employment.where("?employment", { employer: acme, worker: "?worker" }),
          ...Worker.where("?worker", { name: "?name" }),
        ],
      });
      expect(employees.results).toEqual([{ "?name": "Ada" }]);
    }).pipe(Effect.provide(KvTriples.layer)),
  );

  it.effect("makes reference targets explicit in the configuration graph", () =>
    Effect.gen(function* () {
      const node = yield* EmploymentEmployer.node;
      expect(node.refs).toEqual([
        {
          rel: "references-entity-type",
          kind: "entity-schema",
          key: "Employer",
        },
      ]);
    }),
  );

  it.effect("commits the typed graph and validates ordinary facts from it", () => {
    const ConfigLayer = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));
    const AppLayer = EntityValidation.layer.pipe(Layer.provideMerge(ConfigLayer));
    return Effect.gen(function* () {
      const triples = yield* Triples;
      const config = yield* ConfigStore.ConfigStore;
      const validation = yield* EntityValidation.EntityValidation;

      yield* config.commit({
        label: "ontology v1",
        objects: yield* Employer.nodes,
        ref: "live",
      });
      yield* triples.transact([
        {
          op: "assert",
          entityId: "employer:acme",
          entityType: Employer.entityType,
          attribute: Employer.name.key,
          value: Employer.name.assertion("Acme").value,
        },
      ]);

      const run = yield* validation.revalidate({ ref: "live" });
      expect(run.results).toEqual([
        expect.objectContaining({
          entityType: "Employer",
          subject: "employer:acme",
          valid: true,
          state: { ":employer/name": "Acme" },
        }),
      ]);
    }).pipe(Effect.provide(AppLayer));
  });

  it("rejects identities outside the public naming conventions", () => {
    expect(() => Attribute.text(":Employer/name")).toThrow(/lowercase namespaced keyword/);
    expect(() => EntityType.make("employer", { attributes: {} })).toThrow(/PascalCase/);
  });
});
