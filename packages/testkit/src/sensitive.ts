import { datalogTimeSealedCases } from "./datalogTimeCases.js";
/**
 * Shared conformance for sensitive (sealed) attribute values.
 *
 * Two layers of cases:
 *
 * - `sealedStorageCases` run against a backend's raw `Triples` and pin the
 *   engine contract for sealed values: blind-token equality and joins, `null`
 *   projection, no plaintext equality, and exact round-tripping.
 * - `sensitiveConformanceCases` run against `sensitiveConformanceLayer(raw)`
 *   and pin the decorator contract: sealing, explicit opening, planning-time
 *   rejection, blind-index lookups, uniqueness and the journal.
 *
 * Backends add a raw-storage scan with `findPlaintext` over every table, key
 * and value they persist.
 */

import { Effect, Layer } from "effect";
import {
  ConstraintViolationError,
  EntityId,
  SensitiveQueryError,
  Triples,
  WriteError,
  type DatalogQuery,
  type SealedValue,
  type Triple,
  type TripleValue,
} from "@triplex-internal/core";
import { Attribute, EntityType, GraphConstraint } from "@triplex-internal/core/config";
import * as Derivation from "@triplex-internal/core/derivation";
import {
  KeyProvider,
  Sensitive,
  Sensitivity,
  ValueCodec,
  type SensitiveValueError,
} from "@triplex-internal/core/sensitive";

const eid = EntityId.make;

class SensitiveConformanceError extends Error {
  override readonly name = "SensitiveConformanceError";
}

const check = (
  condition: boolean,
  message: string,
): Effect.Effect<void, SensitiveConformanceError> =>
  condition ? Effect.void : Effect.fail(new SensitiveConformanceError(message));

const same = (actual: unknown, expected: unknown, message: string) =>
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );

/**
 * A high-entropy marker planted in sensitive attributes. Raw-storage scans
 * assert that none of its encodings appears anywhere a backend persists data.
 */
export const PLANTED_PLAINTEXT = "zq-planted-4417-9031-sensitive";

/** Every encoding Triplex itself would use for a plaintext string. */
export const plaintextEncodings = (plaintext: string): readonly string[] => {
  const json = JSON.stringify(plaintext);
  const base64url = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  return [plaintext, json, base64url(json), base64url(plaintext)];
};

/** The planted plaintext encodings found in a raw storage dump (empty when clean). */
export const findPlaintext = (dump: string, plaintext = PLANTED_PLAINTEXT): readonly string[] =>
  plaintextEncodings(plaintext).filter((encoding) => dump.includes(encoding));

// ─── Fixture ontology ───────────────────────────────────────────────────────

export const SensitiveFixture = (() => {
  const ssn = Attribute.sensitive(Attribute.text(":sc-employee/ssn"));
  const birthDate = Attribute.sensitive(Attribute.date(":sc-employee/birth-date"));
  const salary = Attribute.sensitive(Attribute.number(":sc-employee/salary"));
  const verified = Attribute.sensitive(Attribute.boolean(":sc-employee/verified"));
  const hiredAt = Attribute.sensitive(Attribute.instant(":sc-employee/hired-at"));
  const name = Attribute.text(":sc-employee/name");
  const applicantSsn = Attribute.sensitive(Attribute.text(":sc-applicant/ssn"));
  const employee = EntityType.make("ScEmployee", {
    ssn: Attribute.use(ssn, { unique: true }),
    birthDate: Attribute.use(birthDate),
    salary: Attribute.use(salary),
    verified: Attribute.use(verified),
    hiredAt: Attribute.use(hiredAt),
    name: Attribute.use(name, { required: true }),
  });
  return { ssn, birthDate, salary, verified, hiredAt, name, applicantSsn, employee };
})();

export const SENSITIVE_CONFORMANCE_DATABASE = "triplex-conformance/sensitive";

/**
 * Decorate a backend's raw `Triples` with the fixture policy, the reference
 * AES-GCM codec and test keys.
 */
export const sensitiveConformanceLayer = <E, R>(
  raw: Layer.Layer<Triples, E, R>,
  codec: Layer.Layer<ValueCodec.ValueCodec> = ValueCodec.aesGcm.pipe(
    Layer.provide(KeyProvider.test({ seed: "triplex-sensitive-conformance" })),
  ),
): Layer.Layer<Triples | Sensitivity, E, R> =>
  Sensitive.layer({
    database: SENSITIVE_CONFORMANCE_DATABASE,
    attributes: [SensitiveFixture.employee, SensitiveFixture.applicantSsn],
  }).pipe(Layer.provide(codec), Layer.provide(raw));

const text = (value: string): TripleValue => ({ type: "string", value });

/** Seed a sealed employee population through the decorated store. */
export const seedSensitiveFixture = Effect.gen(function* () {
  const triples = yield* Triples;
  return yield* triples.transact(
    [
      {
        op: "assert",
        entityId: eid("sc:ee:1"),
        attribute: ":sc-employee/name",
        value: text("Ada"),
        entityType: "ScEmployee",
      },
      {
        op: "assert",
        entityId: eid("sc:ee:1"),
        attribute: ":sc-employee/ssn",
        value: text(PLANTED_PLAINTEXT),
        entityType: "ScEmployee",
      },
      {
        op: "assert",
        entityId: eid("sc:ee:1"),
        attribute: ":sc-employee/birth-date",
        value: text("1990-04-01"),
        entityType: "ScEmployee",
      },
      {
        op: "assert",
        entityId: eid("sc:ee:1"),
        attribute: ":sc-employee/salary",
        value: { type: "number", value: 123456.5 },
        entityType: "ScEmployee",
      },
      {
        op: "assert",
        entityId: eid("sc:ee:1"),
        attribute: ":sc-employee/verified",
        value: { type: "boolean", value: true },
        entityType: "ScEmployee",
      },
      {
        op: "assert",
        entityId: eid("sc:ee:1"),
        attribute: ":sc-employee/hired-at",
        value: { type: "datetime", value: 1_700_000_000_000 },
        entityType: "ScEmployee",
      },
      {
        op: "assert",
        entityId: eid("sc:ee:2"),
        attribute: ":sc-employee/name",
        value: text("Grace"),
        entityType: "ScEmployee",
      },
      {
        op: "assert",
        entityId: eid("sc:ee:2"),
        attribute: ":sc-employee/ssn",
        value: text("sc-second-ssn"),
        entityType: "ScEmployee",
      },
      {
        op: "assert",
        entityId: eid("sc:ee:3"),
        attribute: ":sc-employee/name",
        value: text("Linus"),
        entityType: "ScEmployee",
      },
      {
        op: "assert",
        entityId: eid("sc:app:1"),
        attribute: ":sc-applicant/ssn",
        value: text(PLANTED_PLAINTEXT),
      },
    ],
    { actor: "sc:hr", commandId: "sc-seed" },
  );
});

/** Cases assume `seedSensitiveFixture` already ran once against the store. */
export interface SensitiveConformanceCase {
  readonly name: string;
  readonly run: Effect.Effect<void, unknown, Triples | Sensitivity>;
}

export interface SealedStorageCase {
  readonly name: string;
  readonly run: Effect.Effect<void, unknown, Triples>;
}

const rows = (query: DatalogQuery) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    return (yield* triples.queryAll(query)).results;
  });

const sensitiveFailure = (query: DatalogQuery) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    return yield* triples.queryAll(query).pipe(Effect.flip);
  });

const valueOf = (facts: readonly Triple[], attribute: string): TripleValue | undefined =>
  facts.find((fact) => fact.attribute === attribute)?.value;

export const sensitiveConformanceCases: readonly SensitiveConformanceCase[] = [
  {
    name: "interval metadata is unsealed while value aliases retain sensitive taint",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const entityId = eid("sc:interval");
      yield* t.transact([
        {
          op: "assert",
          entityId,
          attribute: ":sc-employee/ssn",
          value: text(PLANTED_PLAINTEXT),
          validFrom: 10,
          validTo: 20,
        },
      ]);
      const pattern = [entityId, ":sc-employee/ssn", "?sealed"] as const;
      const interval = { pattern, valid: { from: "?from", to: "?end" } } as const;
      yield* same(
        (yield* t.queryAll({ validTime: "all", find: ["?from", "?end"], where: [interval] }))
          .results,
        [{ "?from": 10, "?end": 20 }],
        "presence may expose assertion bounds",
      );
      yield* same(
        (yield* t.queryAll({
          validTime: "all",
          find: ["?end"],
          where: [
            { pattern: [entityId, ":sc-employee/ssn", PLANTED_PLAINTEXT], valid: { to: "?end" } },
          ],
        })).results,
        [{ "?end": 20 }],
        "blind equality may expose assertion bounds",
      );
      const equality = {
        pattern: [entityId, ":sc-employee/ssn", PLANTED_PLAINTEXT],
        valid: { to: "?end" },
      } as const;
      yield* same(
        (yield* t.queryAll({
          validTime: "all",
          find: ["?end"],
          where: [interval, ["not", equality]],
        })).results,
        [],
        "negated interval equality is rewritten to a blind token",
      );
      yield* same(
        (yield* t.queryAll({
          validTime: "all",
          find: ["?end"],
          where: [interval, ["or", [equality]]],
        })).results,
        [{ "?end": 20 }],
        "disjunctive interval equality is rewritten to a blind token",
      );
      for (const query of [
        { validTime: "all", find: ["?sealed"], where: [interval] },
        {
          validTime: "all",
          find: ["?sealed"],
          where: [interval],
          orderBy: [{ variable: "?sealed" }],
        },
        {
          validTime: "all",
          find: ["?count"],
          where: [interval],
          aggregate: [["count", "?sealed", "?count"]],
        },
        {
          validTime: "all",
          find: ["?from"],
          where: [
            { pattern, valid: { from: "?sealed" } },
            { pattern, valid: { from: "?from" } },
          ],
        },
      ] as const) {
        const failed = yield* Effect.result(t.queryAll(query));
        yield* check(
          failed._tag === "Failure" && failed.failure instanceof SensitiveQueryError,
          "sealed values must remain tainted in interval queries",
        );
      }
    }),
  },

  {
    name: "guards a sensitive attribute through blind equality without exposing plaintext",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const entityId = eid("sc:guard");
      const fact = yield* t.assert({
        entityId,
        attribute: ":sc-employee/ssn",
        value: text(PLANTED_PLAINTEXT),
      });
      yield* t.transact([], {
        preconditions: [
          {
            _tag: "AttributeValue",
            entityId,
            attribute: ":sc-employee/ssn",
            value: text(PLANTED_PLAINTEXT),
          },
        ],
      });
      const failed = yield* t
        .transact([], {
          preconditions: [
            {
              _tag: "AttributeValue",
              entityId,
              attribute: ":sc-employee/ssn",
              value: text("different"),
            },
          ],
        })
        .pipe(Effect.result);
      yield* check(
        failed._tag === "Failure" && failed.failure._tag === "TransactionConflictError",
        "wrong sensitive values must conflict through blind equality",
      );
      yield* t.retract(fact.id);
    }),
  },
  {
    name: "seals every write and opens every declared type exactly",
    run: Effect.gen(function* () {
      const triples = yield* Triples;
      const committed = (yield* triples.transactionByCommand("sc-seed"))!;
      yield* check(
        committed.changes.every(
          (change) => change.attribute === ":sc-employee/name" || change.value?.type === "sealed",
        ),
        "committed changes carry sealed values",
      );
      const facts = yield* triples.entity(eid("sc:ee:1"));
      yield* check(
        facts.filter((fact) => fact.value.type === "sealed").length === 5,
        "entity read returns five sealed values",
      );
      yield* check(
        !JSON.stringify(facts).includes(PLANTED_PLAINTEXT),
        "entity read hides plaintext",
      );
      const opened = yield* Sensitive.open(facts);
      yield* same(valueOf(opened, ":sc-employee/ssn"), text(PLANTED_PLAINTEXT), "string opens");
      yield* same(valueOf(opened, ":sc-employee/birth-date"), text("1990-04-01"), "date opens");
      yield* same(
        valueOf(opened, ":sc-employee/salary"),
        { type: "number", value: 123456.5 },
        "number opens",
      );
      yield* same(
        valueOf(opened, ":sc-employee/verified"),
        { type: "boolean", value: true },
        "boolean opens",
      );
      yield* same(
        valueOf(opened, ":sc-employee/hired-at"),
        { type: "datetime", value: 1_700_000_000_000 },
        "datetime opens",
      );
      yield* same(valueOf(opened, ":sc-employee/name"), text("Ada"), "plaintext passes through");
    }),
  },
  {
    name: "keeps the journal and history sealed",
    run: Effect.gen(function* () {
      const triples = yield* Triples;
      const record = yield* triples.transactionByCommand("sc-seed");
      const page = yield* triples.transactionsForEntity(eid("sc:ee:1"));
      const history = yield* triples.history(eid("sc:ee:1"));
      const live = yield* triples.liveFacts(eid("sc:ee:1"));
      yield* check(valueOf(live, ":sc-employee/ssn")?.type === "sealed", "live facts stay sealed");
      for (const [label, value] of [
        ["transaction", record],
        ["entity journal", page],
        ["history", history],
        ["live facts", live],
      ] as const) {
        yield* check(
          !JSON.stringify(value).includes(PLANTED_PLAINTEXT),
          `${label} hides plaintext`,
        );
      }
      const change = record?.changes.find(
        (candidate) =>
          candidate.attribute === ":sc-employee/ssn" && candidate.entityId === "sc:ee:1",
      );
      yield* check(change?.value?.type === "sealed", "journal change is sealed");
      const opened = yield* Sensitive.open(record!);
      yield* same(
        opened.changes.find(
          (candidate) =>
            candidate.attribute === ":sc-employee/ssn" && candidate.entityId === "sc:ee:1",
        )?.value,
        text(PLANTED_PLAINTEXT),
        "journal opens explicitly",
      );
    }),
  },
  {
    name: "answers presence, blind equality, negation and sensitive joins",
    run: Effect.gen(function* () {
      const triples = yield* Triples;
      yield* same(
        yield* rows({
          find: ["?name"],
          where: [
            ["?e", ":sc-employee/ssn", PLANTED_PLAINTEXT],
            ["?e", ":sc-employee/name", "?name"],
          ],
        }),
        [{ "?name": "Ada" }],
        "string constant uses the blind index",
      );
      yield* same(
        yield* rows({ find: ["?e"], where: [["?e", ":sc-employee/salary", 123456.5]] }),
        [{ "?e": "sc:ee:1" }],
        "number constant uses the blind index",
      );
      yield* same(
        yield* rows({ find: ["?e"], where: [["?e", ":sc-employee/hired-at", 1_700_000_000_000]] }),
        [{ "?e": "sc:ee:1" }],
        "datetime constant uses the blind index",
      );
      yield* same(
        yield* rows({ find: ["?e"], where: [["?e", ":sc-employee/verified", true]] }),
        [{ "?e": "sc:ee:1" }],
        "boolean constant uses the blind index",
      );
      yield* same(
        yield* rows({ find: ["?e"], where: [["?e", ":sc-employee/salary", "123456.5"]] }),
        [],
        "a text constant never equals a sealed number",
      );
      yield* same(
        yield* rows({
          find: ["?name"],
          where: [
            ["?e", ":sc-employee/name", "?name"],
            ["?e", ":sc-employee/ssn", "?_any"],
          ],
          orderBy: [{ variable: "?name" }],
        }),
        [{ "?name": "Ada" }, { "?name": "Grace" }],
        "presence",
      );
      yield* same(
        yield* rows({
          find: ["?name"],
          where: [
            ["?e", ":sc-employee/name", "?name"],
            ["not", ["?e", ":sc-employee/ssn", "?_any"]],
          ],
        }),
        [{ "?name": "Linus" }],
        "negated presence",
      );
      yield* same(
        yield* rows({
          find: ["?applicant", "?name"],
          where: [
            ["?applicant", ":sc-applicant/ssn", "?ssn"],
            ["?e", ":sc-employee/ssn", "?ssn"],
            ["?e", ":sc-employee/name", "?name"],
          ],
        }),
        [{ "?applicant": "sc:app:1", "?name": "Ada" }],
        "blind join across sensitive attributes",
      );
      const matched = yield* triples.match({
        attribute: ":sc-employee/ssn",
        value: text(PLANTED_PLAINTEXT),
      });
      yield* same(
        matched.map((fact) => fact.entityId),
        ["sc:ee:1"],
        "match uses the blind index",
      );
      const page = yield* triples.query(
        {
          find: ["?e"],
          where: [["?e", ":sc-employee/ssn", "?_any"]],
          orderBy: [{ variable: "?e" }],
        },
        { pageSize: 1 },
      );
      const next = yield* triples.query(
        {
          find: ["?e"],
          where: [["?e", ":sc-employee/ssn", "?_any"]],
          orderBy: [{ variable: "?e" }],
        },
        { pageSize: 1, cursor: page.nextCursor! },
      );
      yield* same(
        [...page.results, ...next.results],
        [{ "?e": "sc:ee:1" }, { "?e": "sc:ee:2" }],
        "pagination over sensitive presence",
      );
    }),
  },
  {
    name: "rejects value uses during planning with typed errors naming the attribute",
    run: Effect.gen(function* () {
      const cases: ReadonlyArray<
        readonly [DatalogQuery, string, SensitiveQueryError["operation"]]
      > = [
        [
          { find: ["?ssn"], where: [["?e", ":sc-employee/ssn", "?ssn"]] },
          ":sc-employee/ssn",
          "projection",
        ],
        [
          {
            find: ["?e"],
            where: [
              ["?e", ":sc-employee/salary", "?s"],
              [">=", "?s", 1],
            ],
          },
          ":sc-employee/salary",
          "predicate",
        ],
        [
          {
            find: ["?e", "?d"],
            where: [["?e", ":sc-employee/birth-date", "?d"]],
            orderBy: [{ variable: "?d" }],
          },
          ":sc-employee/birth-date",
          "order",
        ],
        [
          {
            find: ["?max"],
            where: [["?e", ":sc-employee/salary", "?s"]],
            aggregate: [["max", "?s", "?max"]],
          },
          ":sc-employee/salary",
          "aggregate",
        ],
        [
          {
            find: ["?e"],
            where: [
              ["?e", ":sc-employee/ssn", "?v"],
              ["?e", ":sc-employee/name", "?v"],
            ],
          },
          ":sc-employee/ssn",
          "join",
        ],
        [
          {
            find: ["?a", "?b"],
            where: [["linked", "?a", "?b"]],
            rules: [{ name: "linked", body: [["?a", ":sc-employee/ssn", "?b"]] }],
          },
          ":sc-employee/ssn",
          "rule",
        ],
      ];
      for (const [query, attribute, operation] of cases) {
        const error = yield* sensitiveFailure(query);
        yield* check(
          error instanceof SensitiveQueryError &&
            error.attribute === attribute &&
            error.operation === operation &&
            error.message.includes(attribute) &&
            !error.message.includes(PLANTED_PLAINTEXT),
          `${operation} on ${attribute} fails with SensitiveQueryError; received ${String(error)}`,
        );
      }
    }),
  },
  {
    name: "rejects foreign sealed input and mistyped sensitive values",
    run: Effect.gen(function* () {
      const triples = yield* Triples;
      const forged: SealedValue = {
        type: "sealed",
        valueType: "string",
        keyId: "forged",
        ciphertext: "forged",
        blind: "forged",
      };
      const forgedError = yield* triples
        .assert({ entityId: eid("sc:ee:9"), attribute: ":sc-employee/ssn", value: forged })
        .pipe(Effect.flip);
      yield* check(
        forgedError instanceof WriteError &&
          (forgedError.cause as SensitiveValueError | undefined)?.reason === "sealed-input",
        "caller-supplied sealed values are rejected",
      );
      const mistyped = yield* triples
        .assert({ entityId: eid("sc:ee:9"), attribute: ":sc-employee/salary", value: text("1") })
        .pipe(Effect.flip);
      yield* check(
        mistyped instanceof WriteError &&
          (mistyped.cause as SensitiveValueError | undefined)?.reason === "invalid-value",
        "mistyped sensitive values are rejected",
      );
      yield* same(yield* triples.entity(eid("sc:ee:9")), [], "rejected writes commit nothing");
    }),
  },
  {
    name: "enforces uniqueness over blind tokens",
    run: Effect.gen(function* () {
      const triples = yield* Triples;
      const constraints = [GraphConstraint.unique("ScEmployee", ":sc-employee/ssn").rule];
      yield* triples.transact(
        [
          {
            op: "assert",
            entityId: eid("sc:ee:4"),
            attribute: ":sc-employee/ssn",
            value: text("sc-fourth-ssn"),
            entityType: "ScEmployee",
          },
        ],
        { enforce: { constraints } },
      );
      const duplicate = yield* triples
        .transact(
          [
            {
              op: "assert",
              entityId: eid("sc:ee:5"),
              attribute: ":sc-employee/ssn",
              value: text(PLANTED_PLAINTEXT),
              entityType: "ScEmployee",
            },
          ],
          { enforce: { constraints } },
        )
        .pipe(Effect.flip);
      yield* check(
        duplicate instanceof ConstraintViolationError &&
          duplicate.violations.some((violation) => violation.code === "unique") &&
          !JSON.stringify(duplicate).includes(PLANTED_PLAINTEXT),
        "duplicate sealed SSN violates uniqueness without revealing it",
      );
    }),
  },
  {
    name: "evaluates presence-based derivations and rejects value-reading ones",
    run: Effect.gen(function* () {
      const triples = yield* Triples;
      const basis = { validAt: Date.now() + 60_000 };
      const matches = yield* Derivation.make({
        name: "sc-applicant-matches",
        query: {
          find: ["?applicant", "?e"],
          where: [
            ["?applicant", ":sc-applicant/ssn", "?ssn"],
            ["?e", ":sc-employee/ssn", "?ssn"],
          ],
        },
        identity: ["?applicant", "?e"],
        configSnapshot: "sensitive-conformance",
      });
      const evaluation = yield* Derivation.evaluate(triples, matches, { basis });
      yield* same(
        evaluation.candidates.map((candidate) => candidate.result),
        [{ "?applicant": "sc:app:1", "?e": "sc:ee:1" }],
        "derivation joins on blind tokens",
      );
      yield* check(
        evaluation.candidates[0]!.sources.length === 2,
        "derivation provenance records both sealed source facts",
      );
      const reveal = yield* Derivation.make({
        name: "sc-reveal",
        query: { find: ["?ssn"], where: [["?e", ":sc-employee/ssn", "?ssn"]] },
        identity: ["?ssn"],
        configSnapshot: "sensitive-conformance",
      });
      const error = yield* Derivation.evaluate(triples, reveal, { basis }).pipe(Effect.flip);
      yield* check(
        error instanceof SensitiveQueryError && error.operation === "projection",
        "value-reading derivation is rejected during planning",
      );
    }),
  },
];

const sealedFact = (blind: string | undefined, marker: string): SealedValue => ({
  type: "sealed",
  valueType: "string",
  keyId: "conformance",
  ciphertext: marker,
  ...(blind === undefined ? {} : { blind }),
});

export const sealedStorageCases: readonly SealedStorageCase[] = [
  ...datalogTimeSealedCases,
  {
    name: "round-trips sealed values and keeps them out of plaintext comparison",
    run: Effect.gen(function* () {
      const triples = yield* Triples;
      yield* triples.assertBatch([
        { entityId: eid("ss:1"), attribute: ":ss/secret", value: sealedFact("token-a", "ct-1") },
        { entityId: eid("ss:2"), attribute: ":ss/secret", value: sealedFact("token-a", "ct-2") },
        { entityId: eid("ss:3"), attribute: ":ss/secret", value: sealedFact("token-b", "ct-3") },
        { entityId: eid("ss:4"), attribute: ":ss/secret", value: sealedFact(undefined, "ct-4") },
        { entityId: eid("ss:9"), attribute: ":ss/other", value: sealedFact("token-a", "ct-9") },
        { entityId: eid("ss:1"), attribute: ":ss/plain", value: text("token-a") },
      ]);
      yield* same(
        valueOf(yield* triples.entity(eid("ss:4")), ":ss/secret"),
        sealedFact(undefined, "ct-4"),
        "unblinded sealed value round-trips",
      );
      yield* same(
        valueOf(yield* triples.entity(eid("ss:1")), ":ss/secret"),
        sealedFact("token-a", "ct-1"),
        "blinded sealed value round-trips",
      );
      yield* same(
        yield* rows({
          find: ["?e", "?v"],
          where: [["?e", ":ss/secret", "?v"]],
          orderBy: [{ variable: "?e" }],
        }),
        [
          { "?e": "ss:1", "?v": null },
          { "?e": "ss:2", "?v": null },
          { "?e": "ss:3", "?v": null },
          { "?e": "ss:4", "?v": null },
        ],
        "sealed bindings project as null",
      );
      yield* same(
        yield* rows({
          find: ["?e"],
          where: [["?e", ":ss/secret", { type: "blind", value: "token-a" }]],
          orderBy: [{ variable: "?e" }],
        }),
        [{ "?e": "ss:1" }, { "?e": "ss:2" }],
        "blind constant",
      );
      yield* same(
        yield* rows({ find: ["?e"], where: [["?e", ":ss/secret", "token-a"]] }),
        [],
        "plaintext constants never match sealed values",
      );
      yield* same(
        yield* rows({
          find: ["?a", "?b"],
          where: [
            ["?a", ":ss/secret", "?v"],
            ["?b", ":ss/other", "?v"],
          ],
          orderBy: [{ variable: "?a" }],
        }),
        [
          { "?a": "ss:1", "?b": "ss:9" },
          { "?a": "ss:2", "?b": "ss:9" },
        ],
        "sealed values join on blind tokens",
      );
      yield* same(
        yield* rows({
          find: ["?a"],
          where: [
            ["?a", ":ss/secret", "?v"],
            ["?a", ":ss/plain", "?v"],
          ],
        }),
        [],
        "sealed values never join plaintext",
      );
      yield* same(
        (yield* triples.match({ attribute: ":ss/secret", value: sealedFact("token-b", "") })).map(
          (fact) => fact.entityId,
        ),
        ["ss:3"],
        "match by blind token",
      );
    }),
  },
];

/** Seed the fixture once, then run every decorator case against the same store. */
export const makeSensitiveConformanceSuite = (): Effect.Effect<
  void,
  unknown,
  Triples | Sensitivity
> =>
  seedSensitiveFixture.pipe(
    Effect.andThen(Effect.forEach(sensitiveConformanceCases, (c) => c.run, { discard: true })),
  );

export const makeSealedStorageSuite = (): Effect.Effect<void, unknown, Triples> =>
  Effect.forEach(sealedStorageCases, (c) => c.run, { discard: true });
