import { attributesOf, checkAttributes } from "@triplex-build/triplex/datalog";
import { extractDependencies } from "@triplex-build/triplex/subscriptions";
import * as Derivation from "@triplex-build/triplex/derivation";
/** Approved Datalog time contract. Shared unchanged by KV, SQLite and PostgreSQL. */
import { Effect } from "effect";
import {
  Triples,
  DatalogValidationError,
  diagnose,
  string,
  EntityId,
  type DatalogQuery,
} from "@triplex-build/triplex";
import type { ConformanceCase } from "./index.js";

const J = Date.UTC(2026, 0, 1),
  F = Date.UTC(2026, 1, 1),
  M = Date.UTC(2026, 2, 1);
const E = Date.UTC(2026, 2, 20),
  C = Date.UTC(2026, 2, 31),
  A = Date.UTC(2026, 3, 1),
  Y = Date.UTC(2026, 4, 1);
const check = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new Error(message));
const canonical = (_key: string, value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    : value;
const rows = (actual: unknown, expected: unknown) =>
  check(
    JSON.stringify(actual, canonical) === JSON.stringify(expected, canonical),
    `Datalog time rows: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
const fixture = (suffix: string) =>
  Effect.gen(function* () {
    const t = yield* Triples;
    const prefix = `conf:time:${suffix}:`;
    const op = (entity: string, attribute: string, from: number, to?: number) => ({
      op: "assert" as const,
      entityId: EntityId.make(prefix + entity),
      attribute,
      value: string("approved"),
      validFrom: from,
      ...(to === undefined ? {} : { validTo: to }),
    });
    const first = yield* t.transact(
      [
        op("vendor", ":time/vendor", J, F),
        op("vendor", ":time/vendor", M),
        op("finite", ":time/exception", J, E),
        op("open", ":time/exception", J),
      ],
      { actor: "user:pat" },
    );
    const second = yield* t.transact([op("review", ":time/review", F, A)], { actor: "user:lee" });
    const third = yield* t.transact(
      [{ op: "retract", id: second.triples[0]!.id }, op("review", ":time/review", F, Y)],
      { actor: "user:kim" },
    );
    const interval = {
      pattern: [prefix + "vendor", ":time/vendor", "approved"],
      valid: { from: "?start", to: "?end" },
    } as const;
    const all = {
      validTime: "all",
      find: ["?start", "?end"],
      where: [interval],
      orderBy: [{ variable: "?start" }],
    } as const;
    return { t, prefix, first, second, third, interval, all };
  });

export const datalogTimeConformanceCases: readonly ConformanceCase[] = [
  {
    name: "time: fractional assertion and pattern bounds fail without mutations",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const input = {
        entityId: EntityId.make("conf:time:invalid-fraction"),
        attribute: ":time/integer",
        value: string("yes"),
      };
      for (const field of ["validFrom", "validTo"] as const) {
        for (const write of [
          t.assert({ ...input, [field]: 1.5 }),
          t.assertBatch([{ ...input, [field]: 1.5 }]),
          t.transact([{ op: "assert", ...input, [field]: 1.5 }]),
        ]) {
          const result = yield* Effect.result<unknown, unknown, never>(write);
          yield* check(
            result._tag === "Failure" && diagnose(result.failure).code === "time.invalid-bound",
            "fractional writes must fail with time.invalid-bound",
          );
        }
      }
      for (const valid of [{ from: 1.5 }, { to: 2.5 }]) {
        const query = {
          find: ["?e"],
          where: [{ pattern: ["?e", input.attribute, "yes"], valid }],
        } as const;
        for (const read of [t.queryAll(query), t.queryPage({ inner: query }), t.explain(query)]) {
          const result = yield* Effect.result<unknown, unknown, never>(read);
          yield* check(
            result._tag === "Failure" && diagnose(result.failure).code === "time.invalid-bound",
            "fractional interval literals must fail with time.invalid-bound",
          );
        }
      }
      yield* rows(yield* t.history(input.entityId), []);
    }),
  },
  {
    name: "time: worked expiry, provenance trap, and disjoint vendor intervals",
    run: Effect.gen(function* () {
      const { t, prefix, first, second, third, all } = yield* fixture("worked");
      yield* rows(
        (yield* t.queryAll(
          {
            find: ["?e", "?end"],
            where: [
              { pattern: ["?e", ":time/exception", "approved"], valid: { to: "?end" } },
              [">", "?end", M],
              ["<=", "?end", C],
            ],
            orderBy: [{ variable: "?end" }],
          },
          { basis: { recordedPosition: third.position, validAt: M } },
        )).results.filter((row) => row["?e"] === prefix + "finite"),
        [{ "?e": prefix + "finite", "?end": E }],
      );
      const provenance = {
        find: ["?actor", "?tx"],
        where: [
          [prefix + "review", ":time/review", "approved", "?tx"],
          ["?tx", ":_tx/actor", "?actor"],
        ],
      } as const;
      yield* rows(
        (yield* t.queryAll(provenance, { basis: { recordedPosition: first.position, validAt: M } }))
          .results,
        [],
      );
      yield* rows(
        (yield* t.queryAll(provenance, {
          basis: { recordedPosition: second.position, validAt: M },
        })).results,
        [{ "?actor": "user:lee", "?tx": second.txId }],
      );
      yield* rows(
        (yield* t.queryAll(provenance, { basis: { recordedPosition: third.position, validAt: M } }))
          .results,
        [{ "?actor": "user:kim", "?tx": third.txId }],
      );
      yield* rows(
        (yield* t.queryAll(all, { basis: { recordedPosition: third.position } })).results,
        [
          { "?start": J, "?end": F },
          { "?start": M, "?end": null },
        ],
      );
      yield* rows((yield* t.queryAll(all, { basis: { recordedPosition: 0 } })).results, []);
      yield* rows((yield* t.queryAll(all, { basis: { recordedAt: third.instant } })).results, [
        { "?start": J, "?end": F },
        { "?start": M, "?end": null },
      ]);
    }),
  },
  {
    name: "time: literal bounds, half-open membership, null predicates, and repeated variables",
    run: Effect.gen(function* () {
      const { t, all, interval, prefix } = yield* fixture("bounds");
      for (const [point, expected] of [
        [J, [{ "?start": J, "?end": F }]],
        [F, []],
        [M, [{ "?start": M, "?end": null }]],
      ] as const) {
        yield* rows(
          (yield* t.queryAll({ ...all, validTime: "point" }, { basis: { validAt: point } }))
            .results,
          expected,
        );
      }
      for (const [predicate, expected] of [
        [["=", "?end", null], [{ "?start": M, "?end": null }]],
        [["!=", "?end", null], [{ "?start": J, "?end": F }]],
        [[">", "?end", C], []],
        [["<=", "?end", F], [{ "?start": J, "?end": F }]],
      ] as const) {
        yield* rows(
          (yield* t.queryAll({ ...all, where: [predicate, interval] })).results,
          expected,
        );
      }
      yield* rows(
        (yield* t.queryAll({
          validTime: "all",
          find: ["yes"],
          where: [{ ...interval, valid: { from: J, to: F } }],
        })).results,
        [{ yes: "yes" }],
      );
      yield* rows(
        (yield* t.queryAll({
          validTime: "all",
          find: ["?same"],
          where: [{ ...interval, valid: { from: "?same", to: "?same" } }],
        })).results,
        [],
      );
      yield* rows(
        (yield* t.queryAll({
          validTime: "all",
          find: ["?end"],
          where: [
            { ...interval, valid: { to: "?end" } },
            { pattern: [prefix + "vendor", ":time/vendor", "approved"], valid: { to: "?end" } },
          ],
        })).results.toSorted((a, b) => Number(a["?end"] === null) - Number(b["?end"] === null)),
        [{ "?end": F }, { "?end": null }],
      );
    }),
  },
  {
    name: "time: local negation, disjunction, tuple all-time joins and rule mode",
    run: Effect.gen(function* () {
      const { t, prefix, all, interval } = yield* fixture("clauses");
      yield* rows(
        (yield* t.queryAll({
          ...all,
          where: [
            interval,
            [
              "not",
              ["<=", "?other", F],
              { pattern: [prefix + "vendor", ":time/vendor", "approved"], valid: { to: "?other" } },
            ],
          ],
        })).results,
        [],
      );
      yield* rows(
        (yield* t.queryAll({
          ...all,
          where: [
            interval,
            [
              "or",
              [
                ["=", "?end", null],
                { pattern: [prefix + "vendor", ":time/vendor", "approved"], valid: { to: "?end" } },
              ],
            ],
          ],
        })).results,
        [
          { "?start": J, "?end": F },
          { "?start": M, "?end": null },
        ],
      );
      yield* rows(
        (yield* t.queryAll({
          validTime: "all",
          find: ["ok"],
          where: [
            [prefix + "vendor", ":time/vendor", "approved"],
            [prefix + "review", ":time/review", "approved"],
          ],
        })).results,
        [{ ok: "ok" }],
      );
      const rule = { name: "time_edge", body: [["?x", ":time/vendor", "?y"]] } as const;
      yield* rows(
        (yield* t.queryAll({
          validTime: "all",
          find: ["?x"],
          where: [["time_edge", prefix + "vendor", "?x"]],
          rules: [rule],
        })).results,
        [{ "?x": "approved" }],
      );
      yield* rows(
        (yield* t.queryAll(
          { find: ["?x"], where: [["time_edge", prefix + "vendor", "?x"]], rules: [rule] },
          { basis: { validAt: F } },
        )).results,
        [],
      );
    }),
  },
  {
    name: "time: aggregates count null distinctly and skip null for numeric aggregates",
    run: Effect.gen(function* () {
      const { t, all, interval } = yield* fixture("aggregates");
      for (const [op, expected] of [
        ["count", 2],
        ["sum", F],
        ["avg", F],
        ["min", F],
        ["max", F],
      ] as const) {
        yield* rows(
          (yield* t.queryAll({
            ...all,
            orderBy: [],
            find: ["?result"],
            aggregate: [[op, "?end", "?result"]],
          })).results,
          [{ "?result": expected }],
        );
        yield* rows(
          (yield* t.queryAll({
            ...all,
            orderBy: [],
            find: ["?result"],
            where: [interval, ["=", "?end", null]],
            aggregate: [[op, "?end", "?result"]],
          })).results,
          [{ "?result": op === "count" ? 1 : null }],
        );
        yield* rows(
          (yield* t.queryAll({
            ...all,
            orderBy: [],
            find: ["?result"],
            where: [interval, ["<", "?start", 0]],
            aggregate: [[op, "?end", "?result"]],
          })).results,
          [{ "?result": op === "count" ? 0 : null }],
        );
      }
      yield* rows(
        (yield* t.queryAll({
          ...all,
          orderBy: [],
          find: ["?sum"],
          where: [interval, ["=", "?end", null]],
          aggregate: [["sum", "?end", "?sum"]],
          having: [["=", "?sum", null]],
        })).results,
        [{ "?sum": null }],
      );
      yield* rows(
        (yield* t.queryAll({ ...all, where: [interval, ["<", "?end", null]] })).results,
        [],
      );
      yield* rows(
        (yield* t.queryAll({
          ...all,
          find: ["?end", "?n"],
          aggregate: [["count", "?start", "?n"]],
          having: [["=", "?end", null]],
          orderBy: [{ variable: "?end" }],
        })).results,
        [{ "?n": 1, "?end": null }],
      );
    }),
  },
  {
    name: "time: wrapper filtering, ordering, counts, stable pagination and mode rejection",
    run: Effect.gen(function* () {
      const { t, all, third, interval } = yield* fixture("pages");
      const request = { inner: all, limit: 1, includeCount: true } as const;
      const first = yield* t.queryPage(request, { basis: { recordedPosition: third.position } });
      yield* rows(first.results, [{ "?start": J, "?end": F }]);
      yield* check(
        first.totalCount === 2 && first.nextCursor !== undefined,
        "interval page must expose complete count and continuation",
      );
      const second = yield* t.queryPage({ ...request, cursor: first.nextCursor! });
      yield* rows(second.results, [{ "?start": M, "?end": null }]);
      yield* check(second.nextCursor === undefined, "terminal page");
      for (const filters of [
        [{ column: "?end", op: "is-null" }],
        [{ column: "?end", op: ">", value: F }],
      ] as const) {
        const result = yield* t.queryPage({ inner: all, filters });
        yield* rows(
          result.results,
          filters[0].op === "is-null" ? [{ "?start": M, "?end": null }] : [],
        );
      }
      const bad = yield* Effect.result(t.queryAll(all, { basis: { validAt: M } }));
      yield* check(
        bad._tag === "Failure" && bad.failure instanceof DatalogValidationError,
        "all-time explicit validAt must fail typed preflight",
      );
      const wrapperBad = yield* Effect.result(t.queryPage(request, { basis: { validAt: M } }));
      yield* check(
        wrapperBad._tag === "Failure" && wrapperBad.failure instanceof DatalogValidationError,
        "wrapped all-time explicit validAt must fail typed preflight",
      );
      const changed = yield* Effect.result(
        t.queryPage({
          ...request,
          inner: { ...all, where: [interval, ["!=", "?end", null]] },
          cursor: first.nextCursor!,
        }),
      );
      yield* check(changed._tag === "Failure", "changed bound filter invalidates cursor");
    }),
  },
  {
    name: "time: overlapping integer periods, and numeric family joins",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const e = EntityId.make("conf:time:fraction");
      const receipt = yield* t.transact([
        {
          op: "assert",
          entityId: e,
          attribute: ":time/fraction",
          value: string("yes"),
          validFrom: 1,
          validTo: 3,
        },
        {
          op: "assert",
          entityId: e,
          attribute: ":time/fraction",
          value: string("yes"),
          validFrom: 2,
          validTo: 4,
        },
        {
          op: "assert",
          entityId: e,
          attribute: ":time/number",
          value: { type: "number", value: 1 },
        },
      ]);
      const q = {
        validTime: "all",
        find: ["?from", "?to"],
        where: [{ pattern: [e, ":time/fraction", "yes"], valid: { from: "?from", to: "?to" } }],
        orderBy: [{ variable: "?from" }],
      } as const;
      yield* rows((yield* t.queryAll(q)).results, [
        { "?from": 1, "?to": 3 },
        { "?from": 2, "?to": 4 },
      ]);
      for (const where of [
        [...q.where, [e, ":time/number", "?from"]],
        [[e, ":time/number", "?from"], ...q.where],
      ] as const) {
        yield* rows(
          (yield* t.queryAll({ ...q, where }, { basis: { recordedPosition: receipt.position } }))
            .results,
          [{ "?from": 1, "?to": 3 }],
        );
      }
    }),
  },
  {
    name: "time: transaction metadata in dynamic scans, negation, disjunction, and rules",
    run: Effect.gen(function* () {
      const { t, prefix, first, second } = yield* fixture("metadata");
      const basis = { recordedPosition: second.position, validAt: M };
      yield* rows(
        (yield* t.queryAll(
          {
            find: ["?attribute"],
            where: [
              [second.txId, "?attribute", "?actor"],
              ["=", "?attribute", ":_tx/actor"],
            ],
          },
          { basis },
        )).results,
        [{ "?attribute": ":_tx/actor" }],
      );
      yield* rows(
        (yield* t.queryAll(
          {
            find: ["?actor"],
            where: [["time_actor", second.txId, "?actor"]],
            rules: [{ name: "time_actor", body: [["?x", ":_tx/actor", "?y"]] }],
          },
          { basis },
        )).results,
        [{ "?actor": "user:lee" }],
      );
      const base = [prefix + "review", ":time/review", "approved", "?tx"] as const;
      yield* rows(
        (yield* t.queryAll(
          { find: ["?tx"], where: [["not", ["?tx", ":_tx/actor", "user:lee"]], base] },
          { basis },
        )).results,
        [],
      );
      yield* rows(
        (yield* t.queryAll(
          {
            find: ["?tx"],
            where: [
              base,
              [
                "or",
                [
                  ["?tx", ":_tx/actor", "user:lee"],
                  ["=", "?tx", "missing"],
                ],
              ],
            ],
          },
          { basis },
        )).results,
        [{ "?tx": second.txId }],
      );
      yield* rows(
        (yield* t.queryAll(
          { find: ["?actor"], where: [[second.txId, ":_tx/actor", "?actor"]] },
          { basis: { ...basis, recordedPosition: first.position } },
        )).results,
        [],
      );
      const domain = yield* t.transact([
        {
          op: "assert",
          entityId: EntityId.make(second.txId),
          attribute: ":time/domain-on-tx",
          value: string("future"),
          validFrom: A,
        },
      ]);
      yield* rows(
        (yield* t.queryAll(
          { find: ["?v"], where: [[second.txId, ":time/domain-on-tx", "?v"]] },
          { basis: { recordedPosition: domain.position, validAt: M } },
        )).results,
        [],
      );
    }),
  },
  {
    name: "time: duplicate aggregate inputs and descending null ordering",
    run: Effect.gen(function* () {
      const { t, all, interval, prefix } = yield* fixture("duplicates");
      yield* t.transact(
        ["a", "b"].map((value) => ({
          op: "assert" as const,
          entityId: EntityId.make(prefix + "vendor"),
          attribute: ":time/label",
          value: string(value),
        })),
      );
      const where = [interval, [prefix + "vendor", ":time/label", "?label"]] as const;
      yield* rows(
        (yield* t.queryAll({
          validTime: "all",
          find: ["?sum", "?count"],
          where,
          aggregate: [
            ["sum", "?end", "?sum"],
            ["count", "?end", "?count"],
          ],
        })).results,
        [{ "?sum": 2 * F, "?count": 2 }],
      );
      yield* rows(
        (yield* t.queryAll({ ...all, orderBy: [{ variable: "?end", direction: "desc" }] })).results,
        [
          { "?start": J, "?end": F },
          { "?start": M, "?end": null },
        ],
      );
      yield* rows(
        (yield* t.queryAll({
          validTime: "all",
          find: ["?end", "?n"],
          where: [interval, ["<", "?start", 0]],
          aggregate: [["count", "?start", "?n"]],
        })).results,
        [],
      );
    }),
  },
  {
    name: "time: cursors preserve equal bounds and null ends across concurrent mutations",
    run: Effect.gen(function* () {
      const { t, prefix, first, all, third } = yield* fixture("mutations");
      const request = { inner: all, limit: 1, includeCount: true } as const;
      const page = yield* t.queryPage(request, { basis: { recordedPosition: third.position } });
      yield* t.transact([
        { op: "retract", id: first.triples[1]!.id },
        {
          op: "assert",
          entityId: EntityId.make(prefix + "vendor"),
          attribute: ":time/vendor",
          value: string("approved"),
          validFrom: A,
          validTo: Y,
        },
      ]);
      const next = yield* t.queryPage({ ...request, cursor: page.nextCursor! });
      yield* rows(next.results, [{ "?start": M, "?end": null }]);
      yield* check(
        next.totalCount === 2 && next.nextCursor === undefined,
        "captured cut retains original count and terminal membership",
      );
      const changedMode = yield* Effect.result(
        t.queryPage({
          ...request,
          inner: { ...all, validTime: "point" },
          cursor: page.nextCursor!,
        }),
      );
      yield* check(changedMode._tag === "Failure", "cursor cannot change temporal mode");
    }),
  },
  {
    name: "time: malformed forms, unsafe projections, and unsupported combinations fail preflight",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const pattern = ["?e", ":time/invalid", "?v"] as const;
      const invalid: readonly unknown[] = [
        { find: ["?e"], where: [{ pattern, valid: {} }] },
        { find: ["?e"], where: [{ pattern, valid: { to: "?bad-name" } }] },
        { find: ["?e"], where: [{ pattern, valid: { from: -1 } }] },
        { find: ["?e"], where: [{ pattern, valid: { from: 5, to: 5 } }] },
        { find: ["?e"], where: [{ pattern, valid: { from: "2026-01-01" } }] },
        { find: ["?e"], where: [{ pattern, valid: { from: new Date(0) } }] },
        { find: ["?e"], where: [{ pattern, valid: { from: 0, unknown: "?end" } }] },
        { find: ["?e"], where: [{ pattern, valid: { to: Infinity } }] },
        { find: ["?e"], where: [{ pattern, valid: { from: "?e" } }] },
        { find: ["?e"], where: [["?e", ":time/invalid", "?v", "?tx", "?from", "?to"]] },
        { find: ["?end"], where: [pattern, ["not", { pattern, valid: { to: "?end" } }]] },
        { find: ["?end"], where: [pattern, ["or", [{ pattern, valid: { to: "?end" } }]]] },
        {
          validTime: "all",
          find: ["?e", "?optional"],
          where: [pattern],
          optionalProjection: {
            rowBinding: "?e",
            fields: [{ attribute: ":time/optional", variable: "?optional" }],
          },
        },
        {
          find: ["?e"],
          where: [pattern],
          rules: [
            {
              name: "invalid_interval_rule",
              body: [{ pattern: ["?x", ":time/invalid", "?y"], valid: { to: "?end" } }],
            },
          ],
        },
      ];
      for (const query of invalid) {
        const explained = yield* Effect.result(t.explain(query as DatalogQuery));
        yield* check(explained._tag === "Failure", "invalid time query must fail before execution");
        const wrapped = yield* Effect.result(t.explainPage({ inner: query as DatalogQuery }));
        yield* check(
          wrapped._tag === "Failure",
          "wrapped invalid time query must fail before execution",
        );
      }
    }),
  },
  {
    name: "time: schema traversal, dependency discovery and exact provenance exclusions",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const interval = {
        pattern: ["?e", ":time/dependency", "?value"],
        valid: { from: "?start", to: "?end" },
      } as const;
      const q = {
        find: ["?e"],
        where: [interval, ["not", { pattern: ["?e", ":time/blocked", true], valid: { to: null } }]],
      } as const;
      yield* rows([...attributesOf({ inner: q })].sort(), [":time/blocked", ":time/dependency"]);
      yield* rows([...extractDependencies(q).attributes].sort(), [
        ":time/blocked",
        ":time/dependency",
      ]);
      const unknown = yield* Effect.result(
        checkAttributes({ inner: q }, new Set([":time/dependency"])),
      );
      yield* check(
        unknown._tag === "Failure" && unknown.failure.key === ":time/blocked",
        "SchemaBound must inspect negated interval attributes",
      );
      const valid = yield* Derivation.make({
        name: "time:provenance",
        identity: ["?e"],
        configSnapshot: "fixture",
        query: { find: ["?e"], where: [["?e", ":time/dependency", "?value"]] },
      });
      for (const query of [q, { ...valid.query, validTime: "all" as const }]) {
        const made = yield* Effect.result(Derivation.make({ ...valid, query }));
        yield* check(
          made._tag === "Failure",
          "exact provenance definition must reject new time forms",
        );
        const definition = { ...valid, query };
        const evaluated = yield* Effect.result(
          Derivation.evaluate(t, definition, { basis: { validAt: M } }),
        );
        yield* check(
          evaluated._tag === "Failure",
          "persisted exact provenance definitions must reject time forms",
        );
        const overlay = yield* Effect.result(
          Derivation.Overlay.evaluateOverlay(t, definition, { basis: { validAt: M }, overlay: {} }),
        );
        yield* check(
          overlay._tag === "Failure",
          "hypothetical overlays must reject new time forms",
        );
      }
    }),
  },
  {
    name: "time: commit read views retain all intervals and reject an explicit point",
    run: Effect.gen(function* () {
      const { t, all } = yield* fixture("views");
      let beforeCount = 0,
        afterCount = 0,
        rejected = false;
      yield* t.transact([], {
        validate: [
          {
            name: "time:view",
            validate: (context) =>
              Effect.gen(function* () {
                beforeCount = (yield* context.before.query(all)).results.length;
                afterCount = (yield* context.after.query(all)).results.length;
                const invalid = yield* Effect.result(context.before.query(all, { validAt: M }));
                rejected =
                  invalid._tag === "Failure" && invalid.failure instanceof DatalogValidationError;
              }),
          },
        ],
      });
      yield* check(
        beforeCount === 2 && afterCount === 2 && rejected,
        "commit query views must use query-wide time semantics",
      );
    }),
  },
];

export const datalogTimeSealedCases: readonly ConformanceCase[] = [
  {
    name: "time: raw sealed interval projections retain null values and blind-only equality",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const e = EntityId.make("conf:time:sealed");
      yield* t.transact([
        {
          op: "assert",
          entityId: e,
          attribute: ":time/sealed",
          value: {
            type: "sealed",
            valueType: "string",
            keyId: "fixture",
            ciphertext: "ciphertext",
            blind: "token",
          },
          validFrom: J,
          validTo: F,
        },
      ]);
      const query = {
        validTime: "all",
        find: ["?v", "?end"],
        where: [{ pattern: [e, ":time/sealed", "?v"], valid: { to: "?end" } }],
      } as const;
      yield* rows((yield* t.queryAll(query)).results, [{ "?v": null, "?end": F }]);
      yield* rows(
        (yield* t.queryAll({
          ...query,
          find: ["?end"],
          where: [
            {
              pattern: [e, ":time/sealed", { type: "blind", value: "token" }],
              valid: { to: "?end" },
            },
          ],
        })).results,
        [{ "?end": F }],
      );
      yield* rows(
        (yield* t.queryAll({
          ...query,
          find: ["?end"],
          where: [{ pattern: [e, ":time/sealed", "ciphertext"], valid: { to: "?end" } }],
        })).results,
        [],
      );
    }),
  },
];
