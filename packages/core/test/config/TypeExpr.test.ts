import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import * as TypeExpr from "../../src/config/TypeExpr";
import * as TypeSchema from "../../src/config/TypeSchema";
import * as TypeSubsumption from "../../src/config/TypeSubsumption";

const T = TypeExpr;
const verdict = (from: TypeExpr.TypeExpr, to: TypeExpr.TypeExpr) =>
  TypeSubsumption.subsumes(from, to)._tag;

describe("TypeExpr identity", () => {
  it("treats enum values and union members as sets", () => {
    expect(T.id(T.enumOf(["b", "a", "b"]))).toEqual(T.id(T.enumOf(["a", "b"])));
    expect(T.id(T.union([T.text, T.number]))).toEqual(T.id(T.union([T.number, T.text])));
    // Struct field order is not content either.
    expect(T.id(T.struct({ a: T.required(T.text), b: T.required(T.number) }))).toEqual(
      T.id(T.struct({ b: T.required(T.number), a: T.required(T.text) })),
    );
  });

  it("flattens nested unions and collapses a union of one", () => {
    expect(T.union([T.text, T.union([T.number, T.boolean])])).toEqual(
      T.union([T.text, T.number, T.boolean]),
    );
    expect(T.union([T.text])).toEqual(T.text);
  });

  it("merges nested constraints rather than stacking them", () => {
    const stacked = T.constrained(T.constrained(T.text, [T.minLength(1)]), [T.maxLength(9)]);
    const flat = T.constrained(T.text, [T.maxLength(9), T.minLength(1)]);
    expect(T.id(stacked)).toEqual(T.id(flat));
  });

  it("versions each constructor, not the language", () => {
    // Adding a constructor must leave every existing type's id untouched. The
    // version lives on the node, so nothing outside a type that uses the new
    // constructor can be disturbed.
    expect(T.text.v).toEqual(1);
    expect(T.id(T.text)).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(T.id(T.text)).not.toEqual(T.id(T.number));
  });

  it.effect("round-trips through its own schema, because types are data", () =>
    Effect.gen(function* () {
      // The point of the exercise: a customer-created type is a value that can
      // be stored, sent and validated - not a TypeScript declaration.
      const customerDefined = T.struct({
        state: T.required(T.enumOf(["CA", "NY"])),
        note: T.optional(T.constrained(T.text, [T.maxLength(280)])),
        hired: T.required(T.date),
      });

      const wire = JSON.parse(JSON.stringify(customerDefined));
      const decoded = yield* Schema.decodeUnknownEffect(T.TypeExprSchema)(wire);

      expect(T.id(decoded)).toEqual(T.id(customerDefined));
    }),
  );
});

describe("TypeSubsumption is total", () => {
  it("never returns a third state, for any pair in the algebra", () => {
    // Exhaustive over a representative spanning set. `Unknown` is not merely
    // unlikely here - it is not a value this function can produce.
    const universe: ReadonlyArray<TypeExpr.TypeExpr> = [
      T.any,
      T.text,
      T.number,
      T.integer,
      T.boolean,
      T.date,
      T.instant,
      T.enumOf(["a"]),
      T.enumOf(["a", "b"]),
      T.ref("form"),
      T.ref("attribute"),
      T.list(T.text),
      T.list(T.number),
      T.union([T.text, T.number]),
      T.struct({ a: T.required(T.text) }),
      T.struct({ a: T.optional(T.text) }),
      T.struct({ a: T.required(T.text), b: T.optional(T.number) }),
      T.constrained(T.text, [T.minLength(2)]),
      T.constrained(T.text, [T.pattern("^x")]),
      T.constrained(T.number, [T.min(0), T.max(10)]),
    ];

    const seen = new Set<string>();
    for (const from of universe) {
      for (const to of universe) {
        seen.add(TypeSubsumption.subsumes(from, to)._tag);
      }
    }
    expect([...seen].sort()).toEqual(["Identical", "Narrows", "Widens"]);
  });

  it("is reflexive, and Any is the top of the lattice", () => {
    const samples = [T.text, T.enumOf(["a"]), T.list(T.number), T.any];
    for (const t of samples) expect(verdict(t, t)).toEqual("Identical");
    for (const t of samples.slice(0, 3)) {
      expect(verdict(t, T.any)).toEqual("Widens");
      expect(verdict(T.any, t)).toEqual("Narrows");
    }
  });
});

describe("TypeSubsumption verdicts", () => {
  it("widens an enum and narrows it back", () => {
    expect(verdict(T.enumOf(["CA", "NY"]), T.enumOf(["CA", "NY", "WA"]))).toEqual("Widens"); // prettier-ignore
    expect(verdict(T.enumOf(["CA", "NY", "WA"]), T.enumOf(["CA", "NY"]))).toEqual("Narrows"); // prettier-ignore
  });

  it("opens a fixed set up to free text, but not the reverse", () => {
    // The change a customer actually makes: "stop policing this field".
    expect(verdict(T.enumOf(["CA", "NY"]), T.text)).toEqual("Widens");
    expect(verdict(T.text, T.enumOf(["CA", "NY"]))).toEqual("Narrows");
    expect(verdict(T.enumOf(["1", "2"]), T.number)).toEqual("Narrows");
  });

  it("knows every integer is a number and not the reverse", () => {
    expect(verdict(T.integer, T.number)).toEqual("Widens");
    expect(verdict(T.number, T.integer)).toEqual("Narrows");
  });

  it("handles optionality and closedness in structs", () => {
    const base = T.struct({ a: T.required(T.text) });

    expect(verdict(base, T.struct({ a: T.required(T.text), b: T.optional(T.number) }))).toEqual("Widens"); // prettier-ignore
    expect(verdict(base, T.struct({ a: T.required(T.text), b: T.required(T.number) }))).toEqual("Narrows"); // prettier-ignore
    expect(verdict(base, T.struct({ a: T.optional(T.text) }))).toEqual("Widens");
    expect(verdict(T.struct({ a: T.optional(T.text) }), base)).toEqual("Narrows"); // prettier-ignore
    // Structs are closed, so dropping a field rejects values that carry it.
    expect(verdict(T.struct({ a: T.required(T.text), b: T.optional(T.number) }), base)).toEqual("Narrows"); // prettier-ignore
  });

  it("recurses through lists and nested structs", () => {
    expect(verdict(T.list(T.integer), T.list(T.number))).toEqual("Widens");
    expect(verdict(T.list(T.number), T.list(T.integer))).toEqual("Narrows");
    expect(
      verdict(
        T.struct({ inner: T.required(T.enumOf(["a"])) }),
        T.struct({ inner: T.required(T.enumOf(["a", "b"])) }),
      ),
    ).toEqual("Widens");
  });

  it("decides unions in both directions", () => {
    // This is the case SchemaCompat gives up on entirely.
    expect(verdict(T.text, T.union([T.text, T.number]))).toEqual("Widens");
    expect(verdict(T.union([T.text, T.number]), T.text)).toEqual("Narrows");
    expect(verdict(T.union([T.text, T.integer]), T.union([T.text, T.number]))).toEqual("Widens");
    expect(verdict(T.boolean, T.union([T.text, T.number]))).toEqual("Narrows");
  });

  it("orders bounds correctly - tightening narrows, relaxing widens", () => {
    const loose = T.constrained(T.text, [T.minLength(2)]);
    const tight = T.constrained(T.text, [T.minLength(5)]);

    expect(verdict(tight, loose)).toEqual("Widens");
    expect(verdict(loose, tight)).toEqual("Narrows");
    expect(verdict(loose, T.text)).toEqual("Widens");
    expect(verdict(T.text, loose)).toEqual("Narrows");

    expect(
      verdict(
        T.constrained(T.number, [T.min(0), T.max(10)]),
        T.constrained(T.number, [T.min(0), T.max(100)]),
      ),
    ).toEqual("Widens");
  });

  it("reports differing patterns conservatively, and says so", () => {
    const a = T.constrained(T.text, [T.pattern("^[0-9]{9}$")]);
    const b = T.constrained(T.text, [T.pattern("^[0-9]+$")]);

    // `a` really is a subset of `b`, but deciding regex containment is not
    // something this module attempts. It errs toward refusing.
    const result = TypeSubsumption.subsumes(a, b);
    expect(result._tag).toEqual("Narrows");
    expect(result._tag === "Narrows" && result.reasons.join(" ")).toContain("conservatively");

    // The decidable pattern cases are still decided.
    expect(verdict(a, T.text)).toEqual("Widens");
    expect(verdict(T.text, a)).toEqual("Narrows");
    expect(verdict(a, a)).toEqual("Identical");
  });

  it("never proves compatibility across unrelated constructors", () => {
    expect(verdict(T.ref("form"), T.ref("attribute"))).toEqual("Narrows");
    expect(verdict(T.list(T.text), T.text)).toEqual("Narrows");
    expect(verdict(T.date, T.instant)).toEqual("Narrows");
  });
});

describe("TypeSchema.compile", () => {
  it("keeps Effect Schema as a target, not a dependency for identity", () => {
    const type = T.struct({
      state: T.required(T.enumOf(["CA", "NY"])),
      note: T.optional(T.constrained(T.text, [T.maxLength(4)])),
      count: T.required(T.integer),
    });

    expect(TypeSchema.is(type, { state: "CA", count: 2 })).toBe(true);
    expect(TypeSchema.is(type, { state: "CA", count: 2, note: "ok" })).toBe(true); // prettier-ignore
    expect(TypeSchema.is(type, { state: "TX", count: 2 })).toBe(false);
    expect(TypeSchema.is(type, { state: "CA", count: 2.5 })).toBe(false);
    expect(TypeSchema.is(type, { state: "CA", count: 2, note: "toolong" })).toBe(false); // prettier-ignore
    expect(TypeSchema.is(type, { state: "CA", count: 2, extra: true })).toBe(false); // prettier-ignore
  });

  it("compiles bounds and patterns into real validation", () => {
    const ssn = T.constrained(T.text, [T.pattern("^\\d{3}-\\d{2}-\\d{4}$")]);
    expect(TypeSchema.is(ssn, "123-45-6789")).toBe(true);
    expect(TypeSchema.is(ssn, "123456789")).toBe(false);

    const score = T.constrained(T.number, [T.min(0), T.max(100)]);
    expect(TypeSchema.is(score, 50)).toBe(true);
    expect(TypeSchema.is(score, 101)).toBe(false);
  });

  it("separates a calendar date from an instant", () => {
    // The distinction the app already needs and cannot recover once lost.
    expect(TypeSchema.is(T.date, "2026-08-27")).toBe(true);
    expect(TypeSchema.is(T.date, 1756252800000)).toBe(false);
    expect(TypeSchema.is(T.instant, 1756252800000)).toBe(true);
  });

  it("agrees with subsumption on real values", () => {
    // The property that ties the two halves together: if `subsumes` says every
    // value of `from` is valid under `to`, then values really do validate.
    const from = T.enumOf(["CA", "NY"]);
    const to = T.enumOf(["CA", "NY", "WA"]);
    expect(verdict(from, to)).toEqual("Widens");

    for (const value of ["CA", "NY"]) {
      expect(TypeSchema.is(from, value)).toBe(true);
      expect(TypeSchema.is(to, value)).toBe(true);
    }
    // ...and the narrowing direction really does reject something.
    expect(verdict(to, from)).toEqual("Narrows");
    expect(TypeSchema.is(to, "WA")).toBe(true);
    expect(TypeSchema.is(from, "WA")).toBe(false);
  });
});

describe("soundness: Widens is a proof, not a hint", () => {
  /** A handful of values inhabiting a type, used to cross-check the verdict. */
  const samples = (expr: TypeExpr.TypeExpr): ReadonlyArray<unknown> => {
    switch (expr._tag) {
      case "Any":
        return ["x", 1, true];
      case "Prim":
        switch (expr.prim) {
          case "text":
            return ["", "a", "abc", "xyz", "x", "12345678"];
          case "number":
            return [0, 1, 5, 10, 50, 100, -3, 1.5];
          case "integer":
            return [0, 1, 5, 10, 50, -3];
          case "boolean":
            return [true, false];
          case "date":
            return ["2026-01-02", "1999-12-31"];
          case "instant":
            return [0, 1756252800000];
        }
      // eslint-disable-next-line no-fallthrough
      case "Enum":
        return expr.values;
      case "Ref":
        return ["some-key"];
      case "List":
        return [[], samples(expr.item).slice(0, 2)];
      case "Struct": {
        const required: Record<string, unknown> = {};
        const full: Record<string, unknown> = {};
        for (const [name, field] of Object.entries(expr.fields)) {
          const value = samples(field.type)[0];
          full[name] = value;
          if (!field.optional) required[name] = value;
        }
        return [required, full];
      }
      case "Union":
        return expr.members.flatMap(samples);
      case "Constrained":
        // Keep only base samples the constraints actually admit.
        return samples(expr.base).filter((v) => TypeSchema.is(expr, v));
    }
  };

  const universe: ReadonlyArray<TypeExpr.TypeExpr> = [
    T.text,
    T.number,
    T.integer,
    T.boolean,
    T.date,
    T.instant,
    T.enumOf(["a"]),
    T.enumOf(["a", "b"]),
    T.enumOf(["a", "b", "c"]),
    T.list(T.text),
    T.list(T.integer),
    T.list(T.number),
    T.union([T.text, T.number]),
    T.union([T.text, T.integer]),
    T.struct({ a: T.required(T.text) }),
    T.struct({ a: T.optional(T.text) }),
    T.struct({ a: T.required(T.text), b: T.optional(T.number) }),
    T.constrained(T.text, [T.minLength(2)]),
    T.constrained(T.text, [T.minLength(5)]),
    T.constrained(T.number, [T.min(0), T.max(10)]),
    T.constrained(T.number, [T.min(0), T.max(100)]),
  ];

  it("holds across every pair: nothing accepted before is rejected after", () => {
    // The one direction that must never be wrong. If `subsumes` claims Widens
    // and a real value of `from` fails under `to`, the deploy gate would wave
    // through a change that breaks stored configuration.
    const violations: string[] = [];
    let checked = 0;

    for (const from of universe) {
      for (const to of universe) {
        if (!TypeSubsumption.isCompatible(TypeSubsumption.subsumes(from, to))) {
          continue;
        }
        for (const value of samples(from)) {
          checked++;
          if (!TypeSchema.is(to, value)) {
            violations.push(
              `${T.canonical(from)} -> ${T.canonical(to)} rejects ${JSON.stringify(value)}`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  });

  it("finds a witness for every Narrows it claims to prove", () => {
    // The other direction is weaker by design - `Narrows` means "not proven" -
    // but for the decidable constructors a rejecting value should exist.
    const pairs: ReadonlyArray<[TypeExpr.TypeExpr, TypeExpr.TypeExpr]> = [
      [T.enumOf(["a", "b"]), T.enumOf(["a"])],
      [T.number, T.integer],
      [T.text, T.constrained(T.text, [T.minLength(5)])],
      [T.union([T.text, T.number]), T.text],
      [T.struct({ a: T.optional(T.text) }), T.struct({ a: T.required(T.text) })],
      [
        T.constrained(T.number, [T.min(0), T.max(100)]),
        T.constrained(T.number, [T.min(0), T.max(10)]),
      ],
    ];

    for (const [from, to] of pairs) {
      expect(TypeSubsumption.subsumes(from, to)._tag).toEqual("Narrows");
      const witness = samples(from).find((v) => !TypeSchema.is(to, v));
      expect(witness, `no rejecting value for ${T.canonical(from)}`).toBeDefined();
    }
  });
});

describe("TypeSchema closedness", () => {
  it("rejects a field the type does not declare", () => {
    // Subsumption and the compiler have to agree on this or the deploy gate is
    // reasoning about a language the validator does not implement.
    const type = T.struct({ a: T.required(T.text) });
    expect(TypeSchema.is(type, { a: "x" })).toBe(true);
    expect(TypeSchema.is(type, { a: "x", b: 1 })).toBe(false);

    // Including when nested, which is where a call-site parse option would have
    // silently stopped applying.
    const outer = T.struct({ inner: T.required(type) });
    expect(TypeSchema.is(outer, { inner: { a: "x" } })).toBe(true);
    expect(TypeSchema.is(outer, { inner: { a: "x", b: 1 } })).toBe(false);
    expect(() =>
      Schema.decodeUnknownSync(TypeSchema.compile(outer))({ inner: { a: "x", b: 1 } }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(TypeSchema.compile(type))({ a: "x", [Symbol("b")]: 1 }),
    ).toThrow();
    expect(TypeSchema.is(T.struct({}), {})).toBe(true);
    expect(TypeSchema.is(T.struct({}), { "": 1 })).toBe(false);
  });

  it("makes the Narrows verdict for a dropped field a real one", () => {
    const wide = T.struct({ a: T.required(T.text), b: T.optional(T.number) });
    const narrow = T.struct({ a: T.required(T.text) });

    expect(TypeSubsumption.subsumes(wide, narrow)._tag).toEqual("Narrows");
    // ...and here is the value that proves it.
    expect(TypeSchema.is(wide, { a: "x", b: 1 })).toBe(true);
    expect(TypeSchema.is(narrow, { a: "x", b: 1 })).toBe(false);
  });
});

describe("subsumption obeys the laws a lattice has to obey", () => {
  // A spanning set with enough structure to catch a wrong verdict, kept small
  // enough that the cubic transitivity check stays fast.
  const universe: ReadonlyArray<TypeExpr.TypeExpr> = [
    T.any,
    T.text,
    T.number,
    T.integer,
    T.boolean,
    T.enumOf(["a"]),
    T.enumOf(["a", "b"]),
    T.enumOf(["a", "b", "c"]),
    T.list(T.integer),
    T.list(T.number),
    T.union([T.text, T.number]),
    T.union([T.text, T.integer]),
    T.struct({ a: T.required(T.text) }),
    T.struct({ a: T.optional(T.text) }),
    T.struct({ a: T.required(T.integer) }),
    T.struct({ a: T.required(T.text), b: T.optional(T.number) }),
    T.constrained(T.text, [T.minLength(2)]),
    T.constrained(T.text, [T.minLength(5)]),
    T.constrained(T.number, [T.min(0), T.max(10)]),
    T.constrained(T.number, [T.min(0), T.max(100)]),
  ];

  const ok = (a: TypeExpr.TypeExpr, b: TypeExpr.TypeExpr) =>
    TypeSubsumption.isCompatible(TypeSubsumption.subsumes(a, b));

  it("is reflexive", () => {
    for (const t of universe) expect(verdict(t, t)).toEqual("Identical");
  });

  it("is transitive", () => {
    // The law that actually catches bugs. If A widens into B and B into C but
    // A does not widen into C, then some verdict in that chain is a lie, and
    // the deploy gate would pass a change that breaks stored config.
    const broken: string[] = [];
    for (const a of universe) {
      for (const b of universe) {
        if (!ok(a, b)) continue;
        for (const c of universe) {
          if (!ok(b, c)) continue;
          if (!ok(a, c)) {
            broken.push(`${T.canonical(a)} -> ${T.canonical(b)} -> ${T.canonical(c)}`); // prettier-ignore
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("is antisymmetric up to canonical form", () => {
    // Mutual subsumption means the same accepted value set. The types may
    // still differ in ways that do not affect validation - a fallback, for
    // instance - so the check is on acceptance, not on identity.
    for (const a of universe) {
      for (const b of universe) {
        if (a === b || !ok(a, b) || !ok(b, a)) continue;
        for (const value of ["a", 1, true, [], {}, { a: "x" }]) {
          expect(
            TypeSchema.is(a, value),
            `${T.canonical(a)} vs ${T.canonical(b)} on ${JSON.stringify(value)}`,
          ).toEqual(TypeSchema.is(b, value));
        }
      }
    }
  });

  it("keeps Widens sound under composition", () => {
    // Transitivity is a claim about verdicts; this is the same claim about
    // values, checked against the compiler rather than against itself.
    for (const a of universe) {
      for (const c of universe) {
        if (!ok(a, c)) continue;
        for (const value of ["a", "abcdef", 0, 7, true, ["a"], { a: "x" }]) {
          if (!TypeSchema.is(a, value)) continue;
          expect(
            TypeSchema.is(c, value),
            `${T.canonical(a)} -> ${T.canonical(c)} rejects ${JSON.stringify(value)}`,
          ).toBe(true);
        }
      }
    }
  });
});
