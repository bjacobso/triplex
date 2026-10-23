/** Globally identified runtime attribute definitions and usage-local constraints. */

import { Effect, type Schema } from "effect";

import type { TripleValue } from "../Value.js";
import type { EntityId } from "../Branded.js";
import * as Values from "../Value.js";
import * as ConfigNode from "./ConfigNode.js";
import * as TypeExpr from "./TypeExpr.js";

export const KIND = "attribute";

const ATTRIBUTE_KEY = /^:[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/;

export interface AssertionOptions {
  /** Inclusive start of domain-valid time, in epoch milliseconds. */
  readonly validFrom?: number;
  /** Exclusive end of domain-valid time, in epoch milliseconds: `[validFrom, validTo)`. */
  readonly validTo?: number;
}

export interface Assertion<K extends string = string> {
  readonly attribute: K;
  readonly value: TripleValue;
  readonly validFrom?: number;
  readonly validTo?: number;
}

export interface Definition<K extends string, V> {
  readonly _tag: "Attribute";
  readonly key: K;
  readonly type: TypeExpr.TypeExpr;
  readonly node: Effect.Effect<
    ConfigNode.ConfigNode,
    | ConfigNode.DuplicateChildKeyError
    | import("../content/CanonicalJson.js").CanonicalEncodingError
    | Schema.SchemaError
  >;
  readonly encode: (value: V) => TripleValue;
  /** This attribute's use by an entity type, with every entity required to have it. */
  readonly required: <const O extends Omit<UseOptions, "required"> = {}>(
    options?: O,
  ) => Use<Definition<K, V>, CardinalityOf<O>>;
  /** This attribute's use by an entity type, with any number of values per entity. */
  readonly many: (options?: Omit<UseOptions, "cardinality">) => Use<Definition<K, V>, "many">;
  /** This attribute's use by an entity type, with each value on at most one entity. */
  readonly unique: <const O extends Omit<UseOptions, "unique"> = {}>(
    options?: O,
  ) => Use<Definition<K, V>, CardinalityOf<O>>;
}

export type Cardinality = "one" | "many";

export interface UseOptions {
  readonly required?: boolean;
  readonly cardinality?: Cardinality;
  /** Values of this attribute may occur on at most one entity of this type. */
  readonly unique?: boolean;
}

/**
 * One entity type's use of a global attribute. `C` keeps a literal
 * cardinality in the type, so entity-level helpers can accept an array for
 * exactly the cardinality-many uses.
 */
export interface Use<D extends AnyDefinition, C extends Cardinality = Cardinality> {
  readonly _tag: "AttributeUse";
  readonly attribute: D;
  readonly required: boolean;
  readonly cardinality: C;
  readonly unique: boolean;
}

/** The cardinality `use` records for an options literal; `one` unless `many` is explicit. */
export type CardinalityOf<O extends UseOptions> = O extends { readonly cardinality: "many" }
  ? "many"
  : "cardinality" extends keyof O
    ? O extends { readonly cardinality?: "one" }
      ? "one"
      : Cardinality
    : "one";

export type AnyDefinition = Definition<string, any>;
export type ValueOf<D> = D extends Definition<string, infer V> ? V : never;

const DefinitionType = TypeExpr.struct({
  key: TypeExpr.required(TypeExpr.text),
  valueType: TypeExpr.required(TypeExpr.any),
});

const validateKey = <const K extends string>(key: K): K => {
  if (!ATTRIBUTE_KEY.test(key)) {
    throw new TypeError(
      `Attribute identity must be a lowercase namespaced keyword such as :employer/name; received ${key}`,
    );
  }
  return key;
};

const make = <const K extends string, V>(
  keyInput: K,
  type: TypeExpr.TypeExpr,
  encode: (value: V) => TripleValue,
  refs: ReadonlyArray<ConfigNode.ConfigRef> = [],
): Definition<K, V> => {
  const key = validateKey(keyInput);
  const definition: Definition<K, V> = {
    _tag: "Attribute",
    key,
    type,
    encode,
    node: ConfigNode.makeTyped({
      kind: KIND,
      key,
      type: DefinitionType,
      attrs: { key, valueType: type },
      refs,
    }),
    // The spread loses `O`'s literal cardinality, which `CardinalityOf<O>` restores.
    required: (options) =>
      use(definition, { ...options, required: true }) as Use<Definition<K, V>, never>,
    many: (options) => use(definition, { ...options, cardinality: "many" }),
    unique: (options) =>
      use(definition, { ...options, unique: true }) as Use<Definition<K, V>, never>,
  };
  return definition;
};

export const text = <const K extends string>(key: K): Definition<K, string> =>
  make(key, TypeExpr.text, Values.string);

export const number = <const K extends string>(key: K): Definition<K, number> =>
  make(key, TypeExpr.number, Values.number);

export const integer = <const K extends string>(key: K): Definition<K, number> =>
  make(key, TypeExpr.integer, Values.number);

export const boolean = <const K extends string>(key: K): Definition<K, boolean> =>
  make(key, TypeExpr.boolean, Values.boolean);

export const date = <const K extends string>(key: K): Definition<K, string> =>
  make(key, TypeExpr.date, Values.string);

export const instant = <const K extends string>(key: K): Definition<K, number | Date> =>
  make(key, TypeExpr.instant, Values.datetime);

export const enumOf = <const K extends string, const V extends string>(
  key: K,
  values: ReadonlyArray<V>,
): Definition<K, V> => make(key, TypeExpr.enumOf(values), (value) => Values.string(value));

/** A relation attribute whose values are entity ids of `target`. */
export const ref = <const K extends string, const Target extends { readonly entityType: string }>(
  key: K,
  target: Target,
): Definition<K, EntityId> =>
  make(key, TypeExpr.ref(target.entityType), Values.ref, [
    {
      rel: "references-entity-type",
      kind: "entity-schema",
      key: target.entityType,
    },
  ]);

/** Requiredness and cardinality belong to an entity's use, not the global attribute. */
export const use = <D extends AnyDefinition, const O extends UseOptions = {}>(
  attribute: D,
  options?: O,
): Use<D, CardinalityOf<O>> => ({
  _tag: "AttributeUse",
  attribute,
  required: options?.required ?? false,
  cardinality: (options?.cardinality ?? "one") as CardinalityOf<O>,
  unique: options?.unique ?? false,
});

const validateValidity = (options: AssertionOptions): void => {
  if (options.validFrom !== undefined && !Number.isFinite(options.validFrom)) {
    throw new TypeError("validFrom must be a finite epoch-millisecond value");
  }
  if (options.validTo !== undefined && !Number.isFinite(options.validTo)) {
    throw new TypeError("validTo must be a finite epoch-millisecond value");
  }
  if (
    options.validFrom !== undefined &&
    options.validTo !== undefined &&
    options.validTo <= options.validFrom
  ) {
    throw new TypeError("validTo must be after validFrom; valid time is [validFrom, validTo)");
  }
};

/** A typed fact descriptor; spread it into an `assert` operation with an entity id. */
export const assertion = <D extends AnyDefinition>(
  definition: D,
  value: ValueOf<D>,
  options: AssertionOptions = {},
): Assertion<D["key"]> => {
  validateValidity(options);
  return {
    attribute: definition.key,
    value: definition.encode(value),
    ...(options.validFrom !== undefined && { validFrom: options.validFrom }),
    ...(options.validTo !== undefined && { validTo: options.validTo }),
  };
};
