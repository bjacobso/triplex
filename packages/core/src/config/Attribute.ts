/** Globally identified runtime attribute definitions and usage-local constraints. */

import { Effect, type Schema } from "effect";

import type { PlainValue, SealableValueType, TripleValue } from "../Value.js";
import type { EntityId } from "../Branded.js";
import * as Values from "../Value.js";
import { validateAssertionBounds } from "../Triple.js";
import * as ConfigNode from "./ConfigNode.js";
import * as TypeExpr from "./TypeExpr.js";

export const KIND = "attribute";

const ATTRIBUTE_KEY = /^:[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/;

export interface AssertionOptions {
  /** Start of the domain-valid interval, in integer epoch milliseconds (inclusive). */
  readonly validFrom?: number | undefined;
  /** End of the domain-valid interval, in integer epoch milliseconds (exclusive). */
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
  readonly nodes?: Effect.Effect<
    ReadonlyArray<ConfigNode.ConfigNode>,
    | ConfigNode.DuplicateChildKeyError
    | import("../content/CanonicalJson.js").CanonicalEncodingError
    | Schema.SchemaError
  >;
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
  /**
   * The key class of a sensitive attribute. Values of one subject in different
   * key classes are sealed under different data keys, so one class can be
   * erased while another is kept. Part of the node's content identity.
   */
  readonly keyClass?: string;
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
  readonly isRequired: R;
  readonly cardinality: C;
  readonly isUnique: boolean;
  /** Require this use, preserving cardinality and uniqueness. */
  readonly required: () => Use<D, C, true>;
  /** Allow many values, preserving requiredness and uniqueness. */
  readonly many: () => Use<D, "many", R>;
  /** Require unique values, preserving cardinality and requiredness. */
  readonly unique: () => Use<D, C, R>;
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

/** Sensitive attribute nodes with a key class; those without keep the shape above. */
const KeyClassDefinitionType = TypeExpr.struct({
  key: TypeExpr.required(TypeExpr.text),
  valueType: TypeExpr.required(TypeExpr.any),
  sensitive: TypeExpr.required(TypeExpr.boolean),
  keyClass: TypeExpr.required(TypeExpr.text),
});

/** Key classes appear in key IDs and erasure records, so they are short plain labels. */
const KEY_CLASS = /^[a-z][a-z0-9_-]{0,62}$/;

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
  keyClass?: string,
) =>
  ConfigNode.makeTyped({
    kind: KIND,
    key,
    type: !sensitive
      ? DefinitionType
      : keyClass === undefined
        ? SensitiveDefinitionType
        : KeyClassDefinitionType,
    attrs: !sensitive
      ? { key, valueType: type }
      : keyClass === undefined
        ? { key, valueType: type, sensitive: true }
        : { key, valueType: type, sensitive: true, keyClass },
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
 *
 * `keyClass` groups attributes that share a data key per subject, for example
 * by retention period: `Attribute.sensitive(ssn, { keyClass: "retention-7y" })`.
 * Erasing a subject's key class leaves its other classes readable. Without a
 * key class, the attribute uses the subject's default key.
 */
export const sensitive = <const K extends string, V>(
  definition: Definition<K, V>,
  options: SensitiveOptions = {},
): Definition<K, V> => {
  if (!SEALABLE.has(definition.valueType)) {
    throw new TypeError(
      `Attribute ${definition.key} stores ${definition.valueType} values, which cannot be sensitive; only string, number, boolean, datetime and json values can be sealed`,
    );
  }
  const { keyClass } = options;
  if (keyClass === "default") {
    throw new TypeError(
      `Attribute ${definition.key}: "default" is the key class of attributes declared without one; omit keyClass instead`,
    );
  }
  if (keyClass !== undefined && !KEY_CLASS.test(keyClass)) {
    throw new TypeError(
      `Attribute ${definition.key}: key class must be a short lowercase label such as retention-7y; received ${keyClass}`,
    );
  }
  if (definition.sensitive && definition.keyClass === keyClass) return definition;
  if (definition.sensitive) {
    throw new TypeError(
      `Attribute ${definition.key} is already sensitive with key class ${definition.keyClass ?? "(default)"}`,
    );
  }
  return {
    ...definition,
    sensitive: true,
    ...(keyClass === undefined ? {} : { keyClass }),
    node: nodeOf(definition.key, definition.type, true, [], keyClass),
  };
};

export interface SensitiveOptions {
  /** A short lowercase label naming the data key group, such as `retention-7y`. */
  readonly keyClass?: string;
}

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

/** Immutable use builder; methods live on the prototype, outside the usage data. */
class AttributeUse<
  D extends AnyDefinition,
  C extends Cardinality,
  R extends boolean,
> implements Use<D, C, R> {
  readonly _tag = "AttributeUse";

  constructor(
    readonly attribute: D,
    readonly cardinality: C,
    readonly isRequired: R,
    readonly isUnique: boolean,
  ) {}

  required(): Use<D, C, true> {
    return new AttributeUse(this.attribute, this.cardinality, true, this.isUnique);
  }

  many(): Use<D, "many", R> {
    return new AttributeUse(this.attribute, "many", this.isRequired, this.isUnique);
  }

  unique(): Use<D, C, R> {
    return new AttributeUse(this.attribute, this.cardinality, this.isRequired, true);
  }
}

/** Requiredness and cardinality belong to an entity's use, not the global attribute. */
export const use = <D extends AnyDefinition, const O extends UseOptions = {}>(
  attribute: D,
  options?: O,
): Use<D, CardinalityOf<O>, RequiredOf<O>> =>
  new AttributeUse(
    attribute,
    (options?.cardinality ?? "one") as CardinalityOf<O>,
    (options?.required ?? false) as RequiredOf<O>,
    options?.unique ?? false,
  );

/** A typed fact descriptor; spread it into an `assert` operation with an entity id. */
export const assertion = <D extends AnyDefinition>(
  definition: D,
  value: ValueOf<D>,
  options: AssertionOptions = {},
): Assertion<D["key"]> => {
  const invalid = validateAssertionBounds(options);
  if (invalid) throw invalid;
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
