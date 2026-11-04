import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Layer, Option, Stream } from "effect";

import { EntityId } from "../../src/Branded.js";
import * as Attribute from "../../src/config/Attribute.js";
import * as EntityType from "../../src/config/EntityType.js";
import * as GraphConstraint from "../../src/config/GraphConstraint.js";
import * as Derivation from "../../src/derivation/Derivation.js";
import { evaluateOverlay } from "../../src/derivation/Overlay.js";
import { SensitiveQueryError, SensitiveValueError, WriteError } from "../../src/errors/index.js";
import { KvBackend, type KvBackendService } from "../../src/kv/kv/KvBackend.js";
import { makeTestKvBackend } from "../../src/kv/kv/InMemoryKvBackend.js";
import { KvTriplesLive } from "../../src/kv/layers/KvTriplesLive.js";
import { TripleStoreRuntimeLayer } from "../../src/store/TripleStoreRuntime.js";
import { Triples } from "../../src/store/Triples.js";
import { KeyProvider, Sensitive, Sensitivity, ValueCodec } from "../../src/sensitive/index.js";
import type { DatalogQuery } from "../../src/datalog/types.js";
import type { SealedValue, TripleValue } from "../../src/Value.js";

// I-9 style fixtures: identity numbers, birth dates and document numbers.
const Ssn = Attribute.sensitive(Attribute.text(":employee/ssn"));
const BirthDate = Attribute.sensitive(Attribute.date(":employee/birth-date"));
const Salary = Attribute.sensitive(Attribute.number(":employee/salary"));
const Name = Attribute.text(":employee/name");
const ApplicantSsn = Attribute.sensitive(Attribute.text(":applicant/ssn"));
const DocumentNumber = Attribute.sensitive(Attribute.text(":i9/document-number"));

const Employee = EntityType.make("Employee", {
  attributes: {
    ssn: Attribute.use(Ssn, { unique: true }),
    birthDate: Attribute.use(BirthDate),
    salary: Attribute.use(Salary),
    name: Attribute.use(Name, { required: true }),
  },
});

const DATABASE = "test/sensitive";
const PLANTED = "917-55-4321";
const id = EntityId.make;

const kvLayer = (backend: KvBackendService) =>
  KvTriplesLive.pipe(
    Layer.provide(TripleStoreRuntimeLayer),
    Layer.provide(Layer.succeed(KvBackend, backend)),
  );

const sensitiveLayer = (
  backend: KvBackendService,
  codec: Layer.Layer<ValueCodec.ValueCodec> = ValueCodec.aesGcm.pipe(
    Layer.provide(KeyProvider.test({ seed: "sensitive-test" })),
  ),
) =>
  Sensitive.layer({
    database: DATABASE,
    attributes: [Employee, ApplicantSsn, DocumentNumber],
  }).pipe(Layer.provide(codec), Layer.provide(kvLayer(backend)));

const run = <A, E>(
  effect: Effect.Effect<A, E, Triples | Sensitivity>,
  backend: KvBackendService = makeTestKvBackend(),
  codec?: Layer.Layer<ValueCodec.ValueCodec>,
) => Effect.runPromise(effect.pipe(Effect.provide(sensitiveLayer(backend, codec))));

const runExit = <A, E>(effect: Effect.Effect<A, E, Triples | Sensitivity>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(sensitiveLayer(makeTestKvBackend()))));

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  const failure = exit.cause.reasons.find(Cause.isFailReason);
  if (!failure) throw new Error(Cause.pretty(exit.cause));
  return failure.error;
};

const queryError = (exit: Exit.Exit<unknown, unknown>): SensitiveQueryError => {
  const error = failureOf(exit);
  expect(error).toBeInstanceOf(SensitiveQueryError);
  expect(JSON.stringify(error)).not.toContain(PLANTED);
  return error as SensitiveQueryError;
};

const seed = Effect.gen(function* () {
  const triples = yield* Triples;
  return yield* triples.transact(
    [
      {
        op: "assert",
        entityId: id("ee:1"),
        attribute: ":employee/name",
        value: { type: "string", value: "Ada" },
        entityType: "Employee",
      },
      {
        op: "assert",
        entityId: id("ee:1"),
        attribute: ":employee/ssn",
        value: { type: "string", value: PLANTED },
        entityType: "Employee",
      },
      {
        op: "assert",
        entityId: id("ee:1"),
        attribute: ":employee/birth-date",
        value: { type: "string", value: "1990-04-01" },
        entityType: "Employee",
      },
      {
        op: "assert",
        entityId: id("ee:1"),
        attribute: ":employee/salary",
        value: { type: "number", value: 123456 },
        entityType: "Employee",
      },
      {
        op: "assert",
        entityId: id("ee:2"),
        attribute: ":employee/name",
        value: { type: "string", value: "Grace" },
        entityType: "Employee",
      },
      {
        op: "assert",
        entityId: id("ee:2"),
        attribute: ":employee/ssn",
        value: { type: "string", value: "123-45-6789" },
        entityType: "Employee",
      },
      {
        op: "assert",
        entityId: id("ee:3"),
        attribute: ":employee/name",
        value: { type: "string", value: "Linus" },
        entityType: "Employee",
      },
      {
        op: "assert",
        entityId: id("app:1"),
        attribute: ":applicant/ssn",
        value: { type: "string", value: PLANTED },
      },
    ],
    { actor: "hr:1", commandId: "seed" },
  );
});

const allKvBytes = (backend: KvBackendService) =>
  backend
    .getRange({ start: new Uint8Array([0]), end: new Uint8Array([0xff, 0xff, 0xff, 0xff]) })
    .pipe(
      Stream.runCollect,
      Effect.map((entries) =>
        [...entries]
          .map(
            ([key, value]) =>
              Buffer.from(key).toString("latin1") + "\n" + Buffer.from(value).toString("latin1"),
          )
          .join("\n"),
      ),
    );

const plaintextForms = (plaintext: string): readonly string[] => [
  plaintext,
  JSON.stringify(plaintext),
  Buffer.from(JSON.stringify(plaintext)).toString("base64url"),
  Buffer.from(plaintext).toString("base64url"),
];

describe("sensitive attribute marking", () => {
  it("is part of the attribute's content identity without moving existing IDs", async () => {
    const plain = await Effect.runPromise(Attribute.text(":employee/ssn").node);
    const again = await Effect.runPromise(Attribute.text(":employee/ssn").node);
    const sealed = await Effect.runPromise(Ssn.node);
    expect(plain.cid).toBe(again.cid);
    expect(sealed.cid).not.toBe(plain.cid);
    expect(sealed.attrs).toMatchObject({ sensitive: true });
    expect(plain.attrs).not.toHaveProperty("sensitive");
    expect(Ssn.sensitive).toBe(true);
    expect(Employee.ssn.sensitive).toBe(true);
    expect(Employee.name.sensitive).toBe(false);
  });

  it("rejects reference attributes and derives a policy from release nodes", async () => {
    expect(() =>
      Attribute.sensitive(Attribute.ref(":employee/manager", { entityType: "Employee" })),
    ).toThrow(/cannot be sensitive/);
    const nodes = await Effect.runPromise(Employee.nodes);
    expect([...Sensitive.attributesFromNodes(nodes)]).toEqual([
      [":employee/birth-date", "string"],
      [":employee/salary", "number"],
      [":employee/ssn", "string"],
    ]);
    expect([...Sensitive.attributesOf([Employee, Name])].map(([key]) => key).sort()).toEqual([
      ":employee/birth-date",
      ":employee/salary",
      ":employee/ssn",
    ]);
  });
});

describe("AES-GCM codec", () => {
  const codec = Effect.gen(function* () {
    return yield* ValueCodec.ValueCodec;
  }).pipe(
    Effect.provide(ValueCodec.aesGcm.pipe(Layer.provide(KeyProvider.test({ seed: "codec-test" })))),
  );
  const context = {
    database: DATABASE,
    entityId: "ee:1",
    attribute: ":employee/ssn",
    valueType: "string" as const,
  };

  it("round-trips, uses fresh nonces, and blinds deterministically", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* codec;
        const value = { type: "string" as const, value: PLANTED };
        const first = yield* service.seal(context, value);
        const second = yield* service.seal(context, value);
        const sealed: SealedValue = { type: "sealed", valueType: "string", ...first };
        return {
          first,
          second,
          opened: yield* service.open(context, sealed),
          blind: yield* service.blind({ ...context, entityId: "" }, value),
        };
      }),
    );
    expect(result.first.ciphertext).not.toBe(result.second.ciphertext);
    expect(result.first.blind).toBe(result.second.blind);
    expect(result.first.blind).toBe(result.blind);
    expect(result.first.keyId).toBe("test:v1");
    expect(result.opened).toEqual({ type: "string", value: PLANTED });
    for (const form of plaintextForms(PLANTED)) {
      expect(result.first.ciphertext).not.toContain(form);
      expect(result.first.blind).not.toContain(form);
    }
  });

  it("binds the ciphertext to its entity and attribute", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const service = yield* codec;
        const sealed = yield* service.seal(context, { type: "string", value: PLANTED });
        return yield* service.open(
          { ...context, entityId: "ee:2" },
          { type: "sealed", valueType: "string", ...sealed },
        );
      }),
    );
    const error = failureOf(exit) as SensitiveValueError;
    expect(error.reason).toBe("integrity");
  });
});

describe("sealed Triples", () => {
  it("seals on write, returns sealed values from every read, and opens explicitly", async () => {
    const backend = makeTestKvBackend();
    const result = await run(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const committed = yield* seed;
        const entity = yield* triples.entity(id("ee:1"));
        const history = yield* triples.history(id("ee:1"));
        const transaction = yield* triples.transaction(committed.txId);
        const receipt = yield* triples.transactionByCommand("seed");
        const opened = yield* Sensitive.open(entity);
        const openedJournal = yield* Sensitive.open(transaction!);
        return { committed, entity, history, transaction, receipt, opened, openedJournal };
      }),
      backend,
    );

    const ssn = result.entity.find((triple) => triple.attribute === ":employee/ssn")!;
    expect(ssn.value.type).toBe("sealed");
    expect((ssn.value as SealedValue).valueType).toBe("string");
    expect(
      result.committed.triples.every(
        (t) => t.attribute === ":employee/name" || t.value.type === "sealed",
      ),
    ).toBe(true);
    expect(result.history.find((t) => t.attribute === ":employee/ssn")?.value.type).toBe("sealed");
    const change = result.transaction!.changes.find(
      (candidate) => candidate.attribute === ":employee/ssn" && candidate.entityId === "ee:1",
    );
    expect(change?.value?.type).toBe("sealed");
    expect(result.receipt?.txId).toBe(result.committed.txId);
    expect(result.opened.find((t) => t.attribute === ":employee/ssn")?.value).toEqual({
      type: "string",
      value: PLANTED,
    });
    expect(result.opened.find((t) => t.attribute === ":employee/salary")?.value).toEqual({
      type: "number",
      value: 123456,
    });
    expect(
      result.openedJournal.changes.find(
        (candidate) => candidate.attribute === ":employee/ssn" && candidate.entityId === "ee:1",
      )?.value,
    ).toEqual({ type: "string", value: PLANTED });
    expect(JSON.stringify(result.entity)).not.toContain(PLANTED);
    expect(JSON.stringify(result.transaction)).not.toContain(PLANTED);

    const raw = await Effect.runPromise(allKvBytes(backend));
    expect(raw).toContain("Ada");
    for (const form of plaintextForms(PLANTED)) expect(raw).not.toContain(form);
    for (const form of plaintextForms("1990-04-01")) expect(raw).not.toContain(form);
  });

  it("matches plaintext lookups through the blind index", async () => {
    const result = await run(
      Effect.gen(function* () {
        const triples = yield* Triples;
        yield* seed;
        const matched = yield* triples.match({
          attribute: ":employee/ssn",
          value: { type: "string", value: PLANTED },
        });
        const typeMismatch = yield* triples.match({
          attribute: ":employee/ssn",
          value: { type: "number", value: 917 },
        });
        return { matched, typeMismatch };
      }),
    );
    expect(result.matched.map((triple) => triple.entityId)).toEqual(["ee:1"]);
    expect(result.typeMismatch).toEqual([]);
  });

  it("rejects caller-supplied sealed values and mistyped sensitive values", async () => {
    const forged = await runExit(
      Effect.gen(function* () {
        const triples = yield* Triples;
        return yield* triples.transact([
          {
            op: "assert",
            entityId: id("ee:9"),
            attribute: ":employee/name",
            value: { type: "sealed", valueType: "string", keyId: "x", ciphertext: "y", blind: "z" },
          },
        ]);
      }),
    );
    const forgedError = failureOf(forged) as WriteError;
    expect(forgedError).toBeInstanceOf(WriteError);
    expect((forgedError.cause as SensitiveValueError).reason).toBe("sealed-input");

    const mistyped = await runExit(
      Effect.gen(function* () {
        const triples = yield* Triples;
        return yield* triples.assert({
          entityId: id("ee:9"),
          attribute: ":employee/ssn",
          value: { type: "number", value: 917554321 },
        });
      }),
    );
    const mistypedError = failureOf(mistyped) as WriteError;
    expect((mistypedError.cause as SensitiveValueError).reason).toBe("invalid-value");
    expect((mistypedError.cause as SensitiveValueError).attribute).toBe(":employee/ssn");
    expect(mistypedError.message).not.toContain("917554321");
  });

  it("enforces uniqueness on blind tokens", async () => {
    const constraints = [GraphConstraint.unique("Employee", ":employee/ssn").rule];
    const exit = await runExit(
      Effect.gen(function* () {
        const triples = yield* Triples;
        yield* seed;
        yield* triples.transact(
          [
            {
              op: "assert",
              entityId: id("ee:4"),
              attribute: ":employee/ssn",
              value: { type: "string", value: "555-00-1111" },
              entityType: "Employee",
            },
          ],
          { enforce: { constraints } },
        );
        return yield* triples.transact(
          [
            {
              op: "assert",
              entityId: id("ee:5"),
              attribute: ":employee/ssn",
              value: { type: "string", value: PLANTED },
              entityType: "Employee",
            },
          ],
          { enforce: { constraints } },
        );
      }),
    );
    const error = failureOf(exit) as {
      _tag: string;
      violations: readonly { code: string; valueIdentity?: string }[];
      message: string;
    };
    expect(error._tag).toBe("ConstraintViolationError");
    expect(error.violations[0]?.code).toBe("unique");
    expect(error.violations[0]?.valueIdentity).toMatch(/^sealed:/);
    expect(JSON.stringify(error)).not.toContain(PLANTED);
  });
});

describe("Datalog over sensitive attributes", () => {
  const rows = (query: DatalogQuery) =>
    run(
      Effect.gen(function* () {
        const triples = yield* Triples;
        yield* seed;
        return (yield* triples.queryAll(query)).results;
      }),
    );

  const rejected = async (query: DatalogQuery) =>
    queryError(
      await runExit(
        Effect.gen(function* () {
          const triples = yield* Triples;
          yield* seed;
          return yield* triples.queryAll(query);
        }),
      ),
    );

  it("answers presence, blind equality, and sensitive-to-sensitive joins", async () => {
    expect(
      await rows({
        find: ["?name"],
        where: [
          ["?e", ":employee/ssn", PLANTED],
          ["?e", ":employee/name", "?name"],
        ],
      }),
    ).toEqual([{ "?name": "Ada" }]);
    expect(
      await rows({
        find: ["?name"],
        where: [
          ["?e", ":employee/name", "?name"],
          ["?e", ":employee/ssn", "?any"],
        ],
        orderBy: [{ variable: "?name" }],
      }),
    ).toEqual([{ "?name": "Ada" }, { "?name": "Grace" }]);
    expect(
      await rows({
        find: ["?name"],
        where: [
          ["?e", ":employee/name", "?name"],
          ["not", ["?e", ":employee/ssn", "?any"]],
        ],
      }),
    ).toEqual([{ "?name": "Linus" }]);
    expect(
      await rows({
        find: ["?applicant", "?name"],
        where: [
          ["?applicant", ":applicant/ssn", "?ssn"],
          ["?e", ":employee/ssn", "?ssn"],
          ["?e", ":employee/name", "?name"],
        ],
      }),
    ).toEqual([{ "?applicant": "app:1", "?name": "Ada" }]);
    expect(await rows({ find: ["?e"], where: [["?e", ":employee/salary", 123456]] })).toEqual([
      { "?e": "ee:1" },
    ]);
    expect(await rows({ find: ["?e"], where: [["?e", ":employee/salary", "123456"]] })).toEqual([]);
  });

  it("rejects every value use the store cannot answer, naming the attribute", async () => {
    const projection = await rejected({ find: ["?ssn"], where: [["?e", ":employee/ssn", "?ssn"]] });
    expect(projection).toMatchObject({ attribute: ":employee/ssn", operation: "projection" });
    expect(projection.message).toContain(":employee/ssn");

    expect(
      await rejected({
        find: ["?e"],
        where: [
          ["?e", ":employee/salary", "?s"],
          [">", "?s", 100],
        ],
      }),
    ).toMatchObject({ attribute: ":employee/salary", operation: "predicate" });
    expect(
      await rejected({
        find: ["?e", "?d"],
        where: [["?e", ":employee/birth-date", "?d"]],
        orderBy: [{ variable: "?d" }],
      }),
    ).toMatchObject({ attribute: ":employee/birth-date", operation: "order" });
    expect(
      await rejected({
        find: ["?total"],
        where: [["?e", ":employee/salary", "?s"]],
        aggregate: [["sum", "?s", "?total"]],
      }),
    ).toMatchObject({ attribute: ":employee/salary", operation: "aggregate" });
    expect(
      await rejected({
        find: ["?e"],
        where: [
          ["?e", ":employee/ssn", "?v"],
          ["?e", ":employee/name", "?v"],
        ],
      }),
    ).toMatchObject({ attribute: ":employee/ssn", operation: "join" });
    expect(
      await rejected({
        find: ["?e"],
        where: [
          ["?e", ":employee/ssn", "?v"],
          ["?v", ":employee/name", "?n"],
        ],
      }),
    ).toMatchObject({ operation: "join" });
    expect(
      await rejected({
        find: ["?a", "?b"],
        where: [["reach", "?a", "?b"]],
        rules: [{ name: "reach", body: [["?a", ":employee/ssn", "?b"]] }],
      }),
    ).toMatchObject({ attribute: ":employee/ssn", operation: "rule" });
    expect(await rejected({ find: ["?v"], where: [["?e", "?attribute", "?v"]] })).toMatchObject({
      attribute: "?attribute",
      operation: "dynamic-attribute",
    });
    expect(
      await rejected({
        find: ["?e", "?ssn"],
        where: [["?e", ":employee/name", "?n"]],
        optionalProjection: {
          rowBinding: "?e",
          fields: [{ attribute: ":employee/ssn", variable: "?ssn" }],
        },
      }),
    ).toMatchObject({ attribute: ":employee/ssn", operation: "projection" });
  });

  it("checks wrapped queries and explain before execution", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const triples = yield* Triples;
        return yield* triples.queryPage({
          inner: { find: ["?e", "?ssn"], where: [["?e", ":employee/ssn", "?ssn"]] },
          orderBy: [{ variable: "?ssn" }],
        });
      }),
    );
    expect(queryError(exit).operation).toBe("order");
    const explain = await runExit(
      Effect.gen(function* () {
        const triples = yield* Triples;
        return yield* triples.explain({ find: ["?ssn"], where: [["?e", ":employee/ssn", "?ssn"]] });
      }),
    );
    expect(queryError(explain).operation).toBe("projection");
  });

  it("pages blind-equality queries with stable cursors", async () => {
    const result = await run(
      Effect.gen(function* () {
        const triples = yield* Triples;
        yield* seed;
        const query: DatalogQuery = {
          find: ["?e"],
          where: [["?e", ":employee/ssn", "?any"]],
          orderBy: [{ variable: "?e" }],
        };
        const first = yield* triples.query(query, { pageSize: 1 });
        const second = yield* triples.query(query, { pageSize: 1, cursor: first.nextCursor! });
        return [...first.results, ...second.results];
      }),
    );
    expect(result).toEqual([{ "?e": "ee:1" }, { "?e": "ee:2" }]);
  });
});

describe("raw engines without the decorator", () => {
  it("never project sealed values and join them only on blind tokens", async () => {
    const backend = makeTestKvBackend();
    await run(seed, backend);
    const raw = await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const projected = (yield* triples.queryAll({
          find: ["?e", "?ssn"],
          where: [["?e", ":employee/ssn", "?ssn"]],
          orderBy: [{ variable: "?e" }],
        })).results;
        const plaintextJoin = (yield* triples.queryAll({
          find: ["?e"],
          where: [["?e", ":employee/ssn", PLANTED]],
        })).results;
        return { projected, plaintextJoin };
      }).pipe(Effect.provide(kvLayer(backend))),
    );
    expect(raw.projected).toEqual([
      { "?e": "ee:1", "?ssn": null },
      { "?e": "ee:2", "?ssn": null },
    ]);
    expect(raw.plaintextJoin).toEqual([]);
  });
});

describe("codecs, erasure, and rotation", () => {
  it("keeps storage shape and semantics with the identity codec", async () => {
    const result = await run(
      Effect.gen(function* () {
        const triples = yield* Triples;
        yield* seed;
        const entity = yield* triples.entity(id("ee:1"));
        const rows = (yield* triples.queryAll({
          find: ["?e"],
          where: [["?e", ":employee/ssn", PLANTED]],
        })).results;
        return { entity, rows, opened: yield* Sensitive.open(entity) };
      }),
      makeTestKvBackend(),
      ValueCodec.identity,
    );
    const ssn = result.entity.find((triple) => triple.attribute === ":employee/ssn")!;
    expect(ssn.value).toMatchObject({ type: "sealed", keyId: "identity" });
    expect(result.rows).toEqual([{ "?e": "ee:1" }]);
    expect(result.opened.find((t) => t.attribute === ":employee/ssn")?.value.type).toBe("string");
  });

  it("crypto-shreds a subject while history stays intact", async () => {
    const keys = KeyProvider.testKeys({ seed: "erasure" });
    const codec = ValueCodec.aesGcm.pipe(Layer.provide(keys.layer));
    const result = await run(
      Effect.gen(function* () {
        const triples = yield* Triples;
        yield* seed;
        keys.destroy({ database: DATABASE, subject: "ee:1" });
        const history = yield* triples.history(id("ee:1"));
        const failed = yield* Effect.exit(Sensitive.open(history));
        const kept = yield* Sensitive.open(history, { erased: "keep-sealed" });
        const other = yield* Sensitive.open(yield* triples.entity(id("ee:2")));
        const presence = (yield* triples.queryAll({
          find: ["?e"],
          where: [["?e", ":employee/ssn", "?any"]],
        })).results;
        return { history, failed, kept, other, presence };
      }),
      makeTestKvBackend(),
      codec,
    );
    expect(result.history.length).toBe(4);
    expect((failureOf(result.failed) as SensitiveValueError).reason).toBe("key-destroyed");
    expect(result.kept.find((t) => t.attribute === ":employee/ssn")?.value.type).toBe("sealed");
    expect(result.kept.find((t) => t.attribute === ":employee/name")?.value).toEqual({
      type: "string",
      value: "Ada",
    });
    expect(result.other.find((t) => t.attribute === ":employee/ssn")?.value).toEqual({
      type: "string",
      value: "123-45-6789",
    });
    expect(result.presence.length).toBe(2);
  });

  it("seals new values under a rotated key and still opens old ones", async () => {
    const keys = KeyProvider.testKeys({ seed: "rotation" });
    const codec = ValueCodec.aesGcm.pipe(Layer.provide(keys.layer));
    const result = await run(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const before = yield* triples.assert({
          entityId: id("ee:7"),
          attribute: ":employee/ssn",
          value: { type: "string", value: "111-22-3333" },
        });
        keys.rotate();
        const after = yield* triples.assert({
          entityId: id("ee:8"),
          attribute: ":employee/ssn",
          value: { type: "string", value: "111-22-3333" },
        });
        return {
          before,
          after,
          opened: yield* Sensitive.open([before, after]),
          same: (yield* triples.queryAll({
            find: ["?a", "?b"],
            where: [
              ["?a", ":employee/ssn", "?v"],
              ["?b", ":employee/ssn", "?v"],
              ["!=", "?a", "?b"],
            ],
          })).results.length,
        };
      }),
      makeTestKvBackend(),
      codec,
    );
    expect((result.before.value as SealedValue).keyId).toBe("test:v1");
    expect((result.after.value as SealedValue).keyId).toBe("test:v2");
    expect(result.opened.map((t) => (t.value as { value: string }).value)).toEqual([
      "111-22-3333",
      "111-22-3333",
    ]);
    expect(result.same).toBe(2);
  });
});

describe("derivations over sensitive attributes", () => {
  it("evaluates presence-based derivations and rejects ones that read values", async () => {
    const result = await run(
      Effect.gen(function* () {
        const triples = yield* Triples;
        yield* seed;
        const missing = yield* Derivation.make({
          name: "employees-missing-ssn",
          query: {
            find: ["?e"],
            where: [
              ["?e", ":employee/name", "?n"],
              ["not", ["?e", ":employee/ssn", "?any"]],
            ],
          },
          identity: ["?e"],
          configSnapshot: "test",
        });
        const shared = yield* Derivation.make({
          name: "applicants-matching-employees",
          query: {
            find: ["?applicant", "?e"],
            where: [
              ["?applicant", ":applicant/ssn", "?ssn"],
              ["?e", ":employee/ssn", "?ssn"],
            ],
          },
          identity: ["?applicant", "?e"],
          configSnapshot: "test",
        });
        const reveals = yield* Derivation.make({
          name: "ssn-list",
          query: { find: ["?ssn"], where: [["?e", ":employee/ssn", "?ssn"]] },
          identity: ["?ssn"],
          configSnapshot: "test",
        });
        const basis = { validAt: Date.now() + 1_000 };
        const missingResult = yield* Derivation.evaluate(triples, missing, { basis });
        const sharedResult = yield* Derivation.evaluate(triples, shared, { basis });
        const revealExit = yield* Effect.exit(Derivation.evaluate(triples, reveals, { basis }));
        const overlay = yield* evaluateOverlay(triples, shared, {
          basis,
          overlay: {
            assertions: [
              {
                entityId: id("app:2"),
                attribute: ":applicant/ssn",
                value: { type: "string", value: "123-45-6789" },
              },
            ],
          },
        });
        return { missingResult, sharedResult, revealExit, overlay };
      }),
    );
    expect(result.missingResult.candidates.map((c) => c.result)).toEqual([{ "?e": "ee:3" }]);
    expect(result.sharedResult.candidates.map((c) => c.result)).toEqual([
      { "?applicant": "app:1", "?e": "ee:1" },
    ]);
    expect(result.sharedResult.candidates[0]!.sources.map((s) => s.attribute).sort()).toEqual([
      ":applicant/ssn",
      ":employee/ssn",
    ]);
    expect(queryError(result.revealExit).operation).toBe("projection");
    expect(result.overlay.candidates.map((c) => c.result)).toEqual([
      { "?applicant": "app:1", "?e": "ee:1" },
      { "?applicant": "app:2", "?e": "ee:2" },
    ]);
    expect(JSON.stringify(result.overlay)).not.toContain("123-45-6789");
  });
});

describe("Sensitivity service", () => {
  it("is available to hosts and exposes no plaintext by default", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sensitivity = yield* Sensitive.current;
        return Option.map(sensitivity, (service) => [...service.attributes.keys()].sort());
      }),
    );
    expect(Option.getOrThrow(result)).toEqual([
      ":applicant/ssn",
      ":employee/birth-date",
      ":employee/salary",
      ":employee/ssn",
      ":i9/document-number",
    ]);
  });

  it("returns typed values from an opened triple", async () => {
    const value: TripleValue = await run(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const triple = yield* triples.assert({
          entityId: id("ee:10"),
          attribute: ":i9/document-number",
          value: { type: "string", value: "A1234567" },
        });
        return (yield* Sensitive.open(triple)).value;
      }),
    );
    expect(value).toEqual({ type: "string", value: "A1234567" });
  });
});
