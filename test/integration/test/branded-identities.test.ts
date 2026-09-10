import { describe, expect, it } from "vitest";

import { Effect, Schema } from "effect";
import {
  EntityId,
  TransactionId,
  TripleId,
  type TripleInput,
  ref,
  string,
} from "@triplex-build/triplex";
import { Attribute, EntityType } from "@triplex-build/triplex/config";

describe("branded public identities", () => {
  it("requires decoded entity ids for assertions and references", () => {
    const person = EntityId.make("person:alice");
    const employer = EntityId.make("company:acme");
    const input: TripleInput = {
      entityId: person,
      attribute: ":person/employer",
      value: ref(employer),
    };

    expect(input.entityId).toBe("person:alice");

    const unbrandedEntity: TripleInput = {
      // @ts-expect-error Public writes do not accept an unvalidated entity id.
      entityId: "person:bob",
      attribute: ":person/name",
      value: string("Bob"),
    };
    expect(unbrandedEntity.entityId).toBe("person:bob");

    // @ts-expect-error Reference values also require a branded target id.
    ref("company:other");
  });

  it("round-trips branded triple and transaction identities through runtime schemas", async () => {
    const tripleId = TripleId.make("01AAAAAAAAAAAAAAAAAAAAAAAA");
    const transactionId = TransactionId.make("_tx/01BBBBBBBBBBBBBBBBBBBBBBBB");

    await expect(Effect.runPromise(Schema.decodeEffect(TripleId)(tripleId))).resolves.toBe(
      tripleId,
    );
    await expect(Effect.runPromise(TransactionId.decode(transactionId))).resolves.toBe(
      transactionId,
    );
    await expect(Effect.runPromise(TransactionId.decode("tx:invalid"))).rejects.toBeDefined();

    const asEntity: EntityId = transactionId;
    expect(asEntity).toBe(transactionId);
  });

  it("accepts EntityId values through ontology reference attributes", () => {
    const Employer = EntityType.make("Employer", { attributes: {} });
    const EmployerRef = Attribute.ref(":employment/employer", Employer);
    const assertion = Attribute.assertion(EmployerRef, EntityId.make("employer:acme"));

    expect(assertion.value).toEqual({ type: "ref", value: "employer:acme" });
    // @ts-expect-error Ontology references reject unvalidated external strings.
    Attribute.assertion(EmployerRef, "employer:other");
  });
});
