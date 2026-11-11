import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import { Triples } from "../../src/store/Triples.js";
import { number, string } from "../../src/Value.js";
import * as Attribute from "../../src/config/Attribute.js";
import * as ConfigStore from "../../src/config/ConfigStore.js";
import * as EntityType from "../../src/config/EntityType.js";
import * as EntityValidation from "../../src/config/EntityValidation.js";
import * as TypeExpr from "../../src/config/TypeExpr.js";

const ConfigLayer = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));
const TriplexLayer = EntityValidation.layer.pipe(Layer.provideMerge(ConfigLayer));

const employeeType = (minimumAge?: number) =>
  TypeExpr.struct({
    ":employee/name": TypeExpr.required(TypeExpr.text),
    ":employee/age": TypeExpr.required(
      minimumAge === undefined
        ? TypeExpr.integer
        : TypeExpr.constrained(TypeExpr.integer, [TypeExpr.min(minimumAge)]),
    ),
  });

describe("entity validation observations", () => {
  it.effect("materializes first-class graph constraint violations", () =>
    Effect.gen(function* () {
      const OrganizationName = Attribute.text(":organization/name");
      const PersonName = Attribute.text(":person/name");
      const MembershipOrganization = Attribute.ref(":membership/organization", {
        entityType: "Organization",
      });
      const MembershipNote = Attribute.text(":membership/note");
      const Organization = EntityType.make("Organization", {
        name: Attribute.use(OrganizationName, { required: true, unique: true }),
      });
      const Person = EntityType.make("Person", {
        name: Attribute.use(PersonName, { required: true }),
      });
      const Membership = EntityType.make("Membership", {
        organization: Attribute.use(MembershipOrganization, { required: true }),
        note: Attribute.use(MembershipNote),
      });

      const config = yield* ConfigStore.ConfigStore;
      const validation = yield* EntityValidation.EntityValidation;
      const triples = yield* Triples;
      const nodes = [
        ...(yield* Organization.nodes),
        ...(yield* Person.nodes),
        ...(yield* Membership.nodes),
      ];
      const objects = [
        ...new Map(nodes.map((node) => [`${node.kind}\u0000${node.key}`, node])).values(),
      ];
      yield* config.commit({ label: "graph constraints", objects, ref: "live" });

      yield* triples.assertBatch([
        {
          entityId: "organization:acme",
          entityType: Organization.entityType,
          attribute: Organization.name.key,
          value: Organization.name.assertion("Shared name").value,
        },
        {
          entityId: "organization:globex",
          entityType: Organization.entityType,
          attribute: Organization.name.key,
          value: Organization.name.assertion("Shared name").value,
        },
        {
          entityId: "person:alice",
          entityType: Person.entityType,
          attribute: Person.name.key,
          value: Person.name.assertion("Alice").value,
        },
        {
          entityId: "membership:wrong-and-many",
          entityType: Membership.entityType,
          attribute: Membership.note.key,
          value: Membership.note.assertion("discover the entity").value,
        },
        {
          entityId: "membership:wrong-and-many",
          entityType: Membership.entityType,
          attribute: Membership.organization.key,
          value: Membership.organization.assertion("person:alice").value,
        },
        {
          entityId: "membership:wrong-and-many",
          entityType: Membership.entityType,
          attribute: Membership.organization.key,
          value: Membership.organization.assertion("organization:acme").value,
        },
        {
          entityId: "membership:missing",
          entityType: Membership.entityType,
          attribute: Membership.note.key,
          value: Membership.note.assertion("no organization").value,
        },
      ]);

      const run = yield* validation.revalidate({ ref: "live" });
      const graphViolations = run.results
        .flatMap((result) => result.violations)
        .filter((violation) => violation.code !== "schema")
        .map(({ subject, code }) => ({ subject, code }));
      expect(graphViolations).toEqual([
        { subject: "membership:missing", code: "required" },
        { subject: "membership:wrong-and-many", code: "cardinality" },
        { subject: "membership:wrong-and-many", code: "reference-target" },
        { subject: "organization:acme", code: "unique" },
        { subject: "organization:globex", code: "unique" },
      ]);

      const stored = yield* validation.violations();
      expect(
        stored
          .filter(({ code }) => code !== "schema")
          .map(({ subject, code }) => ({
            subject,
            code,
          })),
      ).toEqual(graphViolations);
      const datalog = yield* triples.query(EntityValidation.violationsQuery());
      expect(datalog.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            "?subject": "membership:wrong-and-many",
            "?code": "reference-target",
          }),
          expect.objectContaining({
            "?subject": "organization:acme",
            "?code": "unique",
          }),
        ]),
      );
    }).pipe(Effect.provide(TriplexLayer)),
  );

  it.effect("preserves a list containing one fact value", () =>
    Effect.gen(function* () {
      const config = yield* ConfigStore.ConfigStore;
      const validation = yield* EntityValidation.EntityValidation;
      const triples = yield* Triples;
      const schema = yield* EntityValidation.define(
        "Team",
        TypeExpr.struct({
          ":team/member": TypeExpr.required(TypeExpr.list(TypeExpr.ref("Employee"))),
        }),
      );
      yield* config.commit({ label: "team schema", objects: [schema], ref: "live" });
      yield* triples.assert({
        entityId: "team:one",
        entityType: "Team",
        attribute: ":team/member",
        value: { type: "ref", value: "employee:alice" },
      });

      const run = yield* validation.revalidate({ ref: "live" });
      expect(run.results).toEqual([
        expect.objectContaining({
          subject: "team:one",
          valid: true,
          state: { ":team/member": ["employee:alice"] },
        }),
      ]);
    }).pipe(Effect.provide(TriplexLayer)),
  );

  it.effect("revalidates after schema changes and keeps queryable error history", () =>
    Effect.gen(function* () {
      const config = yield* ConfigStore.ConfigStore;
      const validation = yield* EntityValidation.EntityValidation;
      const triples = yield* Triples;

      const schemaV1 = yield* EntityValidation.define("Employee", employeeType());
      yield* config.commit({ label: "employee schema v1", objects: [schemaV1], ref: "live" });

      const facts = yield* triples.assertBatch([
        {
          entityId: "employee:alice",
          entityType: "Employee",
          attribute: ":employee/name",
          value: string("Alice"),
        },
        {
          entityId: "employee:alice",
          entityType: "Employee",
          attribute: ":employee/age",
          value: number(20),
        },
        {
          entityId: "employee:bob",
          entityType: "Employee",
          attribute: ":employee/name",
          value: string("Bob"),
        },
        {
          entityId: "employee:bob",
          entityType: "Employee",
          attribute: ":employee/age",
          value: string("not-a-number"),
        },
      ]);

      expect(yield* validation.currentInvalid("live")).toEqual(
        expect.objectContaining({ status: "unvalidated", invalid: [] }),
      );

      const firstRun = yield* validation.revalidate({ ref: "live" });
      expect(firstRun.results).toHaveLength(2);
      expect(firstRun.results.find((result) => result.subject === "employee:alice")?.valid).toBe(
        true,
      );
      expect(yield* validation.currentInvalid("live")).toEqual(
        expect.objectContaining({
          status: "current",
          sourcePosition: firstRun.sourcePosition,
          invalid: [expect.objectContaining({ subject: "employee:bob" })],
        }),
      );

      const bobMessages = yield* validation.violations({ subject: "employee:bob" });
      expect(bobMessages).toEqual([
        expect.objectContaining({
          subject: "employee:bob",
          path: '$[":employee/age"]',
          message: expect.stringContaining("number"),
        }),
      ]);

      // A deployed definition change invalidates Alice even though her facts
      // did not change. Revalidation creates new immutable observations and
      // atomically moves the `live` heads to them.
      const schemaV2 = yield* EntityValidation.define("Employee", employeeType(21));
      yield* config.commit({ label: "employee schema v2", objects: [schemaV2], ref: "live" });
      expect(yield* validation.currentInvalid("live")).toEqual(
        expect.objectContaining({
          status: "stale",
          invalid: [expect.objectContaining({ subject: "employee:bob" })],
        }),
      );
      const secondRun = yield* validation.revalidate({ ref: "live" });
      expect(secondRun.id).not.toBe(firstRun.id);
      expect(
        (yield* validation.currentInvalid("live")).invalid.map((row) => row.subject).sort(),
      ).toEqual(["employee:alice", "employee:bob"]);

      const aliceAge = facts.find(
        (fact) => fact.entityId === "employee:alice" && fact.attribute === ":employee/age",
      )!;
      const bobAge = facts.find(
        (fact) => fact.entityId === "employee:bob" && fact.attribute === ":employee/age",
      )!;
      yield* triples.transact([
        { op: "retract", id: aliceAge.id },
        { op: "retract", id: bobAge.id },
        {
          op: "assert",
          entityId: "employee:alice",
          entityType: "Employee",
          attribute: ":employee/age",
          value: number(25),
        },
        {
          op: "assert",
          entityId: "employee:bob",
          entityType: "Employee",
          attribute: ":employee/age",
          value: number(30),
        },
      ]);

      expect(yield* validation.currentInvalid("live")).toEqual(
        expect.objectContaining({ status: "stale" }),
      );

      const thirdRun = yield* validation.revalidate({ ref: "live" });
      expect(thirdRun.transaction).toBeDefined();
      expect(yield* triples.transaction(thirdRun.transaction!.txId)).toEqual(
        expect.objectContaining({
          actor: "triplex/entity-validation",
          configSnapshot: thirdRun.snapshotId,
          changes: expect.arrayContaining([
            expect.objectContaining({
              op: "assert",
              attribute: EntityValidation.System.attribute.result,
            }),
          ]),
        }),
      );
      expect(
        thirdRun.results.map(({ subject, valid, state }) => ({ subject, valid, state })),
      ).toEqual([
        {
          subject: "employee:alice",
          valid: true,
          state: { ":employee/age": 25, ":employee/name": "Alice" },
        },
        {
          subject: "employee:bob",
          valid: true,
          state: { ":employee/age": 30, ":employee/name": "Bob" },
        },
      ]);
      expect(
        (yield* triples.match({ entityType: EntityValidation.System.entityType.head }))
          .filter((triple) => triple.attribute === EntityValidation.System.attribute.result)
          .map((triple) => triple.value)
          .sort((a, b) => a.value.localeCompare(b.value)),
      ).toEqual(
        thirdRun.results
          .map((result) => ({
            type: "ref" as const,
            value: EntityValidation.entityId.result(result.id),
          }))
          .sort((a, b) => a.value.localeCompare(b.value)),
      );
      const currentInvalid = yield* validation.currentInvalid("live");
      expect(currentInvalid).toEqual(expect.objectContaining({ status: "current", invalid: [] }));
      const repeatedRun = yield* validation.revalidate({ ref: "live" });
      expect(repeatedRun.id).toBe(thirdRun.id);
      expect(repeatedRun.transaction).toBeUndefined();
      expect([...(yield* validation.everInvalid())].sort()).toEqual([
        "employee:alice",
        "employee:bob",
      ]);

      // Violations are ordinary first-class entities, so applications can
      // compose richer Datalog joins than the convenience methods expose.
      const historicalAliceErrors = yield* triples.query(
        EntityValidation.violationsQuery({ subject: "employee:alice" }),
      );
      expect(historicalAliceErrors.results).toEqual([
        expect.objectContaining({
          "?subject": "employee:alice",
          "?message": expect.stringContaining("greater than or equal to 21"),
        }),
      ]);
    }).pipe(Effect.provide(TriplexLayer)),
  );
});
