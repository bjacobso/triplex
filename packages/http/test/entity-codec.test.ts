import { EntityId, KvTriples, Triples, type Triple } from "@triplex-build/triplex";
import {
  Attribute,
  EntityType,
  InMemoryConfigStore,
  TypeExpr,
} from "@triplex-build/triplex/config";
import { Effect, Option } from "effect";
import { expect, it } from "vitest";
import { compile } from "../src/ConfigApi.js";
import { encodeEntity } from "../src/EntityCodec.js";

const Person = EntityType.make("Person", {
  name: Attribute.text(":person/name").required(),
  tags: Attribute.text(":person/tag").many(),
  secret: Attribute.sensitive(Attribute.text(":person/secret")),
  ref: Attribute.ref(":person/ref", { entityType: "Person" }),
  instant: Attribute.instant(":person/instant"),
});
const setup = Effect.gen(function* () {
  const snapshot = (yield* InMemoryConfigStore.commit(InMemoryConfigStore.empty(), {
    label: "v1",
    objects: yield* Person.nodes,
  })).snapshot;
  const descriptor = (yield* compile(snapshot)).entities[0]!;
  const db = yield* Triples;
  yield* db.transact(Person.assert(EntityId.make("person:a"), { name: "Ada" }));
  return { descriptor, facts: yield* db.entity(EntityId.make("person:a")) };
}).pipe(Effect.provide(KvTriples.layer));

const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));
const stored = (base: Triple, attribute: string, value: Triple["value"]): Triple => ({
  ...base,
  attribute: attribute as Triple["attribute"],
  value,
});

it("HTTP deduplicates scalar values; core counts facts before decoding", async () => {
  const { descriptor, facts } = await Effect.runPromise(setup);
  const duplicate = [...facts, facts[0]!];
  expect((await Effect.runPromise(encodeEntity(descriptor, duplicate))).attributes).toEqual({
    ":person/name": "Ada",
  });
  expect(await failure(Person.decode(duplicate))).toMatchObject({ reason: "cardinality" });
  const ambiguous = [
    ...facts,
    stored(facts[0]!, ":person/name", { type: "string", value: "Other" }),
  ];
  expect(await failure(encodeEntity(descriptor, ambiguous))).toMatchObject({
    message: "A scalar attribute has multiple distinct live values",
  });
  expect(await failure(Person.decode(ambiguous))).toMatchObject({ reason: "cardinality" });
});

it("both reject missing required values, with different error envelopes", async () => {
  const { descriptor, facts } = await Effect.runPromise(setup);
  const missing = [stored(facts[0]!, ":person/tag", { type: "string", value: "tag" })];
  expect(await failure(encodeEntity(descriptor, missing))).toMatchObject({
    code: "http.data-shape-conflict",
    path: '$.attributes[":person/name"]',
    message: "A required attribute is missing",
  });
  expect(await failure(Person.decode(missing))).toMatchObject({
    reason: "required",
    alias: "name",
    message: "A required attribute is missing",
  });
  expect(await failure(encodeEntity(descriptor, []))).toMatchObject({
    path: "$.type",
    message: "Entity is not a Person",
  });
  expect(await failure(Person.decode([]))).toMatchObject({ reason: "required" });
});

it("HTTP omits absent attributes; core includes undefined scalars and empty arrays", async () => {
  const { descriptor, facts } = await Effect.runPromise(setup);
  expect(JSON.stringify(await Effect.runPromise(encodeEntity(descriptor, facts)))).toBe(
    '{"id":"person:a","type":"Person","attributes":{":person/name":"Ada"}}',
  );
  expect(await Effect.runPromise(Person.decode(facts))).toEqual({
    name: "Ada",
    tags: [],
    secret: undefined,
    ref: undefined,
    instant: undefined,
  });
});

it("both ignore unknown attributes by default; core can reject them", async () => {
  const { descriptor, facts } = await Effect.runPromise(setup);
  const unknown = [...facts, stored(facts[0]!, ":person/unknown", { type: "number", value: 2 })];
  expect(await Effect.runPromise(encodeEntity(descriptor, unknown))).toEqual(
    await Effect.runPromise(encodeEntity(descriptor, facts)),
  );
  expect(await Effect.runPromise(Person.decode(unknown))).toEqual(
    await Effect.runPromise(Person.decode(facts)),
  );
  expect(await failure(Person.decode(unknown, { unknownAttributes: "reject" }))).toMatchObject({
    reason: "unknownAttribute",
  });
});

it("HTTP permits untyped facts and mixed subjects; core requires one subject and every fact typed", async () => {
  const { descriptor, facts } = await Effect.runPromise(setup);
  for (const extra of [
    {
      ...stored(facts[0]!, ":person/unknown", { type: "string", value: "x" }),
      entityType: Option.none(),
    },
    {
      ...stored(facts[0]!, ":person/unknown", { type: "string", value: "x" }),
      entityId: EntityId.make("person:b"),
    },
  ]) {
    expect(await Effect.runPromise(encodeEntity(descriptor, [...facts, extra]))).toEqual(
      await Effect.runPromise(encodeEntity(descriptor, facts)),
    );
    expect(await failure(Person.decode([...facts, extra]))).toMatchObject({
      reason: Option.isNone(extra.entityType) ? "entityType" : "entity",
    });
  }
  const foreign = [...facts, { ...facts[0]!, entityType: Option.some("Other") }];
  expect(await failure(encodeEntity(descriptor, foreign))).toMatchObject({
    path: "$.type",
    message: "Mixed entity-type membership is not supported",
  });
  expect(await failure(Person.decode(foreign))).toMatchObject({ reason: "entityType" });
});

it("both redact sealed values, including after sensitivity changes; HTTP deduplicates sealed scalars", async () => {
  const { descriptor, facts } = await Effect.runPromise(setup);
  const sealed: Triple["value"] = {
    type: "sealed",
    valueType: "string",
    keyId: "test",
    ciphertext: "opaque",
    blind: "token",
  };
  for (const key of [":person/name", ":person/secret"]) {
    const input =
      key === ":person/name"
        ? [stored(facts[0]!, key, sealed)]
        : [...facts, stored(facts[0]!, key, sealed)];
    const http = await Effect.runPromise(encodeEntity(descriptor, input));
    const core = await Effect.runPromise(Person.decode(input));
    expect(http.attributes[key]).toEqual({ $sealed: { valueType: "string", keyId: "test" } });
    expect(core[key === ":person/name" ? "name" : "secret"]).toEqual(http.attributes[key]);
    expect(await Effect.runPromise(encodeEntity(descriptor, [...input, input.at(-1)!]))).toEqual(
      http,
    );
    expect(await failure(Person.decode([...input, input.at(-1)!]))).toMatchObject({
      reason: "cardinality",
    });
  }
  for (const value of [
    { type: "string", value: "plaintext" },
    { ...sealed, valueType: "number" },
  ] as const) {
    const input = [...facts, stored(facts[0]!, ":person/secret", value)];
    expect(await failure(encodeEntity(descriptor, input))).toMatchObject({
      path: '$.attributes[":person/secret"]',
    });
    expect(await failure(Person.decode(input))).toMatchObject({ reason: "value" });
  }
});

it("value encoding and many-value ordering agree after mapping aliases to keywords", async () => {
  const { descriptor, facts } = await Effect.runPromise(setup);
  const input = [
    ...facts,
    stored(facts[0]!, ":person/instant", { type: "datetime", value: 1234 }),
    stored(facts[0]!, ":person/ref", { type: "ref", value: EntityId.make("person:b") }),
    ...["z", "a", "z"].map((value) => stored(facts[0]!, ":person/tag", { type: "string", value })),
  ];
  const http = await Effect.runPromise(encodeEntity(descriptor, input));
  const core = await Effect.runPromise(Person.decode(input));
  expect(http.attributes).toEqual({
    ":person/name": core.name,
    ":person/instant": core.instant,
    ":person/ref": core.ref,
    ":person/tag": core.tags,
  });
  expect(core.tags).toEqual(["a", "z"]);
  for (const value of [
    { type: "string", value: "wrong storage" },
    { type: "datetime", value: 1.5 },
  ] as const) {
    const invalid = [...facts, stored(facts[0]!, ":person/instant", value)];
    expect(await failure(encodeEntity(descriptor, invalid))).toMatchObject({
      path: '$.attributes[":person/instant"]',
    });
    expect(await failure(Person.decode(invalid))).toMatchObject({ reason: "value" });
  }
});

it("preserves serialized documents and conflict diagnostics across the shared decoder migration", async () => {
  const { descriptor, facts } = await Effect.runPromise(setup);
  const name = facts[0]!;
  const outcomes: Record<string, string> = {};
  const cases = [
    { label: "missing membership", facts: [] },
    {
      label: "missing required",
      facts: [stored(name, ":person/tag", { type: "string", value: "a" })],
    },
    {
      label: "unsealed sensitive",
      facts: [...facts, stored(name, ":person/secret", { type: "string", value: "private" })],
    },
    {
      label: "sealed storage mismatch",
      facts: [
        stored(name, ":person/name", {
          type: "sealed",
          valueType: "number",
          keyId: "key",
          ciphertext: "opaque",
        }),
      ],
    },
    {
      label: "storage mismatch",
      facts: [stored(name, ":person/name", { type: "number", value: 2 })],
    },
    {
      label: "schema mismatch",
      facts: [...facts, stored(name, ":person/instant", { type: "datetime", value: 1.5 })],
    },
    {
      label: "invalid ref",
      facts: [...facts, stored(name, ":person/ref", { type: "ref", value: "" as EntityId })],
    },
    { label: "duplicate scalar", facts: [...facts, name] },
    {
      label: "distinct scalars",
      facts: [...facts, stored(name, ":person/name", { type: "string", value: "Other" })],
    },
    { label: "mixed types", facts: [...facts, { ...name, entityType: Option.some("Other") }] },
    {
      label: "untyped declared fact",
      facts: [
        ...facts,
        {
          ...stored(name, ":person/tag", { type: "string", value: "a" }),
          entityType: Option.none(),
        },
      ],
    },
    {
      label: "foreign subject declared fact",
      facts: [
        ...facts,
        {
          ...stored(name, ":person/tag", { type: "string", value: "a" }),
          entityId: EntityId.make("person:b"),
        },
      ],
    },
    {
      label: "invalid duplicate ordering",
      facts: [...facts, stored(name, ":person/name", { type: "number", value: 2 })],
    },
    {
      label: "json",
      descriptor: {
        ...descriptor,
        attributes: [
          {
            ...descriptor.attributes.find((attribute) => attribute.key === ":person/name")!,
            storage: "json" as const,
            type: TypeExpr.struct({ n: TypeExpr.required(TypeExpr.integer) }),
          },
        ],
      },
      facts: [stored(name, ":person/name", { type: "json", value: { n: 2, extra: "kept" } })],
    },
    {
      label: "noncanonical json",
      descriptor: {
        ...descriptor,
        attributes: [
          {
            ...descriptor.attributes.find((attribute) => attribute.key === ":person/name")!,
            storage: "json" as const,
            type: TypeExpr.list(TypeExpr.any),
          },
        ],
      },
      facts: [stored(name, ":person/name", { type: "json", value: [undefined] })],
    },
  ];
  for (const item of cases) {
    const result = await Effect.runPromise(
      Effect.result(encodeEntity(item.descriptor ?? descriptor, item.facts)),
    );
    outcomes[item.label] = JSON.stringify(result);
  }
  expect(outcomes).toMatchSnapshot();
});
