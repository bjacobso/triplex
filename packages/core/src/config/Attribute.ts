/** Globally identified runtime attribute definitions and usage-local constraints. */

import { Effect, type Schema } from "effect";

import type { PlainValue, SealableValueType, TripleValue } from "../Value.js";
import type { EntityId } from "../Branded.js";
import * as Values from "../Value.js";
import * as ConfigNode from "./ConfigNode.js";
import * as TypeExpr from "./TypeExpr.js";

export const KIND = "attribute";

const ATTRIBUTE_KEY = /^:[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/;

export interface AssertionOptions {
  /** Start of the domain-valid interval, in epoch milliseconds (inclusive). */
  readonly validFrom?: number | undefined;
  /** End of the domain-valid interval, in epoch milliseconds (exclusive). */
  readonly validTo?: number | undefined;
}

export interface Assertion<K extends string = string> {
  readonly attribute: K;
  readonly value: TripleValue;
  readonly validFrom?: number;
  readonly validTo?: number;
}

/** Runtime declaration edges do not participate in content identity. Name-only targets remain useful for recursive schemas. */
export interface ReferenceTarget {
  readonly entityType: string;
  readonly nodes?: Effect.Effect<ReadonlyArray<ConfigNode.ConfigNode>, ConfigNode.DuplicateChildKeyError | import("../content/CanonicalJson.js").CanonicalEncodingError | Schema.SchemaError>;
  readonly attributes?: Readonly<Record<string, { readonly definition: AnyDefinition }>>;
}

export interface Definition<K extends string, V> {
  /** The declaration supplied to ref; retained for transitive nodesOf traversal. */
  readonly target?: ReferenceTarget;
  readonly _tag: "Attribute";
  readonly key: K;
  readonly type: TypeExpr.TypeExpr;
  /** The stored Triplex value type produced by `encode`. */
  readonly valueType: PlainValue["type"];
  /**
   * Whether values are sealed at rest by the sensitive-values layer. Part of
   * the attribute node's content identity; see `sensitive`.
   */
  readonly sensitive: boolean;
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
  ) => Use<Definition<K, V>, CardinalityOf<O>, true>;
  /** This attribute's use by an entity type, with any number of values per entity. */
  readonly many: <const O extends Omit<UseOptions, "cardinality"> = {}>(
    options?: O,
  ) => Use<Definition<K, V>, "many", RequiredOf<O>>;
  /** This attribute's use by an entity type, with each value on at most one entity. */
  readonly unique: <const O extends Omit<UseOptions, "unique"> = {}>(
    options?: O,
  ) => Use<Definition<K, V>, CardinalityOf<O>, RequiredOf<O>>;
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
 * exactly the cardinality-many uses. `R` retains literal requiredness for typed reads.
 */
export interface Use<
  D extends AnyDefinition,
  C extends Cardinality = Cardinality,
  R extends boolean = boolean,
> {
  readonly _tag: "AttributeUse";
  readonly attribute: D;
  readonly required: R;
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

/** Preserve requiredness when known, including through concise modifiers. */
export type RequiredOf<O extends UseOptions> = O extends { readonly required: true }
  ? true
  : "required" extends keyof O
    ? O extends { readonly required?: false }
      ? false
      : boolean
    : false;

export type AnyDefinition = Definition<string, any>;
export type ValueOf<D> = D extends Definition<string, infer V> ? V : never;

const DefinitionType = TypeExpr.struct({
  key: TypeExpr.required(TypeExpr.text),
  valueType: TypeExpr.required(TypeExpr.any),
});

/**
 * Only sensitive attribute nodes use this shape, so the content IDs of every
 * existing non-sensitive attribute are unchanged.
 */
const SensitiveDefinitionType = TypeExpr.struct({
  key: TypeExpr.required(TypeExpr.text),
  valueType: TypeExpr.required(TypeExpr.any),
  sensitive: TypeExpr.required(TypeExpr.boolean),
});

const SEALABLE: ReadonlySet<string> = new Set(["string", "number", "boolean", "datetime", "json"]);

const validateKey = <const K extends string>(key: K): K => {
  if (!ATTRIBUTE_KEY.test(key)) {
    throw new TypeError(
      `Attribute identity must be a lowercase namespaced keyword such as :employer/name; received ${key}`,
    );
  }
  return key;
};

const nodeOf = (
  key: string,
  type: TypeExpr.TypeExpr,
  sensitive: boolean,
  refs: ReadonlyArray<ConfigNode.ConfigRef>,
) =>
  ConfigNode.makeTyped({
    kind: KIND,
    key,
    type: sensitive ? SensitiveDefinitionType : DefinitionType,
    attrs: sensitive ? { key, valueType: type, sensitive: true } : { key, valueType: type },
    refs,
  });

const make = <const K extends string, V>(
  keyInput: K,
  type: TypeExpr.TypeExpr,
  valueType: PlainValue["type"],
  encode: (value: V) => TripleValue,
  refs: ReadonlyArray<ConfigNode.ConfigRef> = [],
): Definition<K, V> => {
  const key = validateKey(keyInput);
  const definition: Definition<K, V> = {
    _tag: "Attribute",
    key,
    type,
    valueType,
    sensitive: false,
    encode,
    node: nodeOf(key, type, false, refs),
    // The spread loses `O`'s literal cardinality, which `CardinalityOf<O>` restores.
    required(options) {
      return use(this, { ...options, required: true }) as Use<Definition<K, V>, never, true>;
    },
    many(options) {
      return use(this, { ...options, cardinality: "many" }) as Use<Definition<K, V>, "many", never>;
    },
    unique(options) {
      return use(this, { ...options, unique: true }) as Use<Definition<K, V>, never, never>;
    },
  };
  return definition;
};

/**
 * Declare an attribute's values sensitive: sealed at rest through a
 * `ValueCodec`, returned sealed by every read, and usable by Datalog only for
 * presence and keyed equality. See the sensitive values reference.
 *
 * Sensitivity is part of the attribute node's content identity, so marking or
 * unmarking an attribute changes its content ID and appears in any release
 * that adopts it. Reference and blob attributes cannot be sensitive.
 */
export const sensitive = <const K extends string, V>(
  definition: Definition<K, V>,
): Definition<K, V> => {
  if (!SEALABLE.has(definition.valueType)) {
    throw new TypeError(
      `Attribute ${definition.key} stores ${definition.valueType} values, which cannot be sensitive; only string, number, boolean, datetime and json values can be sealed`,
    );
  }
  if (definition.sensitive) return definition;
  return {
    ...definition,
    sensitive: true,
    node: nodeOf(definition.key, definition.type, true, []),
  };
};

/** The sealed plaintext type of a sensitive definition. */
export const sealableValueType = (definition: AnyDefinition): SealableValueType =>
  definition.valueType as SealableValueType;

export const text = <const K extends string>(key: K): Definition<K, string> =>
  make(key, TypeExpr.text, "string", Values.string);

export const number = <const K extends string>(key: K): Definition<K, number> =>
  make(key, TypeExpr.number, "number", Values.number);

export const integer = <const K extends string>(key: K): Definition<K, number> =>
  make(key, TypeExpr.integer, "number", Values.number);

export const boolean = <const K extends string>(key: K): Definition<K, boolean> =>
  make(key, TypeExpr.boolean, "boolean", Values.boolean);

export const date = <const K extends string>(key: K): Definition<K, string> =>
  make(key, TypeExpr.date, "string", Values.string);

export const instant = <const K extends string>(key: K): Definition<K, number | Date> =>
  make(key, TypeExpr.instant, "datetime", Values.datetime);

export const enumOf = <const K extends string, const V extends string>(
  key: K,
  values: ReadonlyArray<V>,
): Definition<K, V> =>
  make(key, TypeExpr.enumOf(values), "string", (value) => Values.string(value));

/** A relation attribute whose values are entity ids of `target`. */
export const ref = <const K extends string, const Target extends ReferenceTarget>(
  key: K,
  target: Target,
): Definition<K, EntityId> => ({
  ...make(key, TypeExpr.ref(target.entityType), "ref", Values.ref, [
    {
      rel: "references-entity-type",
      kind: "entity-schema",
      key: target.entityType,
    },
  ]),
  target,
});

/** Requiredness and cardinality belong to an entity's use, not the global attribute. */
export const use = <D extends AnyDefinition, const O extends UseOptions = {}>(
  attribute: D,
  options?: O,
): Use<D, CardinalityOf<O>, RequiredOf<O>> => ({
  _tag: "AttributeUse",
  attribute,
  required: (options?.required ?? false) as RequiredOf<O>,
  cardinality: (options?.cardinality ?? "one") as CardinalityOf<O>,
  unique: options?.unique ?? false,
});

/** A typed fact descriptor; spread it into an `assert` operation with an entity id. */
export const assertion = <D extends AnyDefinition>(
  definition: D,
  value: ValueOf<D>,
  options: AssertionOptions = {},
): Assertion<D["key"]> => {
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
    throw new RangeError(
      "validTo must be later than validFrom; intervals are [validFrom, validTo)",
    );
  }

  return {
    attribute: definition.key,
    value: definition.encode(value),
    ...(options.validFrom !== undefined && { validFrom: options.validFrom }),
    ...(options.validTo !== undefined && { validTo: options.validTo }),
  };
};
