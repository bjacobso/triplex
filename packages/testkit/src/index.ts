/**
 * Shared backend test helpers for Triplex.
 *
 * The centrepiece is {@link makeTriplesConformanceSuite}: a single behavioral
 * suite, expressed as an `Effect` that requires a {@link Triples} service, which
 * every backend layer (SQLite, PostgreSQL, in-memory KV, FoundationDB) should
 * satisfy identically. Run it against a backend's `Layer<Triples>` to assert
 * cross-backend parity — including the write/Datalog coherence that the merged
 * `Triples` service guarantees.
 */

import { Effect } from "effect";
import {
  boolean,
  blob,
  datetime,
  json,
  number,
  ref as makeRef,
  string,
  CommandAlreadyCommittedError,
  ConstraintViolationError,
  DatalogValidationError,
  TransactionConflictError,
  Triples,
  UnboundVariableError,
  EntityId,
} from "@bjacobso/triplex";
import { ConsumerCheckpoint } from "@bjacobso/triplex/operational";
import * as Derivation from "@bjacobso/triplex/derivation";
import { GraphConstraint } from "@bjacobso/triplex/config";

const eid = EntityId.make;
const ref = (value: string) => makeRef(eid(value));

// ─── Lightweight fixture descriptors (unchanged) ────────────────────────────

export interface DatabaseBackendFixture {
  readonly name: string;
  readonly capabilities?: readonly string[];
}

export const defineBackendFixture = (fixture: DatabaseBackendFixture): DatabaseBackendFixture =>
  fixture;

export const expectBackendCapability = (
  fixture: DatabaseBackendFixture,
  capability: string,
): boolean => fixture.capabilities?.includes(capability) ?? false;

// ─── Conformance suite ──────────────────────────────────────────────────────

class ConformanceError extends Error {
  override readonly name = "ConformanceError";
}

const check = (condition: boolean, message: string): Effect.Effect<void, ConformanceError> =>
  condition ? Effect.void : Effect.fail(new ConformanceError(message));

/**
 * A single conformance behavior: a label plus the `Triples`-requiring effect
 * that verifies it. Exposed individually so a test runner can turn each into
 * its own `it`/`test` case if desired.
 */
export interface ConformanceCase {
  readonly name: string;
  readonly run: Effect.Effect<void, unknown, Triples>;
}

/**
 * The behavioral cases every `Triples` backend must pass.
 */
export const triplesConformanceCases: readonly ConformanceCase[] = [
  {
    name: "Datalog reads are bounded by default and cursors traverse the complete snapshot",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch(
        Array.from({ length: 205 }, (_, index) => ({
          entityId: eid(`conf:bounded:${String(index).padStart(3, "0")}`),
          attribute: ":conf/bounded",
          value: number(index),
        })),
      );
      const query = { find: ["?e", "?v"], where: [["?e", ":conf/bounded", "?v"]] } as const;
      const first = yield* t.query(query);
      yield* check(
        first.results.length === 100 && first.nextCursor !== undefined,
        "raw Datalog must default to one bounded page",
      );
      const wrapped = yield* t.queryPage({ inner: query });
      yield* check(
        wrapped.results.length === 100 && wrapped.nextCursor !== undefined,
        "wrapped Datalog must also default to one bounded page",
      );
      const second = yield* t.query(query, { cursor: first.nextCursor! });
      const last = yield* t.query(query, { cursor: second.nextCursor! });
      yield* check(
        second.results.length === 100 && last.results.length === 5 && last.nextCursor === undefined,
        "pages must terminate without losing rows",
      );
      const values = [...first.results, ...second.results, ...last.results].map((row) => row["?v"]);
      yield* check(new Set(values).size === 205, "pages must not duplicate rows");
      const all = yield* t.queryAll(query);
      yield* check(all.results.length === 205, "complete reads require explicit queryAll");
      for (const limit of [0, -1, 1.5, 1001, Number.MAX_SAFE_INTEGER, Infinity]) {
        const failure = yield* t.query(query, { pageSize: limit }).pipe(Effect.flip);
        yield* check(failure !== undefined, "invalid page sizes must fail");
      }
      const subset = {
        ...query,
        orderBy: [{ variable: "?v", direction: "desc" }] as const,
        limit: 7,
        offset: 2,
      };
      const a = yield* t.query(subset, { pageSize: 4 });
      const b = yield* t.query(subset, { pageSize: 4, cursor: a.nextCursor! });
      yield* check(
        JSON.stringify([...a.results, ...b.results].map((row) => row["?v"])) ===
          JSON.stringify([202, 201, 200, 199, 198, 197, 196]),
        "paging must preserve logical inner limits and offsets",
      );
      const constant = yield* t.query({ find: [true], where: query.where }, { pageSize: 1 });
      yield* check(
        constant.results.length === 1 && constant.nextCursor === undefined,
        "constant-only set projections are valid terminal pages",
      );
    }),
  },
  {
    name: "historical cursor pages intersect recorded time and the commit snapshot",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const old = yield* t.assertBatch(
        ["a", "b", "c"].map((value) => ({
          entityId: eid(`conf:paged-history:${value}`),
          attribute: ":conf/paged-history",
          value: string(value),
        })),
      );
      const recordedAt = old[0]!.recordedAt;
      yield* Effect.sleep(2);
      yield* t.retract(old[1]!.id);
      yield* t.assert({
        entityId: eid("conf:paged-history:d"),
        attribute: ":conf/paged-history",
        value: string("d"),
      });
      const query = { find: ["?v"], where: [["?e", ":conf/paged-history", "?v"]] } as const;
      const first = yield* t.query(query, { pageSize: 2, basis: { recordedAt } });
      yield* Effect.sleep(2);
      const last = yield* t.query(query, {
        pageSize: 2,
        cursor: first.nextCursor!,
        basis: { recordedAt },
      });
      yield* check(
        JSON.stringify([...first.results, ...last.results].map((row) => row["?v"])) ===
          JSON.stringify(["a", "b", "c"]),
        "historical pages must retain later-retracted facts and exclude later assertions",
      );
    }),
  },
  {
    name: "recursive relations support cursor pagination and optional total counts",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch(
        [0, 1, 2].map((index) => ({
          entityId: eid(`conf:paged-rule:${index}`),
          attribute: ":conf/paged-parent",
          value: ref(`conf:paged-rule:${index + 1}`),
        })),
      );
      const inner = {
        find: ["?ancestor"],
        where: [["paged-ancestor", "conf:paged-rule:0", "?ancestor"]],
        rules: [
          { name: "paged-ancestor", body: [["?x", ":conf/paged-parent", "?y"]] },
          {
            name: "paged-ancestor",
            body: [
              ["?x", ":conf/paged-parent", "?z"],
              ["paged-ancestor", "?z", "?y"],
            ],
          },
        ],
      } as const;
      const first = yield* t.queryPage({ inner, limit: 2, includeCount: true });
      const last = yield* t.queryPage({
        inner,
        limit: 2,
        includeCount: true,
        cursor: first.nextCursor!,
      });
      yield* check(
        first.totalCount === 3 &&
          last.totalCount === 3 &&
          last.results.length === 1 &&
          last.nextCursor === undefined,
        "recursive pages must count and traverse the entire relation",
      );
    }),
  },
  {
    name: "assert then get and match return the fact",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const triple = yield* t.assert({
        entityId: eid("conf:person:1"),
        attribute: ":name",
        value: { type: "string", value: "Alice" },
        entityType: "Person",
      });

      const got = yield* t.get(triple.id);
      yield* check(got !== null && got.id === triple.id, "get should return the asserted triple");

      const matched = yield* t.match({ entityId: eid("conf:person:1"), attribute: ":name" });
      yield* check(
        matched.length === 1 && matched[0]!.value.type === "string",
        "match should return exactly the asserted triple",
      );

      const entity = yield* t.entity("conf:person:1" as EntityId);
      yield* check(entity.length >= 1, "entity should return the asserted triple");
    }),
  },
  {
    name: "same-value facts in one batch keep distinct identities",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const input = {
        entityId: eid("conf:duplicate:1"),
        attribute: ":conf/value",
        value: string("same"),
      } as const;
      const asserted = yield* t.assertBatch([input, input]);
      const matched = yield* t.match({
        entityId: eid(input.entityId),
        attribute: input.attribute,
        value: input.value,
      });
      yield* check(
        asserted[0]?.id !== asserted[1]?.id && matched.length === 2,
        "same-value facts in one transaction must not overwrite an index entry",
      );
    }),
  },
  {
    name: "datalog query finds asserted facts",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assert({
        entityId: eid("conf:person:2"),
        attribute: ":name",
        value: { type: "string", value: "Bob" },
        entityType: "Person",
      });

      const { results } = yield* t.query({
        find: ["?name"],
        where: [["?p", ":name", "?name"]],
      });
      const names = results.map((r) => r["?name"]);
      yield* check(names.includes("Bob"), "datalog query should surface Bob");
    }),
  },
  {
    name: "datalog projections preserve scalar types without guessing from text",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        { entityId: eid("42"), attribute: ":conf/code", value: string("007") },
        { entityId: eid("42"), attribute: ":conf/count", value: number(7) },
        { entityId: eid("42"), attribute: ":conf/enabled", value: boolean(true) },
        { entityId: eid("42"), attribute: ":conf/instant", value: datetime(1_700_000_000_000) },
        { entityId: eid("42"), attribute: ":conf/data", value: json({ ok: true }) },
        { entityId: eid("42"), attribute: ":conf/owner", value: ref("7") },
        {
          entityId: eid("42"),
          attribute: ":conf/blob",
          value: blob("sha256:artifact", "application/pdf", 128, "artifact.pdf"),
        },
      ]);

      const { results } = yield* t.query({
        find: ["?entity", "?code", "?count", "?enabled", "?instant", "?data", "?owner", "?blob"],
        where: [
          ["?entity", ":conf/code", "?code"],
          ["?entity", ":conf/count", "?count"],
          ["?entity", ":conf/enabled", "?enabled"],
          ["?entity", ":conf/instant", "?instant"],
          ["?entity", ":conf/data", "?data"],
          ["?entity", ":conf/owner", "?owner"],
          ["?entity", ":conf/blob", "?blob"],
        ],
      });
      const row = results[0];
      yield* check(results.length === 1, "typed projection fixture should produce one row");
      yield* check(row?.["?entity"] === "42", "numeric-looking entity IDs must stay strings");
      yield* check(row?.["?code"] === "007", "numeric-looking string values must stay strings");
      yield* check(row?.["?count"] === 7, "number values must project as numbers");
      yield* check(row?.["?enabled"] === true, "boolean values must project as booleans");
      yield* check(
        row?.["?instant"] === 1_700_000_000_000,
        "datetime values must project as epoch numbers",
      );
      yield* check(row?.["?data"] === '{"ok":true}', "JSON values must use canonical row text");
      yield* check(row?.["?owner"] === "7", "numeric-looking refs must stay strings");
      yield* check(
        row?.["?blob"] === "sha256:artifact",
        "blob bindings must project their content identity",
      );
    }),
  },
  {
    name: "datalog deduplicates flattened scalar families before grouping and pagination",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const textValue = "sha256:dedupe-seven";
      yield* t.assertBatch([
        { entityId: eid("conf:dedupe:number"), attribute: ":conf/dedupe", value: number(7) },
        { entityId: eid("conf:dedupe:datetime"), attribute: ":conf/dedupe", value: datetime(7) },
        {
          entityId: eid("conf:dedupe:string"),
          attribute: ":conf/dedupe",
          value: string(textValue),
        },
        { entityId: eid("conf:dedupe:ref"), attribute: ":conf/dedupe", value: ref(textValue) },
        {
          entityId: eid("conf:dedupe:blob"),
          attribute: ":conf/dedupe",
          value: blob(textValue, "application/octet-stream", 7),
        },
      ]);

      const direct = yield* t.query({
        find: ["?value"],
        where: [["?entity", ":conf/dedupe", "?value"]],
        orderBy: [{ variable: "?value" }],
      });
      yield* check(
        JSON.stringify(direct.results) ===
          JSON.stringify([{ "?value": 7 }, { "?value": textValue }]),
        "projection DISTINCT must collapse storage types with the same public scalar value",
      );

      const grouped = yield* t.query({
        find: ["?value", "?count"],
        where: [["?entity", ":conf/dedupe", "?value"]],
        aggregate: [["count", "?entity", "?count"]],
        orderBy: [{ variable: "?value" }],
      });
      yield* check(
        grouped.results.length === 2 &&
          grouped.results[0]?.["?value"] === 7 &&
          grouped.results[0]?.["?count"] === 2 &&
          grouped.results[1]?.["?value"] === textValue &&
          grouped.results[1]?.["?count"] === 3,
        "GROUP BY must use flattened scalar identity instead of physical storage tags",
      );

      const first = yield* t.queryPage({
        inner: {
          find: ["?value"],
          where: [["?entity", ":conf/dedupe", "?value"]],
        },
        orderBy: [{ variable: "?value" }],
        limit: 1,
        includeCount: true,
      });
      yield* check(
        first.results.length === 1 &&
          first.results[0]?.["?value"] === 7 &&
          first.totalCount === 2 &&
          first.nextCursor !== undefined,
        "the first page must count logical rows and expose a cursor after the numeric family",
      );

      const second = yield* t.queryPage({
        inner: {
          find: ["?value"],
          where: [["?entity", ":conf/dedupe", "?value"]],
        },
        orderBy: [{ variable: "?value" }],
        limit: 1,
        includeCount: true,
        cursor: first.nextCursor,
      });
      yield* check(
        second.results.length === 1 &&
          second.results[0]?.["?value"] === textValue &&
          second.totalCount === 2 &&
          second.nextCursor === undefined,
        "cursor pagination must visit each flattened scalar row exactly once",
      );
    }),
  },
  {
    name: "datalog constant projections retain their scalar values through pagination",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const projectedRef = ref("conf:constant-projection:ref");
      yield* t.assert({
        entityId: eid("conf:constant-projection:entity"),
        attribute: ":conf/constant-projection",
        value: string("anchor"),
      });

      const query = {
        find: ["literal", 7, true, projectedRef, "?entity"],
        where: [["?entity", ":conf/constant-projection", "anchor"]],
      } as const;
      const assertProjection = (row: Readonly<Record<string, unknown>> | undefined): boolean =>
        row?.["literal"] === "literal" &&
        row?.["7"] === 7 &&
        row?.["true"] === true &&
        row?.[String(projectedRef)] === projectedRef.value &&
        row?.["?entity"] === "conf:constant-projection:entity";

      const direct = yield* t.query(query);
      yield* check(
        direct.results.length === 1 && assertProjection(direct.results[0]),
        "direct constant projections must retain booleans and flatten typed refs",
      );

      const page = yield* t.queryPage({
        inner: query,
        orderBy: [{ variable: "?entity" }],
        limit: 1,
      });
      yield* check(
        page.results.length === 1 && assertProjection(page.results[0]),
        "wrapped queries must not drop constant projection columns",
      );
    }),
  },
  {
    name: "datalog pattern constants use flattened scalar identity in filters",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const jsonText = '{"kind":"same"}';
      const facts = [
        { entityId: eid("conf:constant:number"), value: number(7) },
        { entityId: eid("conf:constant:datetime"), value: datetime(7) },
        { entityId: eid("conf:constant:string"), value: string(jsonText) },
        { entityId: eid("conf:constant:ref"), value: ref(jsonText) },
        {
          entityId: eid("conf:constant:blob"),
          value: blob(jsonText, "application/octet-stream", 7),
        },
        { entityId: eid("conf:constant:json"), value: json({ kind: "same" }) },
      ] as const;
      yield* t.assertBatch(
        facts.flatMap(({ entityId, value }) => [
          { entityId, attribute: ":conf/constant", value },
          { entityId, attribute: ":conf/candidate", value: boolean(true) },
        ]),
      );

      const numeric = yield* t.query({
        find: ["?entity"],
        where: [["?entity", ":conf/constant", 7]],
        orderBy: [{ variable: "?entity" }],
      });
      yield* check(
        JSON.stringify(numeric.results) ===
          JSON.stringify([
            { "?entity": "conf:constant:datetime" },
            { "?entity": "conf:constant:number" },
          ]),
        "a numeric pattern constant must match stored numbers and datetimes",
      );

      const textual = yield* t.query({
        find: ["?entity"],
        where: [["?entity", ":conf/constant", jsonText]],
        orderBy: [{ variable: "?entity" }],
      });
      yield* check(
        JSON.stringify(textual.results.map((row) => row["?entity"])) ===
          JSON.stringify([
            "conf:constant:blob",
            "conf:constant:json",
            "conf:constant:ref",
            "conf:constant:string",
          ]),
        "a text pattern constant must match equal string, ref, blob, and serialized JSON values",
      );

      const explicitRef = yield* t.query({
        find: ["?entity"],
        where: [["?entity", ":conf/constant", { type: "ref", value: jsonText }]],
      });
      yield* check(
        explicitRef.results.length === 1 &&
          explicitRef.results[0]?.["?entity"] === "conf:constant:ref",
        "an explicitly typed ref pattern must retain exact storage-type semantics",
      );

      const negated = yield* t.query({
        find: ["?entity"],
        where: [
          ["?entity", ":conf/candidate", true],
          ["not", ["?entity", ":conf/constant", 7]],
        ],
        orderBy: [{ variable: "?entity" }],
      });
      yield* check(
        negated.results.length === 4 &&
          negated.results.every((row) => !String(row["?entity"]).match(/number|datetime/)),
        "negated pattern constants must use the same scalar-family identity",
      );

      const disjoined = yield* t.query({
        find: ["?entity"],
        where: [
          ["?entity", ":conf/candidate", true],
          [
            "or",
            [
              ["?entity", ":conf/constant", 7],
              ["?entity", ":conf/constant", jsonText],
            ],
          ],
        ],
        orderBy: [{ variable: "?entity" }],
      });
      yield* check(
        disjoined.results.length === facts.length,
        "or-pattern constants must use the same scalar-family identity",
      );
    }),
  },
  {
    name: "datalog value joins compare every scalar family",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        { entityId: eid("conf:join:left:number"), attribute: ":conf/left", value: number(7) },
        { entityId: eid("conf:join:right:number"), attribute: ":conf/right", value: number(7) },
        { entityId: eid("conf:join:left:string"), attribute: ":conf/left", value: string("7") },
        { entityId: eid("conf:join:right:string"), attribute: ":conf/right", value: string("7") },
        { entityId: eid("conf:join:right:other"), attribute: ":conf/right", value: number(8) },
        {
          entityId: eid("conf:join:left:json"),
          attribute: ":conf/left",
          value: json({ stable: true }),
        },
        {
          entityId: eid("conf:join:right:json"),
          attribute: ":conf/right",
          value: json({ stable: true }),
        },
        {
          entityId: eid("conf:join:left:blob"),
          attribute: ":conf/left",
          value: blob("sha256:shared", "application/octet-stream", 32),
        },
        {
          entityId: eid("conf:join:right:blob"),
          attribute: ":conf/right",
          value: blob("sha256:shared", "application/pdf", 32),
        },
      ]);

      const { results } = yield* t.query({
        find: ["?left", "?right"],
        where: [
          ["?left", ":conf/left", "?value"],
          ["?right", ":conf/right", "?value"],
        ],
      });
      const pairs = results.map((row) => `${row["?left"]}->${row["?right"]}`).sort();
      yield* check(
        JSON.stringify(pairs) ===
          JSON.stringify([
            "conf:join:left:blob->conf:join:right:blob",
            "conf:join:left:json->conf:join:right:json",
            "conf:join:left:number->conf:join:right:number",
            "conf:join:left:string->conf:join:right:string",
          ]),
        "value joins must match numeric and textual families without crossing them",
      );
    }),
  },
  {
    name: "datalog equality predicates compare numeric values as numbers",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        { entityId: eid("conf:eq:number"), attribute: ":conf/equality", value: number(7) },
        { entityId: eid("conf:eq:datetime"), attribute: ":conf/equality", value: datetime(7) },
        { entityId: eid("conf:eq:string"), attribute: ":conf/equality", value: string("7") },
        { entityId: eid("conf:eq:other"), attribute: ":conf/equality", value: number(8) },
      ]);

      const equal = yield* t.query({
        find: ["?entity"],
        where: [
          ["?entity", ":conf/equality", "?value"],
          ["=", "?value", 7],
        ],
      });
      const unequal = yield* t.query({
        find: ["?entity"],
        where: [
          ["?entity", ":conf/equality", "?value"],
          ["!=", "?value", 7],
        ],
      });
      yield* check(
        JSON.stringify(equal.results.map((row) => row["?entity"]).sort()) ===
          JSON.stringify(["conf:eq:datetime", "conf:eq:number"]),
        "numeric equality must include number and datetime scalars",
      );
      yield* check(
        JSON.stringify(unequal.results.map((row) => row["?entity"]).sort()) ===
          JSON.stringify(["conf:eq:other", "conf:eq:string"]),
        "numeric inequality must preserve type-aware scalar semantics",
      );
    }),
  },
  {
    name: "datalog equality keeps identity bindings string-typed",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const entityId = eid("conf:identity:7");
      yield* t.assert({
        entityId,
        attribute: ":conf/identity",
        value: string("present"),
      });

      const equalString = yield* t.query({
        find: ["?entity"],
        where: [
          ["?entity", ":conf/identity", "present"],
          ["=", "?entity", entityId],
        ],
      });
      const equalNumber = yield* t.query({
        find: ["?entity"],
        where: [
          ["?entity", ":conf/identity", "present"],
          ["=", "?entity", 7],
        ],
      });
      const inverseEqualBoolean = yield* t.query({
        find: ["?entity"],
        where: [
          ["?entity", ":conf/identity", "present"],
          ["=", true, "?entity"],
        ],
      });
      const unequalNumber = yield* t.query({
        find: ["?entity"],
        where: [
          ["?entity", ":conf/identity", "present"],
          ["!=", "?entity", 7],
        ],
      });

      yield* check(
        equalString.results.length === 1 && equalString.results[0]?.["?entity"] === entityId,
        "identity bindings must compare with string constants",
      );
      yield* check(
        equalNumber.results.length === 0 && inverseEqualBoolean.results.length === 0,
        "identity equality with numeric or boolean constants must be false without backend casts",
      );
      yield* check(
        unequalNumber.results.length === 1 && unequalNumber.results[0]?.["?entity"] === entityId,
        "identity inequality with an incompatible constant must be true",
      );
    }),
  },
  {
    name: "ordered Datalog predicates accept only numeric scalar families",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        { entityId: eid("conf:ordered:number-2"), attribute: ":conf/ordered", value: number(2) },
        {
          entityId: eid("conf:ordered:datetime-3"),
          attribute: ":conf/ordered",
          value: datetime(3),
        },
        {
          entityId: eid("conf:ordered:number-10"),
          attribute: ":conf/ordered",
          value: number(10),
        },
        {
          entityId: eid("conf:ordered:string-20"),
          attribute: ":conf/ordered",
          value: string("20"),
        },
        { entityId: eid("conf:ordered:boolean"), attribute: ":conf/ordered", value: boolean(true) },
      ]);

      const { results } = yield* t.query({
        find: ["?entity"],
        where: [
          ["?entity", ":conf/ordered", "?value"],
          [">", "?value", 2],
        ],
        orderBy: [{ variable: "?entity" }],
      });
      yield* check(
        JSON.stringify(results.map((row) => row["?entity"])) ===
          JSON.stringify(["conf:ordered:datetime-3", "conf:ordered:number-10"]),
        "ordered predicates must include number and datetime values without coercing text or booleans",
      );
    }),
  },
  {
    name: "datalog reverse lookup matches an explicitly typed ref constant",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        {
          entityId: eid("conf:refs:typed:mid"),
          attribute: ":conf/typed-child",
          value: ref("conf:refs:typed:leaf"),
        },
        {
          entityId: eid("conf:refs:typed:other"),
          attribute: ":conf/typed-child",
          value: ref("conf:refs:typed:leaf"),
        },
      ]);

      const { results } = yield* t.query({
        find: ["?parent"],
        where: [["?parent", ":conf/typed-child", ref("conf:refs:typed:leaf")]],
      });
      const parents = results.map((row) => row["?parent"]).sort();
      yield* check(
        JSON.stringify(parents) ===
          JSON.stringify(["conf:refs:typed:mid", "conf:refs:typed:other"]),
        "typed ref reverse lookup should find every parent",
      );
    }),
  },
  {
    name: "datalog joins a variable bound from a ref in value position",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        {
          entityId: eid("conf:refs:join:mid"),
          attribute: ":conf/join-child",
          value: ref("conf:refs:join:leaf"),
        },
        {
          entityId: eid("conf:refs:join:other"),
          attribute: ":conf/join-child",
          value: ref("conf:refs:join:leaf"),
        },
      ]);

      const { results } = yield* t.query({
        find: ["?parent"],
        where: [
          ["conf:refs:join:mid", ":conf/join-child", "?leaf"],
          ["?parent", ":conf/join-child", "?leaf"],
        ],
      });
      const parents = results.map((row) => row["?parent"]).sort();
      yield* check(
        JSON.stringify(parents) === JSON.stringify(["conf:refs:join:mid", "conf:refs:join:other"]),
        "a ref-valued binding should join against ref-valued facts",
      );
    }),
  },
  {
    name: "datalog supports multi-hop joins over ref edges",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        {
          entityId: eid("conf:refs:hops:grand"),
          attribute: ":conf/hops-child",
          value: ref("conf:refs:hops:parent"),
        },
        {
          entityId: eid("conf:refs:hops:parent"),
          attribute: ":conf/hops-child",
          value: ref("conf:refs:hops:leaf"),
        },
        {
          entityId: eid("conf:refs:hops:sibling"),
          attribute: ":conf/hops-child",
          value: ref("conf:refs:hops:leaf"),
        },
      ]);

      const { results } = yield* t.query({
        find: ["?grandparent", "?leafParent"],
        where: [
          ["?grandparent", ":conf/hops-child", "?parent"],
          ["?parent", ":conf/hops-child", "?leaf"],
          ["?leafParent", ":conf/hops-child", "?leaf"],
        ],
      });
      const paths = results
        .map((row) => `${String(row["?grandparent"])}->${String(row["?leafParent"])}`)
        .sort();
      yield* check(
        JSON.stringify(paths) ===
          JSON.stringify([
            "conf:refs:hops:grand->conf:refs:hops:parent",
            "conf:refs:hops:grand->conf:refs:hops:sibling",
          ]),
        "multi-hop ref joins should preserve every matching path",
      );
    }),
  },
  {
    name: "datalog recursive rules compute the same transitive closure",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        {
          entityId: eid("conf:rules:a"),
          attribute: ":conf/rules-parent",
          value: ref("conf:rules:b"),
        },
        {
          entityId: eid("conf:rules:b"),
          attribute: ":conf/rules-parent",
          value: ref("conf:rules:c"),
        },
        {
          entityId: eid("conf:rules:c"),
          attribute: ":conf/rules-parent",
          value: ref("conf:rules:d"),
        },
        {
          entityId: eid("conf:rules:unrelated"),
          attribute: ":conf/rules-parent",
          value: ref("conf:rules:other"),
        },
        {
          entityId: eid("conf:rules:text-source"),
          attribute: ":conf/rules-parent",
          value: string("conf:rules:text-target"),
        },
        {
          entityId: eid("conf:rules:number-source"),
          attribute: ":conf/rules-parent",
          value: number(7),
        },
        {
          entityId: eid("conf:rules:boolean-source"),
          attribute: ":conf/rules-parent",
          value: boolean(false),
        },
      ]);

      const { results } = yield* t.query({
        find: ["?ancestor"],
        where: [["conf-rules-ancestor", "conf:rules:a", "?ancestor"]],
        rules: [
          {
            name: "conf-rules-ancestor",
            body: [["?child", ":conf/rules-parent", "?parent"]],
          },
          {
            name: "conf-rules-ancestor",
            body: [
              ["?child", ":conf/rules-parent", "?parent"],
              ["conf-rules-ancestor", "?parent", "?ancestor"],
            ],
          },
        ],
      });
      const ancestors = results.map((row) => row["?ancestor"]).sort();
      yield* check(
        JSON.stringify(ancestors) ===
          JSON.stringify(["conf:rules:b", "conf:rules:c", "conf:rules:d"]),
        "recursive rules should compute the complete transitive closure without unrelated rows",
      );

      const shared = yield* t.query({
        find: ["?ancestor"],
        where: [
          ["conf-rules-ancestor", "conf:rules:a", "?ancestor"],
          ["conf-rules-ancestor", "conf:rules:b", "?ancestor"],
        ],
        rules: [
          {
            name: "conf-rules-ancestor",
            body: [["?child", ":conf/rules-parent", "?parent"]],
          },
          {
            name: "conf-rules-ancestor",
            body: [
              ["?child", ":conf/rules-parent", "?parent"],
              ["conf-rules-ancestor", "?parent", "?ancestor"],
            ],
          },
        ],
      });
      yield* check(
        JSON.stringify(shared.results.map((row) => row["?ancestor"]).sort()) ===
          JSON.stringify(["conf:rules:c", "conf:rules:d"]),
        "multiple applications of one rule should use independent aliases",
      );

      const relation = yield* t.query({
        find: ["?source", "?target"],
        where: [["conf-rules-ancestor", "?source", "?target"]],
        rules: [
          {
            name: "conf-rules-ancestor",
            body: [["?child", ":conf/rules-parent", "?parent"]],
          },
        ],
      });
      const pairs = relation.results
        .map((row) => `${String(row["?source"])}->${String(row["?target"])}`)
        .sort();
      yield* check(
        JSON.stringify(pairs) ===
          JSON.stringify([
            "conf:rules:a->conf:rules:b",
            "conf:rules:b->conf:rules:c",
            "conf:rules:c->conf:rules:d",
            "conf:rules:text-source->conf:rules:text-target",
            "conf:rules:unrelated->conf:rules:other",
          ]),
        "binary rule relations should expose only string identity endpoints",
      );
    }),
  },
  {
    name: "datalog rule patterns unify repeated variables",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        {
          entityId: eid("conf:rules:self"),
          attribute: ":conf/rules-same",
          value: ref("conf:rules:self"),
        },
        {
          entityId: eid("conf:rules:not-self"),
          attribute: ":conf/rules-same",
          value: ref("conf:rules:other"),
        },
      ]);

      const { results } = yield* t.query({
        find: ["?node"],
        where: [["conf-rules-self", "?node", "?node"]],
        rules: [
          {
            name: "conf-rules-self",
            body: [["?node", ":conf/rules-same", "?node"]],
          },
        ],
      });

      yield* check(
        JSON.stringify(results.map((row) => row["?node"])) === JSON.stringify(["conf:rules:self"]),
        "a repeated variable in a rule body and application should enforce equality",
      );
    }),
  },
  {
    name: "datalog aggregations group, filter, and order consistently",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        { entityId: eid("conf:aggregate:alice"), attribute: ":conf/team", value: ref("east") },
        { entityId: eid("conf:aggregate:alice"), attribute: ":conf/score", value: number(10) },
        { entityId: eid("conf:aggregate:bob"), attribute: ":conf/team", value: ref("east") },
        { entityId: eid("conf:aggregate:bob"), attribute: ":conf/score", value: number(10) },
        { entityId: eid("conf:aggregate:carol"), attribute: ":conf/team", value: ref("west") },
        { entityId: eid("conf:aggregate:carol"), attribute: ":conf/score", value: number(5) },
      ]);

      const { results } = yield* t.query({
        find: ["?team", "?count", "?sum", "?average", "?minimum", "?maximum"],
        where: [
          ["?member", ":conf/team", "?team"],
          ["?member", ":conf/score", "?score"],
        ],
        aggregate: [
          ["count", "?member", "?count"],
          ["sum", "?score", "?sum"],
          ["avg", "?score", "?average"],
          ["min", "?score", "?minimum"],
          ["max", "?score", "?maximum"],
        ],
        having: [[">=", "?count", 2]],
        orderBy: [{ variable: "?sum", direction: "desc" }],
      });

      yield* check(results.length === 1, "HAVING should keep only the two-member team");
      yield* check(results[0]?.["?team"] === "east", "aggregation should retain group values");
      yield* check(results[0]?.["?count"] === 2, "count should include both team members");
      yield* check(results[0]?.["?sum"] === 20, "sum should include equal numeric values");
      yield* check(results[0]?.["?average"] === 10, "average should remain numeric");
      yield* check(results[0]?.["?minimum"] === 10, "minimum should remain numeric");
      yield* check(results[0]?.["?maximum"] === 10, "maximum should remain numeric");
    }),
  },
  {
    name: "datalog having preserves typed group and aggregate equality",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        {
          entityId: eid("conf:having:number"),
          attribute: ":conf/having-bucket",
          value: number(7),
        },
        {
          entityId: eid("conf:having:datetime"),
          attribute: ":conf/having-bucket",
          value: datetime(7),
        },
        {
          entityId: eid("conf:having:text"),
          attribute: ":conf/having-bucket",
          value: string("7"),
        },
      ]);

      const numeric = yield* t.query({
        find: ["?bucket", "?count"],
        where: [["?entity", ":conf/having-bucket", "?bucket"]],
        aggregate: [["count", "?entity", "?count"]],
        having: [
          ["=", "?bucket", 7],
          ["=", "?count", 2],
        ],
      });
      yield* check(numeric.results.length === 1, "numeric HAVING equality should retain one group");
      yield* check(numeric.results[0]?.["?bucket"] === 7, "numeric group identity should be kept");
      yield* check(
        numeric.results[0]?.["?count"] === 2,
        "number and datetime values should share one numeric group",
      );

      const orderedNumeric = yield* t.query({
        find: ["?bucket", "?count"],
        where: [["?entity", ":conf/having-bucket", "?bucket"]],
        aggregate: [["count", "?entity", "?count"]],
        having: [[">", "?bucket", 6]],
      });
      yield* check(
        orderedNumeric.results.length === 1 && orderedNumeric.results[0]?.["?bucket"] === 7,
        "ordered HAVING must use the canonical numeric group expression",
      );

      const textOnly = yield* t.query({
        find: ["?bucket", "?count"],
        where: [["?entity", ":conf/having-bucket", "?bucket"]],
        aggregate: [["count", "?entity", "?count"]],
        having: [["!=", "?bucket", 7]],
      });
      yield* check(textOnly.results.length === 1, "typed inequality should retain only text");
      yield* check(textOnly.results[0]?.["?bucket"] === "7", "text 7 must remain distinct from 7");
      yield* check(textOnly.results[0]?.["?count"] === 1, "text group should contain one row");

      const invalid = yield* t
        .query({
          find: ["?count"],
          where: [["?entity", ":conf/having-bucket", "?bucket"]],
          aggregate: [["count", "?entity", "?count"]],
          having: [["=", "?count", "2"]],
        })
        .pipe(Effect.flip);
      yield* check(
        invalid instanceof DatalogValidationError,
        "aggregate equality with a text operand must fail typed preflight",
      );
    }),
  },
  {
    name: "datalog aggregates preserve duplicate rows and define empty and distinct results",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        {
          entityId: eid("conf:aggregate:duplicate:a"),
          attribute: ":conf/amount",
          value: number(10),
        },
        {
          entityId: eid("conf:aggregate:duplicate:b"),
          attribute: ":conf/amount",
          value: number(10),
        },
      ]);

      const summed = yield* t.query({
        find: ["?sum", "?count"],
        where: [["?entity", ":conf/amount", "?amount"]],
        aggregate: [
          ["sum", "?amount", "?sum"],
          ["count", "?amount", "?count"],
        ],
      });
      yield* check(summed.results.length === 1, "ungrouped aggregation should return one row");
      yield* check(summed.results[0]?.["?sum"] === 20, "sum must preserve equal input rows");
      yield* check(
        summed.results[0]?.["?count"] === 1,
        "count uses distinct flattened input values",
      );

      const empty = yield* t.query({
        find: ["?count", "?sum", "?average", "?minimum", "?maximum"],
        where: [["?entity", ":conf/missing-amount", "?amount"]],
        aggregate: [
          ["count", "?amount", "?count"],
          ["sum", "?amount", "?sum"],
          ["avg", "?amount", "?average"],
          ["min", "?amount", "?minimum"],
          ["max", "?amount", "?maximum"],
        ],
      });
      yield* check(empty.results.length === 1, "empty ungrouped aggregation should return one row");
      yield* check(empty.results[0]?.["?count"] === 0, "empty count should be zero");
      for (const variable of ["?sum", "?average", "?minimum", "?maximum"]) {
        yield* check(
          empty.results[0]?.[variable] === null,
          `${variable} should be null when empty`,
        );
      }
    }),
  },
  {
    name: "datalog conjunctions establish bindings independent of clause order",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        {
          entityId: eid("conf:clause-order:blocked"),
          attribute: ":conf/order-score",
          value: number(12),
        },
        {
          entityId: eid("conf:clause-order:blocked"),
          attribute: ":conf/blocked-at",
          value: number(20),
        },
        {
          entityId: eid("conf:clause-order:eligible"),
          attribute: ":conf/order-score",
          value: number(15),
        },
        {
          entityId: eid("conf:clause-order:low"),
          attribute: ":conf/order-score",
          value: number(5),
        },
      ]);

      const { results } = yield* t.query({
        find: ["?member"],
        where: [
          ["not", [">=", "?blockedAt", 15], ["?member", ":conf/blocked-at", "?blockedAt"]],
          [">=", "?score", 10],
          ["?member", ":conf/order-score", "?score"],
        ],
      });

      yield* check(
        JSON.stringify(results.map((row) => row["?member"])) ===
          JSON.stringify(["conf:clause-order:eligible"]),
        "patterns should bind outer and negation-local variables before predicates run",
      );
    }),
  },
  {
    name: "datalog rejects invalid and unbound queries with backend-neutral typed errors",
    run: Effect.gen(function* () {
      const t = yield* Triples;

      const unbound = yield* t
        .query({
          find: ["?missing"],
          where: [["?entity", ":conf/validation", "?value"]],
        })
        .pipe(Effect.flip);
      yield* check(
        unbound instanceof UnboundVariableError && unbound.variable === "?missing",
        "unbound projections must fail with UnboundVariableError",
      );

      const malformed = yield* t
        .query({ find: ["?entity"], where: "not-an-array" } as never)
        .pipe(Effect.flip);
      yield* check(
        malformed instanceof DatalogValidationError,
        "malformed runtime queries must fail with DatalogValidationError",
      );

      const ambiguousAggregate = yield* t
        .query({
          find: ["?value", "?count"],
          where: [["?entity", ":conf/validation", "?value"]],
          aggregate: [["count", "?value", "?count"]],
        })
        .pipe(Effect.flip);
      yield* check(
        ambiguousAggregate instanceof DatalogValidationError,
        "aggregate inputs projected as group keys must fail validation",
      );

      for (const query of [
        {
          find: ["?value"],
          where: [[42, ":conf/validation", "?value"]],
        },
        {
          find: ["?entity"],
          where: [
            ["?entity", ":conf/validation", "present"],
            ["not", ["?entity", true, "blocked"]],
          ],
        },
        {
          find: ["?entity"],
          where: [
            ["?entity", ":conf/validation", "present"],
            ["or", [["?entity", ":conf/validation", "present", 42]]],
          ],
        },
      ] as const) {
        const invalidIdentity = yield* t.query(query as never).pipe(Effect.flip);
        yield* check(
          invalidIdentity instanceof DatalogValidationError,
          "pattern entity, attribute, and transaction identities must be strings",
        );
      }

      const invalidPage = yield* t
        .queryPage({
          inner: {
            find: ["?entity"],
            where: [["?entity", ":conf/validation", "?value"]],
          },
          filters: [{ column: "?value", op: "=", value: "x" }],
          limit: 10,
        })
        .pipe(Effect.flip);
      yield* check(
        invalidPage instanceof UnboundVariableError && invalidPage.variable === "?value",
        "wrapped filters must reference an inner projected binding",
      );

      const missingOperand = yield* t
        .queryPage({
          inner: {
            find: ["?entity"],
            where: [["?entity", ":conf/validation", "?value"]],
          },
          filters: [{ column: "?entity", op: "=" }],
          limit: 10,
        })
        .pipe(Effect.flip);
      yield* check(
        missingOperand instanceof DatalogValidationError,
        "wrapper operators that compare values must require an operand",
      );

      const orderedEntity = yield* t
        .query({
          find: ["?entity"],
          where: [
            ["?entity", ":conf/validation", "?value"],
            [">", "?entity", "entity:0"],
          ],
        })
        .pipe(Effect.flip);
      yield* check(
        orderedEntity instanceof DatalogValidationError,
        "ordered predicates must reject non-value variables before backend execution",
      );

      const orderedText = yield* t
        .query({
          find: ["?entity"],
          where: [
            ["?entity", ":conf/validation", "?value"],
            [">", "?value", "10"],
          ],
        })
        .pipe(Effect.flip);
      yield* check(
        orderedText instanceof DatalogValidationError,
        "ordered predicates must reject text constants before backend execution",
      );
    }),
  },
  {
    name: "wrapped filters preserve scalar types and SQL null semantics",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        {
          entityId: eid("conf:filter:alice"),
          attribute: ":_schema/type",
          value: string("FilterFixture"),
        },
        {
          entityId: eid("conf:filter:alice"),
          attribute: ":conf/filter-value",
          value: string("Alice"),
        },
        {
          entityId: eid("conf:filter:bob"),
          attribute: ":_schema/type",
          value: string("FilterFixture"),
        },
        {
          entityId: eid("conf:filter:bob"),
          attribute: ":conf/filter-value",
          value: string("Bob"),
        },
        {
          entityId: eid("conf:filter:number"),
          attribute: ":_schema/type",
          value: string("FilterFixture"),
        },
        {
          entityId: eid("conf:filter:number"),
          attribute: ":conf/filter-value",
          value: number(2),
        },
        {
          entityId: eid("conf:filter:number-ten"),
          attribute: ":_schema/type",
          value: string("FilterFixture"),
        },
        {
          entityId: eid("conf:filter:number-ten"),
          attribute: ":conf/filter-value",
          value: number(10),
        },
        {
          entityId: eid("conf:filter:ref"),
          attribute: ":_schema/type",
          value: string("FilterFixture"),
        },
        {
          entityId: eid("conf:filter:ref"),
          attribute: ":conf/filter-value",
          value: ref("scope:one"),
        },
        {
          entityId: eid("conf:filter:boolean"),
          attribute: ":_schema/type",
          value: string("FilterFixture"),
        },
        {
          entityId: eid("conf:filter:boolean"),
          attribute: ":conf/filter-value",
          value: boolean(true),
        },
        {
          entityId: eid("conf:filter:missing"),
          attribute: ":_schema/type",
          value: string("FilterFixture"),
        },
      ]);

      const inner = {
        find: ["?entity", "?value"],
        where: [["?entity", ":_schema/type", "FilterFixture"]],
        optionalProjection: {
          rowBinding: "?entity",
          fields: [{ attribute: ":conf/filter-value", variable: "?value" }],
        },
      } as const;
      const entitiesFor = (results: readonly Record<string, unknown>[]) =>
        results
          .map((row) => row["?entity"])
          .sort()
          .join(",");

      const notAlice = yield* t.queryPage({
        inner,
        filters: [{ column: "?value", op: "!=", value: "Alice" }],
        orderBy: [{ variable: "?entity" }],
      });
      yield* check(
        entitiesFor(notAlice.results) === "conf:filter:bob,conf:filter:ref",
        "negative equality must exclude nulls and incompatible scalar families",
      );

      const notLikeAlice = yield* t.queryPage({
        inner,
        filters: [{ column: "?value", op: "not-like", value: "%li%" }],
        orderBy: [{ variable: "?entity" }],
      });
      yield* check(
        entitiesFor(notLikeAlice.results) === "conf:filter:bob,conf:filter:ref",
        "negative LIKE must exclude nulls and non-text values",
      );

      const numeric = yield* t.queryPage({
        inner,
        filters: [{ column: "?value", op: ">=", value: 10 }],
      });
      yield* check(
        entitiesFor(numeric.results) === "conf:filter:number-ten",
        "numeric filters must use numeric storage rather than flattened text",
      );

      const referenced = yield* t.queryPage({
        inner,
        filters: [{ column: "?value", op: "=", value: ref("scope:one") }],
      });
      yield* check(
        entitiesFor(referenced.results) === "conf:filter:ref",
        "typed wrapper operands must compare against their projected scalar",
      );

      const enabled = yield* t.queryPage({
        inner,
        filters: [{ column: "?value", op: "=", value: true }],
      });
      yield* check(
        entitiesFor(enabled.results) === "conf:filter:boolean",
        "boolean filters must use boolean storage",
      );

      const missing = yield* t.queryPage({
        inner,
        filters: [{ column: "?value", op: "is-null" }],
      });
      yield* check(
        entitiesFor(missing.results) === "conf:filter:missing",
        "is-null must select only absent optional values",
      );
    }),
  },
  {
    name: "Datalog ordering and pagination preserve mixed scalar order",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const fixtures = [
        ["conf:order:number-2", number(2)],
        ["conf:order:datetime-5", datetime(5)],
        ["conf:order:number-10", number(10)],
        ["conf:order:boolean-false", boolean(false)],
        ["conf:order:boolean-true", boolean(true)],
        ["conf:order:string-10", string("10")],
        ["conf:order:string-2", string("2")],
      ] as const;
      yield* t.assertBatch(
        fixtures.flatMap(([entityId, value]) => [
          {
            entityId: eid(entityId),
            attribute: ":_schema/type",
            value: string("OrderFixture"),
          },
          { entityId: eid(entityId), attribute: ":conf/order-value", value },
        ]),
      );
      yield* t.assert({
        entityId: eid("conf:order:missing"),
        attribute: ":_schema/type",
        value: string("OrderFixture"),
      });

      const ascending = yield* t.query({
        find: ["?entity", "?value"],
        where: [["?entity", ":conf/order-value", "?value"]],
        orderBy: [
          { variable: "?value", direction: "asc" },
          { variable: "?entity", direction: "asc" },
        ],
      });
      yield* check(
        ascending.results.map((row) => row["?entity"]).join(",") ===
          [
            "conf:order:number-2",
            "conf:order:datetime-5",
            "conf:order:number-10",
            "conf:order:boolean-false",
            "conf:order:boolean-true",
            "conf:order:string-10",
            "conf:order:string-2",
          ].join(","),
        "direct ordering must compare numeric values numerically and retain scalar-family order",
      );

      const descending = yield* t.query({
        find: ["?entity", "?value"],
        where: [["?entity", ":conf/order-value", "?value"]],
        orderBy: [
          { variable: "?value", direction: "desc" },
          { variable: "?entity", direction: "asc" },
        ],
      });
      yield* check(
        descending.results.map((row) => row["?entity"]).join(",") ===
          [
            "conf:order:number-10",
            "conf:order:datetime-5",
            "conf:order:number-2",
            "conf:order:boolean-true",
            "conf:order:boolean-false",
            "conf:order:string-2",
            "conf:order:string-10",
          ].join(","),
        "descending order must reverse values within each stable scalar family",
      );

      const inner = {
        find: ["?entity", "?value"],
        where: [["?entity", ":_schema/type", "OrderFixture"]],
        optionalProjection: {
          rowBinding: "?entity",
          fields: [{ attribute: ":conf/order-value", variable: "?value" }],
        },
      } as const;
      const pagedEntities: unknown[] = [];
      let cursor: string | undefined;
      do {
        const page = yield* t.queryPage({
          inner,
          orderBy: [{ variable: "?value", direction: "asc" }],
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        pagedEntities.push(...page.results.map((row) => row["?entity"]));
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      yield* check(
        pagedEntities.join(",") ===
          [
            "conf:order:number-2",
            "conf:order:datetime-5",
            "conf:order:number-10",
            "conf:order:boolean-false",
            "conf:order:boolean-true",
            "conf:order:string-10",
            "conf:order:string-2",
            "conf:order:missing",
          ].join(","),
        "keyset pagination must visit mixed typed and null values exactly once",
      );
    }),
  },
  {
    name: "datalog untyped strings match string and ref values while typed refs stay exact",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        {
          entityId: eid("conf:refs:mixed:ref"),
          attribute: ":conf/mixed-value",
          value: ref("conf:refs:mixed:target"),
        },
        {
          entityId: eid("conf:refs:mixed:string"),
          attribute: ":conf/mixed-value",
          value: string("conf:refs:mixed:target"),
        },
      ]);

      const bare = yield* t.query({
        find: ["?entity"],
        where: [["?entity", ":conf/mixed-value", "conf:refs:mixed:target"]],
      });
      const typed = yield* t.query({
        find: ["?entity"],
        where: [["?entity", ":conf/mixed-value", ref("conf:refs:mixed:target")]],
      });
      const bareEntities = bare.results.map((row) => row["?entity"]).sort();
      const typedEntities = typed.results.map((row) => row["?entity"]).sort();

      yield* check(
        JSON.stringify(bareEntities) ===
          JSON.stringify(["conf:refs:mixed:ref", "conf:refs:mixed:string"]),
        "an untyped string should match string and ref values with the same scalar",
      );
      yield* check(
        JSON.stringify(typedEntities) === JSON.stringify(["conf:refs:mixed:ref"]),
        "an explicitly typed ref should match only stored ref values",
      );
    }),
  },
  {
    name: "transact records provenance datoms",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const result = yield* t.transact(
        [
          {
            op: "assert",
            entityId: eid("conf:person:3"),
            attribute: ":age",
            value: { type: "number", value: 30 },
            entityType: "Person",
          },
        ],
        { actor: "conformance-tester" },
      );

      const txTriples = yield* t.match({ entityId: eid(result.txId) });
      const attributes = new Set(txTriples.map((tr) => tr.attribute as string));
      yield* check(
        attributes.has(":_tx/instant"),
        "transact should write a :_tx/instant provenance datom",
      );
      yield* check(
        attributes.has(":_tx/actor"),
        "transact should write a :_tx/actor provenance datom when an actor is given",
      );
    }),
  },
  {
    name: "conditional transactions are atomic and journal their changes",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const current = yield* t.assert({
        entityId: eid("conf:conditional:1"),
        attribute: ":status",
        value: string("open"),
      });
      const committed = yield* t.transact(
        [
          { op: "retract", id: current.id },
          {
            op: "assert",
            entityId: eid("conf:conditional:1"),
            attribute: ":status",
            value: string("claimed"),
          },
        ],
        {
          actor: "conformance-tester",
          commandId: "conf:claim:1",
          preconditions: [{ _tag: "TripleLive", id: current.id }],
        },
      );
      const conflict = yield* t
        .transact(
          [
            { op: "retract", id: current.id },
            {
              op: "assert",
              entityId: eid("conf:conditional:1"),
              attribute: ":status",
              value: string("cancelled"),
            },
          ],
          { preconditions: [{ _tag: "TripleLive", id: current.id }] },
        )
        .pipe(Effect.flip);
      yield* check(
        conflict instanceof TransactionConflictError,
        "a stale compare-and-retract should report TransactionConflictError",
      );
      const statuses = yield* t.match({
        entityId: eid("conf:conditional:1"),
        attribute: ":status",
      });
      yield* check(
        statuses.length === 1 &&
          statuses[0]!.value.type === "string" &&
          statuses[0]!.value.value === "claimed",
        "a rejected stale transaction must not commit any writes",
      );
      const journal = yield* t.transaction(committed.txId);
      yield* check(
        journal?.position === committed.position &&
          journal.commandId === "conf:claim:1" &&
          journal.changes.length === 2,
        "the transaction journal should retain its causal metadata and changes",
      );
      const retraction = journal?.changes.find((change) => change.op === "retract");
      const assertion = journal?.changes.find((change) => change.op === "assert");
      yield* check(
        retraction?.value?.type === "string" &&
          retraction.value.value === "open" &&
          retraction.recordedAt === current.recordedAt &&
          retraction.retractedAt === committed.instant &&
          retraction.retractionTxId === committed.txId,
        "a retraction journal entry must retain the old typed value and both recorded instants",
      );
      yield* check(
        assertion?.value?.type === "string" &&
          assertion.value.value === "claimed" &&
          assertion.validFrom === committed.instant &&
          assertion.assertionTxId === committed.txId,
        "an assertion journal entry must retain its typed value, validity, and asserting transaction",
      );
      const duplicate = yield* t
        .transact(
          [
            {
              op: "assert",
              entityId: eid("conf:conditional:receipt"),
              attribute: ":status",
              value: string("observed"),
            },
          ],
          { commandId: "conf:claim:1" },
        )
        .pipe(Effect.flip);
      yield* check(
        duplicate instanceof CommandAlreadyCommittedError &&
          duplicate.transactionId === committed.txId,
        "a duplicate command must fail with the original durable receipt",
      );
      const receipt = yield* t.transactionByCommand("conf:claim:1");
      yield* check(
        receipt?.txId === committed.txId,
        "command lookup must return the unique durable receipt",
      );
      const duplicateWrites = yield* t.match({ entityId: eid("conf:conditional:receipt") });
      yield* check(duplicateWrites.length === 0, "a duplicate command must commit no writes");

      const races = yield* Effect.all(
        ["left", "right"].map((side) =>
          t
            .transact(
              [
                {
                  op: "assert" as const,
                  entityId: eid(`conf:command-race:${side}`),
                  attribute: ":status",
                  value: string("won"),
                },
              ],
              { commandId: "conf:command-race" },
            )
            .pipe(
              Effect.match({
                onFailure: (error) => ({ _tag: "failed" as const, error }),
                onSuccess: (transaction) => ({ _tag: "committed" as const, transaction }),
              }),
            ),
        ),
        { concurrency: "unbounded" },
      );
      yield* check(
        races.filter((result) => result._tag === "committed").length === 1 &&
          races.filter(
            (result) =>
              result._tag === "failed" && result.error instanceof CommandAlreadyCommittedError,
          ).length === 1,
        "exactly one concurrent execution may claim a command ID",
      );
      const page = yield* t.transactions({ after: committed.position - 1, limit: 1 });
      yield* check(
        page.transactions[0]?.txId === committed.txId && page.next === committed.position,
        "transaction journals should be resumable from an ordered commit position",
      );
    }),
  },
  {
    name: "entity transaction history is indexed, complete, and snapshot-stable",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const subject = eid("conf:entity-history:subject");
      const unrelated = eid("conf:entity-history:unrelated");
      const asserted = yield* t.transact(
        [
          {
            op: "assert",
            entityId: subject,
            entityType: "HistorySubject",
            attribute: ":history/name",
            value: string("before"),
          },
          {
            op: "assert",
            entityId: subject,
            entityType: "HistorySubject",
            attribute: ":history/state",
            value: string("open"),
          },
        ],
        {
          actor: "history:actor",
          commandId: "conf:entity-history:create",
          correlationId: "history:correlation",
          causationId: "history:causation",
          configSnapshot: "history:config:v1",
        },
      );
      const unrelatedTransaction = yield* t.transact([
        {
          op: "assert",
          entityId: unrelated,
          attribute: ":history/name",
          value: string("unrelated"),
        },
      ]);
      const corrected = yield* t.transact(
        [
          { op: "retract", id: asserted.triples[0]!.id },
          {
            op: "assert",
            entityId: subject,
            entityType: "HistorySubject",
            attribute: ":history/name",
            value: string("after"),
          },
        ],
        { actor: "history:reviewer", configSnapshot: "history:config:v2" },
      );

      const first = yield* t.transactionsForEntity(subject, { limit: 1 });
      yield* check(
        first.transactions.length === 1 &&
          first.transactions[0]?.txId === corrected.txId &&
          first.transactions[0].changes.some(
            (change) =>
              change.op === "retract" &&
              change.value?.type === "string" &&
              change.value.value === "before",
          ) &&
          first.transactions[0].changes.some(
            (change) =>
              change.op === "assert" &&
              change.value?.type === "string" &&
              change.value.value === "after",
          ) &&
          first.nextBeforePosition === corrected.position,
        "the newest entity transaction should include complete assertion and retraction changes",
      );

      const concurrent = yield* t.transact([
        {
          op: "assert",
          entityId: subject,
          attribute: ":history/concurrent",
          value: string("later"),
        },
      ]);
      const second = yield* t.transactionsForEntity(subject, {
        limit: 1,
        snapshotPosition: first.snapshotPosition,
        beforePosition: first.nextBeforePosition!,
      });
      yield* check(
        second.transactions.length === 1 &&
          second.transactions[0]?.txId === asserted.txId &&
          second.transactions[0].changes.length === 2 &&
          second.nextBeforePosition === undefined &&
          ![...first.transactions, ...second.transactions].some(
            (transaction) =>
              transaction.txId === unrelatedTransaction.txId ||
              transaction.txId === concurrent.txId,
          ),
        "continuation should deduplicate multi-change commits and exclude unrelated or later commits",
      );
      const create = second.transactions[0];
      yield* check(
        create?.actor === "history:actor" &&
          create.commandId === "conf:entity-history:create" &&
          create.correlationId === "history:correlation" &&
          create.causationId === "history:causation" &&
          create.configSnapshot === "history:config:v1",
        "entity history should preserve the complete causal envelope",
      );

      const unknown = yield* t.transactionsForEntity(eid("conf:entity-history:missing"));
      yield* check(
        unknown.transactions.length === 0,
        "an unknown entity should have an empty transaction history",
      );
      const malformed = yield* t.transactionsForEntity(subject, { limit: 0 }).pipe(Effect.flip);
      yield* check(
        malformed._tag === "ReadError",
        "malformed entity-history pagination should fail in the typed error channel",
      );
    }),
  },
  {
    name: "graph constraints reject invalid post-states across valid time",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const definitions = [
        GraphConstraint.required("ConfConstraintPerson", ":conf/constraint-name"),
        GraphConstraint.cardinality("ConfConstraintPerson", ":conf/constraint-name", 1),
        GraphConstraint.unique("ConfConstraintPerson", ":conf/constraint-email"),
        GraphConstraint.referenceTarget(
          "ConfConstraintPerson",
          ":conf/constraint-employer",
          "ConfConstraintEmployer",
        ),
      ];
      const meta = {
        configSnapshot: "sha256:conformance-constraints",
        enforce: GraphConstraint.enforcement(definitions),
      };

      const position = yield* t.currentPosition();
      const missingRequired = yield* t
        .transact(
          [
            {
              op: "assert",
              entityId: eid("conf:constraint:missing-name"),
              entityType: "ConfConstraintPerson",
              attribute: ":conf/constraint-email",
              value: string("missing@example.com"),
            },
          ],
          meta,
        )
        .pipe(Effect.flip);
      yield* check(
        missingRequired instanceof ConstraintViolationError &&
          missingRequired.violations.some((violation) => violation.code === "required"),
        "a missing required fact should produce ConstraintViolationError",
      );
      yield* check(
        (yield* t.currentPosition()) === position &&
          (yield* t.match({ entityId: eid("conf:constraint:missing-name") })).length === 0,
        "constraint rejection must roll back facts, journal, and commit position",
      );

      const seeded = yield* t.transact(
        [
          {
            op: "assert",
            entityId: eid("conf:constraint:employer"),
            entityType: "ConfConstraintEmployer",
            attribute: ":conf/constraint-name",
            value: string("Acme"),
            validFrom: 100,
            validTo: 300,
          },
          ...["one", "two"].flatMap((suffix) => [
            {
              op: "assert" as const,
              entityId: eid(`conf:constraint:${suffix}`),
              entityType: "ConfConstraintPerson",
              attribute: ":conf/constraint-name",
              value: string(suffix),
              validFrom: 100,
              validTo: 300,
            },
            {
              op: "assert" as const,
              entityId: eid(`conf:constraint:${suffix}`),
              entityType: "ConfConstraintPerson",
              attribute: ":conf/constraint-email",
              value: string("shared@example.com"),
              validFrom: suffix === "one" ? 100 : 200,
              validTo: suffix === "one" ? 200 : 300,
            },
            {
              op: "assert" as const,
              entityId: eid(`conf:constraint:${suffix}`),
              entityType: "ConfConstraintPerson",
              attribute: ":conf/constraint-employer",
              value: ref("conf:constraint:employer"),
              validFrom: 100,
              validTo: 300,
            },
          ]),
        ],
        meta,
      );
      const journal = yield* t.transaction(seeded.txId);
      yield* check(
        journal?.configSnapshot === meta.configSnapshot,
        "a constrained transaction should journal the exact pinned config snapshot",
      );

      const futureOverlap = yield* t
        .transact(
          [
            {
              op: "assert",
              entityId: eid("conf:constraint:three"),
              entityType: "ConfConstraintPerson",
              attribute: ":conf/constraint-name",
              value: string("three"),
              validFrom: 150,
              validTo: 250,
            },
            {
              op: "assert",
              entityId: eid("conf:constraint:three"),
              entityType: "ConfConstraintPerson",
              attribute: ":conf/constraint-email",
              value: string("shared@example.com"),
              validFrom: 150,
              validTo: 250,
            },
          ],
          meta,
        )
        .pipe(Effect.flip);
      yield* check(
        futureOverlap instanceof ConstraintViolationError &&
          futureOverlap.violations.some(
            (violation) => violation.code === "unique" && violation.validAt === 150,
          ),
        "future interval overlap should be rejected even when it is not valid now",
      );

      const races = yield* Effect.all(
        ["left", "right"].map((side) =>
          t
            .transact(
              [
                {
                  op: "assert" as const,
                  entityId: eid(`conf:constraint:race:${side}`),
                  entityType: "ConfConstraintPerson",
                  attribute: ":conf/constraint-name",
                  value: string(side),
                },
                {
                  op: "assert" as const,
                  entityId: eid(`conf:constraint:race:${side}`),
                  entityType: "ConfConstraintPerson",
                  attribute: ":conf/constraint-email",
                  value: string("race@example.com"),
                },
              ],
              meta,
            )
            .pipe(
              Effect.match({
                onFailure: (error) => ({ _tag: "failed" as const, error }),
                onSuccess: (transaction) => ({ _tag: "committed" as const, transaction }),
              }),
            ),
        ),
        { concurrency: "unbounded" },
      );
      yield* check(
        races.filter((result) => result._tag === "committed").length === 1 &&
          races.filter(
            (result) =>
              result._tag === "failed" && result.error instanceof ConstraintViolationError,
          ).length === 1,
        "serialized constraint evaluation must admit exactly one concurrent unique claimant",
      );
    }),
  },
  {
    name: "dependency state is attribute-scoped and schedules temporal edges",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const attribute = ":conf-dependency/status";
      const future = yield* t.transact([
        {
          op: "assert",
          entityId: eid("conf:dependency:future"),
          attribute,
          value: string("scheduled"),
          validFrom: 500,
          validTo: 800,
        },
      ]);
      const expiring = yield* t.transact([
        {
          op: "assert",
          entityId: eid("conf:dependency:expiring"),
          attribute,
          value: string("active"),
          validFrom: 50,
          validTo: 300,
        },
      ]);
      yield* t.transact([
        {
          op: "assert",
          entityId: eid("conf:dependency:unrelated"),
          attribute: ":conf-dependency/unrelated",
          value: string("ignored"),
        },
      ]);

      const initial = yield* t.dependencyState([attribute, attribute], { validAt: 100 });
      yield* check(
        initial.sourcePosition === expiring.position && initial.nextTemporalBoundary === 300,
        "dependency state should deduplicate attributes, ignore unrelated commits, and choose the earliest edge",
      );

      const retractFuture = yield* t.transact([{ op: "retract", id: future.triples[0]!.id }]);
      const withoutFuture = yield* t.dependencyState([attribute], { validAt: 100 });
      yield* check(
        withoutFuture.sourcePosition === retractFuture.position &&
          withoutFuture.nextTemporalBoundary === 300,
        "a retraction should advance freshness and remove the retracted fact's schedule",
      );

      const retractExpiring = yield* t.transact([{ op: "retract", id: expiring.triples[0]!.id }]);
      const empty = yield* t.dependencyState([attribute], { validAt: 100 });
      yield* check(
        empty.sourcePosition === retractExpiring.position &&
          empty.nextTemporalBoundary === undefined,
        "a dependency with only retracted facts should retain its change position but no wakeup",
      );
      yield* check(
        JSON.stringify(yield* t.dependencyState([], { validAt: 100 })) ===
          JSON.stringify({ sourcePosition: 0 }),
        "an empty dependency set should have a stable empty state",
      );
    }),
  },
  {
    name: "derivation materialization uses indexed dependency freshness",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const definition = yield* Derivation.make({
        name: "conf.dependency.projection",
        configSnapshot: "conf:config:dependency-v1",
        identity: ["?entity"],
        query: {
          find: ["?entity", "?status"],
          where: [["?entity", ":conf-projection/status", "?status"]],
        },
      });
      yield* check(
        (yield* Derivation.Materialization.current(t, definition, { basis: { validAt: 100 } }))
          .status === "unmaterialized",
        "a new indexed projection should be explicitly unmaterialized",
      );

      yield* t.assert({
        entityId: eid("conf:projection:current"),
        attribute: ":conf-projection/status",
        value: string("ready"),
        validFrom: 50,
      });
      const first = yield* Derivation.Materialization.materialize(t, definition, {
        basis: { validAt: 100 },
      });
      yield* check(
        first.candidates.length === 1 && first.nextTemporalBoundary === undefined,
        "the first indexed materialization should persist its current candidate",
      );

      yield* t.assert({
        entityId: eid("conf:projection:unrelated"),
        attribute: ":conf-projection/note",
        value: string("ignored"),
      });
      yield* check(
        (yield* Derivation.Materialization.current(t, definition, { basis: { validAt: 100 } }))
          .status === "current",
        "an unrelated attribute must not stale an indexed projection",
      );

      yield* t.assert({
        entityId: eid("conf:projection:future"),
        attribute: ":conf-projection/status",
        value: string("scheduled"),
        validFrom: 500,
      });
      yield* check(
        (yield* Derivation.Materialization.current(t, definition, { basis: { validAt: 100 } }))
          .status === "stale",
        "a relevant future-effective assertion must stale the projection",
      );
      const refreshed = yield* Derivation.Materialization.materialize(t, definition, {
        basis: { validAt: 100 },
      });
      yield* check(
        refreshed.candidates.length === 1 && refreshed.nextTemporalBoundary === 500,
        "refresh should retain current results and persist the future wakeup",
      );
    }),
  },
  {
    name: "graph constraints agree across storage backends",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        {
          entityId: eid("conf:user:alice"),
          entityType: "ConfUser",
          attribute: ":conf-user/email",
          value: string("shared@example.test"),
        },
        {
          entityId: eid("conf:user:bob"),
          entityType: "ConfUser",
          attribute: ":conf-user/email",
          value: string("shared@example.test"),
        },
        {
          entityId: eid("conf:user:future"),
          entityType: "ConfUser",
          attribute: ":conf-user/email",
          value: string("shared@example.test"),
          validFrom: 9_000_000_000_000,
        },
        {
          entityId: eid("conf:group:valid"),
          entityType: "ConfGroup",
          attribute: ":conf-group/name",
          value: string("Valid group"),
        },
        {
          entityId: eid("conf:membership:missing"),
          entityType: "ConfMembership",
          attribute: ":conf-membership/note",
          value: string("missing group"),
        },
        {
          entityId: eid("conf:membership:multi"),
          entityType: "ConfMembership",
          attribute: ":conf-membership/group",
          value: ref("conf:group:valid"),
        },
        {
          entityId: eid("conf:membership:multi"),
          entityType: "ConfMembership",
          attribute: ":conf-membership/group",
          value: ref("conf:group:missing"),
        },
      ]);

      const violations = yield* GraphConstraint.evaluate(t, [
        GraphConstraint.unique("ConfUser", ":conf-user/email"),
        GraphConstraint.required("ConfMembership", ":conf-membership/group"),
        GraphConstraint.cardinality("ConfMembership", ":conf-membership/group", 1),
        GraphConstraint.referenceTarget("ConfMembership", ":conf-membership/group", "ConfGroup"),
      ]);
      yield* check(
        JSON.stringify(
          violations.map(({ entityType, subject, code }) => `${entityType}|${subject}|${code}`),
        ) ===
          JSON.stringify([
            "ConfMembership|conf:membership:missing|required",
            "ConfMembership|conf:membership:multi|cardinality",
            "ConfMembership|conf:membership:multi|reference-target",
            "ConfUser|conf:user:alice|unique",
            "ConfUser|conf:user:bob|unique",
          ]),
        "required, cardinality, reference-target, and uniqueness observations should agree",
      );
      const futureViolations = yield* GraphConstraint.evaluate(
        t,
        [GraphConstraint.unique("ConfUser", ":conf-user/email")],
        { validAt: 9_000_000_000_000 },
      );
      yield* check(
        futureViolations.length === 3 &&
          futureViolations.some(({ subject }) => subject === "conf:user:future"),
        "constraint evaluation should apply one explicit bitemporal basis to the graph",
      );
    }),
  },
  {
    name: "consumer checkpoints advance atomically and remain queryable",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const consumer = "conf:consumer:projection";
      yield* check(
        (yield* ConsumerCheckpoint.get(t, consumer)) === null,
        "a new consumer must start without a checkpoint",
      );

      const source = yield* t.transact(
        [
          {
            op: "assert",
            entityId: eid("conf:checkpoint:source"),
            attribute: ":status",
            value: string("ready"),
          },
        ],
        { commandId: "conf:checkpoint:source" },
      );

      const initial = yield* ConsumerCheckpoint.advance(t, {
        consumer,
        expectedPosition: 0,
        nextPosition: source.position,
        meta: { actor: "conformance-worker" },
      });
      yield* check(
        initial.position === source.position,
        "the first checkpoint should retain the processed source position",
      );

      const candidates = yield* Effect.all(
        ["left", "right"].map((side) =>
          t.transact(
            [
              {
                op: "assert" as const,
                entityId: eid(`conf:checkpoint:${side}`),
                attribute: ":status",
                value: string("ready"),
              },
            ],
            { commandId: `conf:checkpoint:${side}` },
          ),
        ),
      );

      const races = yield* Effect.all(
        candidates.map(({ position: nextPosition }) =>
          ConsumerCheckpoint.advance(t, {
            consumer,
            expectedPosition: source.position,
            nextPosition,
          }).pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: "failed" as const, error }),
              onSuccess: (checkpoint) => ({ _tag: "advanced" as const, checkpoint }),
            }),
          ),
        ),
        { concurrency: "unbounded" },
      );
      yield* check(
        races.filter((result) => result._tag === "advanced").length === 1 &&
          races.filter(
            (result) =>
              result._tag === "failed" &&
              result.error instanceof ConsumerCheckpoint.ConsumerCheckpointConflictError,
          ).length === 1,
        "exactly one worker may advance a checkpoint from the same source position",
      );

      const current = yield* ConsumerCheckpoint.get(t, consumer);
      const feed = yield* t.transactions({ after: source.position, limit: 10 });
      const { results } = yield* t.query({
        find: ["?position"],
        where: [
          ["?checkpoint", ConsumerCheckpoint.System.attribute.consumer, consumer],
          ["?checkpoint", ConsumerCheckpoint.System.attribute.position, "?position"],
        ],
      });
      yield* check(
        current !== null &&
          candidates.some((candidate) => candidate.position === current.position) &&
          feed.transactions.length === 2 &&
          results.length === 1 &&
          results[0]?.["?position"] === current.position,
        "the checkpoint should be queryable without recursively appearing in its own feed",
      );
    }),
  },
  {
    name: "retractByPattern respects entityType",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        {
          entityId: eid("conf:typed-retract:person"),
          attribute: ":name",
          value: string("Person"),
          entityType: "Person",
        },
        {
          entityId: eid("conf:typed-retract:robot"),
          attribute: ":name",
          value: string("Robot"),
          entityType: "Robot",
        },
      ]);

      const retracted = yield* t.retractByPattern({ entityType: "Person" });
      const person = yield* t.match({ entityId: eid("conf:typed-retract:person") });
      const robot = yield* t.match({ entityId: eid("conf:typed-retract:robot") });
      yield* check(retracted >= 1, "entityType retraction should retract matching facts");
      yield* check(person.length === 0, "entityType retraction should remove matching facts");
      yield* check(robot.length === 1, "entityType retraction must preserve other entity types");

      yield* t.assertBatch([
        {
          entityId: eid("conf:typed-retract:transaction-person"),
          attribute: ":name",
          value: string("Person"),
          entityType: "TransactionPerson",
        },
        {
          entityId: eid("conf:typed-retract:transaction-robot"),
          attribute: ":name",
          value: string("Robot"),
          entityType: "TransactionRobot",
        },
      ]);
      yield* t.transact([{ op: "retract-pattern", pattern: { entityType: "TransactionPerson" } }]);
      const transactionRobot = yield* t.match({
        entityId: eid("conf:typed-retract:transaction-robot"),
      });
      yield* check(
        transactionRobot.length === 1,
        "transaction retract-pattern must preserve other entity types",
      );
    }),
  },
  {
    name: "reserved Triplex namespaces reject ordinary writes atomically",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const reservedInputs = [
        {
          entityId: eid("_triplex/application/forbidden"),
          attribute: ":name",
          value: string("reserved entity"),
        },
        {
          entityId: eid("conf:reserved:attribute"),
          attribute: ":triplex/config-data",
          value: string("reserved attribute"),
        },
        {
          entityId: eid("conf:reserved:type"),
          attribute: ":name",
          value: string("reserved type"),
          entityType: "triplex.config-object",
        },
      ] as const;

      for (const input of reservedInputs) {
        const failure = yield* t.assert(input).pipe(Effect.flip);
        yield* check(
          failure.message.includes("reserved Triplex system namespace"),
          "reserved writes should fail with an explicit namespace error",
        );
      }

      const batchFailure = yield* t
        .assertBatch([
          {
            entityId: eid("conf:reserved:batch-application"),
            attribute: ":name",
            value: string("must roll back"),
          },
          reservedInputs[0],
        ])
        .pipe(Effect.flip);
      yield* check(
        batchFailure.message.includes("reserved Triplex system namespace"),
        "a mixed batch should reject its reserved member",
      );
      yield* check(
        (yield* t.match({ entityId: eid("conf:reserved:batch-application") })).length === 0,
        "a rejected mixed batch must not write its application facts",
      );

      const transactionFailure = yield* t
        .transact([
          {
            op: "assert",
            entityId: eid("conf:reserved:transaction-application"),
            attribute: ":name",
            value: string("must roll back"),
          },
          {
            op: "assert",
            entityId: eid("_triplex/application/transaction-forbidden"),
            attribute: ":name",
            value: string("reserved"),
          },
        ])
        .pipe(Effect.flip);
      yield* check(
        transactionFailure.message.includes("reserved Triplex system namespace"),
        "a mixed transaction should reject its reserved member",
      );
      yield* check(
        (yield* t.match({ entityId: eid("conf:reserved:transaction-application") })).length === 0,
        "a rejected mixed transaction must not write its application facts",
      );
    }),
  },
  {
    name: "transaction journals cannot be retracted through ordinary writes",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const committed = yield* t.transact([
        {
          op: "assert",
          entityId: eid("conf:reserved:journal-subject"),
          attribute: ":name",
          value: string("journalled"),
        },
      ]);
      const journalFacts = yield* t.match({ entityId: eid(committed.txId) });
      const instant = journalFacts.find((triple) => triple.attribute === ":_tx/instant");
      yield* check(instant !== undefined, "a committed transaction should have a journal instant");

      const retractFailure = yield* t.retract(instant!.id).pipe(Effect.flip);
      yield* check(
        retractFailure.message.includes("reserved Triplex system namespace"),
        "direct retraction must not mutate the transaction journal",
      );
      const patternFailure = yield* t
        .retractByPattern({ entityType: "_Transaction" })
        .pipe(Effect.flip);
      yield* check(
        patternFailure.message.includes("reserved Triplex system namespace"),
        "pattern retraction must not mutate transaction journals",
      );
      yield* check(
        (yield* t.match({ entityId: eid(committed.txId) })).length === journalFacts.length,
        "rejected journal mutations must preserve every journal fact",
      );
    }),
  },
  {
    name: "direct and Datalog reads share one bitemporal basis",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const old = yield* t.assert({
        entityId: eid("conf:temporal:policy"),
        attribute: ":conf/status",
        value: string("draft"),
        validFrom: 1_000,
        validTo: 2_000,
      });
      yield* t.assert({
        entityId: eid("conf:temporal:policy"),
        attribute: ":conf/status",
        value: string("active"),
        validFrom: 2_000,
      });

      const atDraft = yield* t.match(
        { entityId: eid("conf:temporal:policy"), attribute: ":conf/status" },
        { validAt: 1_500 },
      );
      const atActive = yield* t.query(
        {
          find: ["?status"],
          where: [["conf:temporal:policy", ":conf/status", "?status"]],
        },
        { basis: { validAt: 2_500 } },
      );
      yield* check(
        atDraft.length === 1 && atDraft[0]?.id === old.id,
        "direct reads must apply the valid-time interval",
      );
      yield* check(
        atActive.results.length === 1 && atActive.results[0]?.["?status"] === "active",
        "Datalog must apply the same valid-time interval",
      );
    }),
  },
  {
    name: "historical corrections preserve what was previously recorded",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const original = yield* t.assert({
        entityId: eid("conf:temporal:correction"),
        attribute: ":conf/name",
        value: string("Orignal"),
        validFrom: 1_000,
      });
      yield* Effect.sleep("2 millis");
      yield* t.transact([
        { op: "retract", id: original.id },
        {
          op: "assert",
          entityId: eid("conf:temporal:correction"),
          attribute: ":conf/name",
          value: string("Original"),
          validFrom: 1_000,
        },
      ]);

      const beforeCorrection = yield* t.match(
        { entityId: eid("conf:temporal:correction"), attribute: ":conf/name" },
        { recordedAt: original.recordedAt, validAt: 1_500 },
      );
      const currentKnowledge = yield* t.match(
        { entityId: eid("conf:temporal:correction"), attribute: ":conf/name" },
        { validAt: 1_500 },
      );
      yield* check(
        beforeCorrection[0]?.value.type === "string" &&
          beforeCorrection[0].value.value === "Orignal",
        "recorded-time history must expose the value known before correction",
      );
      yield* check(
        currentKnowledge[0]?.value.type === "string" &&
          currentKnowledge[0].value.value === "Original",
        "current knowledge must expose the corrected historical value",
      );
    }),
  },
  {
    name: "batch entity reads preserve association, missing entries, and temporal basis",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      yield* t.assertBatch([
        {
          entityId: eid("conf:batch:first"),
          attribute: ":conf/name",
          value: string("First"),
          validFrom: 1_000,
        },
        {
          entityId: eid("conf:batch:future"),
          attribute: ":conf/name",
          value: string("Future"),
          validFrom: 3_000,
        },
      ]);
      const rows = yield* t.entities(
        ["conf:batch:first", "conf:batch:missing", "conf:batch:future"] as EntityId[],
        { validAt: 2_000 },
      );
      yield* check(rows.length === 3, "batch reads must preserve request association");
      yield* check(rows[0]?.length === 1, "the first entity should be materialized");
      yield* check(rows[1]?.length === 0, "missing entities should have an empty result");
      yield* check(rows[2]?.length === 0, "future facts must respect the batch temporal basis");
    }),
  },
  {
    name: "retract is coherent across write and datalog paths",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const triple = yield* t.assert({
        entityId: eid("conf:coherence:1"),
        attribute: ":flag",
        value: { type: "boolean", value: true },
        entityType: "Widget",
      });

      // Retract via the write path, then immediately read via the Datalog path.
      // If the two paths shared a stale cache this would still see the fact.
      yield* t.retract(triple.id);

      const { results } = yield* t.query({
        find: ["?e"],
        where: [["?e", ":flag", true]],
      });
      const entities = results.map((r) => r["?e"]);
      yield* check(
        !entities.includes("conf:coherence:1"),
        "datalog query must not see a fact retracted via the write path",
      );

      const matched = yield* t.match({ entityId: eid("conf:coherence:1"), attribute: ":flag" });
      yield* check(matched.length === 0, "match must not see the retracted fact either");
    }),
  },
  {
    name: "paged queries use deterministic snapshot-stable cursors",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const seeded = yield* t.assertBatch([
        {
          entityId: eid("conf:page:1"),
          attribute: ":conf/page-rank",
          value: number(1),
        },
        {
          entityId: eid("conf:page:2"),
          attribute: ":conf/page-rank",
          value: number(1),
        },
        {
          entityId: eid("conf:page:3"),
          attribute: ":conf/page-rank",
          value: number(1),
        },
        {
          entityId: eid("conf:page:4"),
          attribute: ":conf/page-rank",
          value: number(2),
        },
      ]);
      const request = {
        inner: {
          find: ["?entity", "?rank"],
          where: [["?entity", ":conf/page-rank", "?rank"]],
        },
        orderBy: [{ variable: "?rank" as const, direction: "asc" as const }],
        limit: 2,
        includeCount: true,
      } as const;

      const first = yield* t.queryPage(request);
      yield* check(
        first.results.map((row) => row["?entity"]).join(",") === "conf:page:1,conf:page:2",
        "equal primary values must use the projected row as a deterministic tie-breaker",
      );
      yield* check(first.totalCount === 4, "the first page should report the full count");
      yield* check(first.nextCursor !== undefined, "a non-final page must return a cursor");

      // Deliberately mutate immediately: recorded milliseconds may be equal,
      // so snapshot stability must come from the atomic commit position.
      yield* t.assert({
        entityId: eid("conf:page:later"),
        attribute: ":conf/page-rank",
        value: number(0),
      });
      yield* t.retract(seeded[2]!.id);

      const second = yield* t.queryPage({ ...request, cursor: first.nextCursor });
      yield* check(
        second.results.map((row) => row["?entity"]).join(",") === "conf:page:3,conf:page:4",
        "later assertions and retractions must not alter the cursor's recorded snapshot",
      );
      yield* check(second.totalCount === 4, "every page should retain the snapshot count");
      yield* check(second.nextCursor === undefined, "the final page must not return a cursor");

      const malformed = yield* t
        .queryPage({ ...request, cursor: "not-a-cursor" })
        .pipe(Effect.flip);
      yield* check(
        malformed._tag === "PaginationCursorError",
        "malformed cursors must fail through the typed error channel",
      );
    }),
  },
];

/**
 * Build the full conformance suite as one `Effect` requiring a `Triples`
 * service. Provide a backend's `Layer<Triples>` and run it:
 *
 * ```ts
 * await Effect.runPromise(
 *   makeTriplesConformanceSuite().pipe(Effect.provide(KvTriples.layer), Effect.scoped),
 * )
 * ```
 */
export const makeTriplesConformanceSuite = (): Effect.Effect<void, unknown, Triples> =>
  Effect.forEach(triplesConformanceCases, (c) => c.run, { discard: true });
