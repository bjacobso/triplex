/**
 * Compiling a `TypeExpr` down to an Effect Schema.
 *
 * The point of writing our own type language was never to leave Effect Schema
 * behind - it was to stop borrowing *identity* from it. So the relationship is
 * one-directional and explicit: `TypeExpr` is the source of truth, and Schema
 * is a compilation target, alongside whatever else needs one (JSON Schema for
 * docs, a widget for the form builder, DDL for a relational mirror).
 *
 *     TypeExpr ──► Schema      decoding, parse errors, effect-form, HttpApi
 *        │    ──► JSON Schema  external contracts
 *        └── canonical ──► ContentId   identity, owned end to end
 *
 * Everything Effect Schema is good at survives. What does not survive - and
 * cannot, by construction - is a precise *static* type. A type a customer
 * created at 3pm has no TypeScript counterpart, so the result decodes to
 * `unknown` and callers narrow it themselves. That is not a shortcoming of the
 * compiler; it is what "types are runtime data" means.
 */

import { Effect, Schema } from "effect";

import * as TypeExpr from "./TypeExpr";

/** ISO calendar date with no zone - distinct from an instant, on purpose. */
const IsoDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/, {
    message: "Expected an ISO calendar date (YYYY-MM-DD)",
  }),
);

const primSchema = (name: TypeExpr.PrimName): Schema.Codec<any, any> => {
  switch (name) {
    case "text":
      return Schema.String;
    case "number":
      return Schema.Number;
    case "integer":
      return Schema.Int;
    case "boolean":
      return Schema.Boolean;
    case "date":
      return IsoDate;
    case "instant":
      return Schema.Int;
  }
};

const applyConstraint = (
  schema: Schema.Codec<any, any>,
  constraint: TypeExpr.Constraint,
): Schema.Codec<any, any> => {
  switch (constraint._tag) {
    case "Pattern":
      return (schema as Schema.Codec<string>).check(
        Schema.isPattern(new RegExp(constraint.regex)),
      ) as Schema.Codec<any, any>;
    case "MinLength":
      return (schema as Schema.Codec<string>).check(
        Schema.isMinLength(constraint.value),
      ) as Schema.Codec<any, any>;
    case "MaxLength":
      return (schema as Schema.Codec<string>).check(
        Schema.isMaxLength(constraint.value),
      ) as Schema.Codec<any, any>;
    case "Min":
      return (schema as Schema.Codec<number>).check(
        Schema.isGreaterThanOrEqualTo(constraint.value),
      ) as Schema.Codec<any, any>;
    case "Max":
      return (schema as Schema.Codec<number>).check(
        Schema.isLessThanOrEqualTo(constraint.value),
      ) as Schema.Codec<any, any>;
  }
};

const go = (expr: TypeExpr.TypeExpr): Schema.Codec<any, any> => {
  switch (expr._tag) {
    case "Any":
      return Schema.Unknown as Schema.Codec<any, any>;
    case "Prim":
      return primSchema(expr.prim);
    case "Enum":
      // A one-value enum is a literal, not a union of one.
      return Schema.Literals(expr.values) as Schema.Codec<any, any>;
    case "Ref":
      // A reference is a key addressing another entity; the target is resolved
      // by the store, not by decoding.
      return Schema.String as Schema.Codec<any, any>;
    case "List":
      return Schema.Array(go(expr.item)) as Schema.Codec<any, any>;
    case "Struct":
      return Schema.StructWithRest(
        Schema.Struct(
          Object.fromEntries(
            Object.entries(expr.fields).map(([name, field]) => [
              name,
              field.optional
                ? field.fallback === undefined
                  ? Schema.optional(go(field.type))
                  : // Applied on decode and emitted on encode, so an omitted
                    // field and an explicitly-defaulted one produce identical
                    // bytes and therefore an identical content id.
                    go(field.type).pipe(
                      Schema.withDecodingDefaultType(Effect.succeed(field.fallback)),
                    )
                : go(field.type),
            ]),
          ),
        ),
        // Preserve excess keys so the property-name check can reject them.
        // Effect 4 stable no longer applies parseOptions annotations.
        [Schema.Record(Schema.Union([Schema.String, Schema.Symbol]), Schema.Unknown)],
      ).check(
        Schema.isPropertyNames(Schema.Literals(Object.keys(expr.fields))),
      ) as unknown as Schema.Codec<any, any>;
    case "Union":
      return Schema.Union(expr.members.map(go)) as unknown as Schema.Codec<any, any>;
    case "Constrained":
      return expr.constraints.reduce(applyConstraint, go(expr.base));
  }
};

/**
 * Compile to a Schema that decodes to `unknown`.
 *
 * Deliberately not generic over a success type. Offering `compile<A>()` would
 * let a caller assert a static shape the runtime value need not have, which is
 * exactly the unsoundness this whole direction exists to avoid.
 */
export const compile = (expr: TypeExpr.TypeExpr): Schema.Codec<unknown, unknown> =>
  go(expr) as unknown as Schema.Codec<unknown, unknown>;

/** Does this value satisfy the type? The instance-level check, when needed. */
export const is = (expr: TypeExpr.TypeExpr, value: unknown): boolean =>
  Schema.is(compile(expr))(value);

/**
 * Validate a value and return its normalised (encoded) form.
 *
 * Decode then re-encode, so the type's own fallbacks are applied and anything
 * the type considers irrelevant is discarded. Hashing this rather than the raw
 * input is what makes two configs differing only in ways the type ignores come
 * out byte-identical.
 */
export const normalize = (
  expr: TypeExpr.TypeExpr,
  input: unknown,
): Effect.Effect<unknown, Schema.SchemaError> => {
  const schema = compile(expr);
  return Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.flatMap((decoded) => Schema.encodeEffect(schema)(decoded)),
  );
};
