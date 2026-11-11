/**
 * Sensitive attribute values: policy, the sealing `Triples` decorator, and the
 * single explicit way to open sealed values.
 */

import { Context, Effect, Layer, Option } from "effect";

import type * as Attribute from "../config/Attribute.js";
import type * as ConfigNode from "../config/ConfigNode.js";
import type * as TypeExpr from "../config/TypeExpr.js";
import type { DatalogQuery, WrappedQuery } from "../datalog/types.js";
import { validateDatalogQuery, validateWrappedQuery } from "../datalog/validation.js";
import {
  ReadError,
  SensitiveQueryError,
  SensitiveValueError,
  WriteError,
  TransactionConflictError,
} from "../errors/index.js";
import type { Pattern } from "../types/Pattern.js";
import { Triples, type TransactionRecord, type TriplesService } from "../store/Triples.js";
import type { TransactOp, Triple } from "../Triple.js";
import type { PlainValue, SealableValueType, SealedValue, TripleValue } from "../Value.js";
import {
  NO_MATCH_BLIND,
  coerceValue,
  prepareQuery,
  prepareWrappedQuery,
  type AnalysisPolicy,
} from "./analysis.js";
import { ValueCodec, type SensitiveContext, type ValueCodecService } from "./ValueCodec.js";

// =============================================================================
// Policy
// =============================================================================

/** Sensitive attribute keyword → declared plaintext value type. */
export type SensitiveAttributes = ReadonlyMap<string, SealableValueType>;

/** An explicit `{ key, valueType }` descriptor, for hosts without DSL definitions. */
export interface AttributeDescriptor {
  readonly key: string;
  readonly valueType: SealableValueType;
}

/**
 * A source of sensitive attributes: an `Attribute` definition (included only
 * when marked with `Attribute.sensitive`), an `EntityType` (its sensitive
 * attributes), or an explicit descriptor.
 */
export type PolicySource =
  | Attribute.AnyDefinition
  | { readonly entityType: string; readonly attributes: object }
  | AttributeDescriptor;

const isDefinition = (source: PolicySource): source is Attribute.AnyDefinition =>
  "_tag" in source && source._tag === "Attribute";

const isEntityType = (
  source: PolicySource,
): source is { readonly entityType: string; readonly attributes: object } =>
  "entityType" in source && "attributes" in source;

/** Collect sensitive attributes from definitions, entity types and descriptors. */
export const attributesOf = (sources: readonly PolicySource[]): SensitiveAttributes => {
  const out = new Map<string, SealableValueType>();
  const add = (key: string, valueType: SealableValueType) => {
    const existing = out.get(key);
    if (existing !== undefined && existing !== valueType) {
      throw new TypeError(
        `Sensitive attribute ${key} is declared as both ${existing} and ${valueType}`,
      );
    }
    out.set(key, valueType);
  };
  for (const source of sources) {
    if (isDefinition(source)) {
      if (source.sensitive) add(source.key, source.valueType as SealableValueType);
    } else if (isEntityType(source)) {
      for (const handle of Object.values(source.attributes) as ReadonlyArray<{
        readonly definition: Attribute.AnyDefinition;
      }>) {
        if (handle.definition.sensitive) {
          add(handle.definition.key, handle.definition.valueType as SealableValueType);
        }
      }
    } else {
      add(source.key, source.valueType);
    }
  }
  return out;
};

const storedTypeOf = (type: TypeExpr.TypeExpr): SealableValueType | undefined => {
  switch (type._tag) {
    case "Prim":
      return type.prim === "text" || type.prim === "date"
        ? "string"
        : type.prim === "number" || type.prim === "integer"
          ? "number"
          : type.prim === "boolean"
            ? "boolean"
            : "datetime";
    case "Enum":
      return "string";
    case "Constrained":
      return storedTypeOf(type.base);
    default:
      return undefined;
  }
};

/**
 * Collect sensitive attributes from configuration nodes, such as every node
 * in a pinned release. Attribute nodes carry `sensitive: true` in their
 * content-addressed attributes, so the release is the source of truth.
 */
export const attributesFromNodes = (
  nodes: ReadonlyArray<ConfigNode.ConfigNode>,
): SensitiveAttributes => {
  const out = new Map<string, SealableValueType>();
  for (const node of nodes) {
    if (node.kind !== "attribute") continue;
    const attrs = node.attrs as {
      readonly sensitive?: boolean;
      readonly valueType?: TypeExpr.TypeExpr;
    } | null;
    if (attrs?.sensitive !== true || attrs.valueType === undefined) continue;
    const valueType = storedTypeOf(attrs.valueType);
    if (valueType === undefined) {
      throw new TypeError(`Sensitive attribute ${node.key} has a value type that cannot be sealed`);
    }
    out.set(node.key, valueType);
  }
  return out;
};

// =============================================================================
// Sensitivity service
// =============================================================================

export interface OpenOptions {
  /**
   * What to do with a value whose key was destroyed (an erased subject):
   * `fail` (default) or `keep-sealed`, which leaves it sealed so an erased
   * value can be rendered without failing the whole read.
   */
  readonly erased?: "fail" | "keep-sealed";
}

export interface SensitivityService {
  readonly database: string;
  readonly attributes: SensitiveAttributes;
  readonly codec: ValueCodecService;
  readonly isSensitive: (attribute: string) => boolean;
  /**
   * Seal an assertion value when its attribute is sensitive. Rejects any
   * caller-supplied sealed value and any value of the wrong declared type.
   */
  readonly sealValue: (
    entityId: string,
    attribute: string,
    value: TripleValue,
  ) => Effect.Effect<TripleValue, SensitiveValueError>;
  /** Rewrite a pattern's plaintext value on a sensitive attribute to a blind match. */
  readonly preparePattern: (pattern: Pattern) => Effect.Effect<Pattern, SensitiveQueryError>;
  readonly prepareQuery: (query: DatalogQuery) => Effect.Effect<DatalogQuery, SensitiveQueryError>;
  readonly prepareWrappedQuery: (
    query: WrappedQuery,
  ) => Effect.Effect<WrappedQuery, SensitiveQueryError>;
  /** Open one sealed value. Plaintext values pass through. */
  readonly openValue: (
    entityId: string,
    attribute: string,
    value: TripleValue,
    options?: OpenOptions,
  ) => Effect.Effect<TripleValue, SensitiveValueError>;
}

export class Sensitivity extends Context.Service<Sensitivity, SensitivityService>()(
  "triplex/sensitive/Sensitivity",
) {}

/** A sealed value used only to select facts by blind token. */
const blindScanValue = (valueType: SealableValueType, blind: string): SealedValue => ({
  type: "sealed",
  valueType,
  keyId: "",
  ciphertext: "",
  blind,
});

export const makeSensitivity = (options: {
  readonly database: string;
  readonly attributes: SensitiveAttributes;
  readonly codec: ValueCodecService;
}): SensitivityService => {
  const { database, attributes, codec } = options;
  const contextOf = (
    entityId: string,
    attribute: string,
    valueType: SealableValueType,
  ): SensitiveContext => ({ database, entityId, attribute, valueType });

  const blindFor = (attribute: string, value: PlainValue) =>
    codec.blind(contextOf("", attribute, attributes.get(attribute)!), value).pipe(
      Effect.mapError(
        (cause) =>
          new SensitiveQueryError({
            attribute,
            operation: "blind-index-unavailable",
            message: `Could not compute the blind token for sensitive attribute ${attribute}: ${cause.reason}`,
            cause,
          }),
      ),
    );

  const policy: AnalysisPolicy = { attributes, blindScope: codec.blindScope, blind: blindFor };

  const sealValue: SensitivityService["sealValue"] = (entityId, attribute, value) => {
    const valueType = attributes.get(attribute);
    if (value.type === "sealed") {
      return Effect.fail(
        new SensitiveValueError({
          attribute,
          entityId,
          reason: "sealed-input",
          message: `${attribute}: sealed values cannot be written directly; write plaintext and let the store seal it`,
        }),
      );
    }
    if (valueType === undefined) return Effect.succeed(value);
    const coerced = coerceValue(valueType, value);
    if (coerced === undefined) {
      return Effect.fail(
        new SensitiveValueError({
          attribute,
          entityId,
          reason: "invalid-value",
          message: `${attribute}: expected a ${valueType} value, received ${value.type}`,
        }),
      );
    }
    return codec.seal(contextOf(entityId, attribute, valueType), coerced).pipe(
      Effect.map(
        (sealed): SealedValue => ({
          type: "sealed",
          valueType,
          keyId: sealed.keyId,
          ciphertext: sealed.ciphertext,
          ...(sealed.blind === undefined ? {} : { blind: sealed.blind }),
        }),
      ),
    );
  };

  const preparePattern: SensitivityService["preparePattern"] = (pattern) =>
    Effect.gen(function* () {
      const value = pattern.value;
      if (value === undefined || "_tag" in value || value.type === "sealed") return pattern;
      if (typeof pattern.attribute !== "string") {
        if (attributes.size === 0) return pattern;
        return yield* new SensitiveQueryError({
          attribute: "*",
          operation: "value-only-match",
          message:
            "A value match without an attribute could compare a sensitive attribute with plaintext; name the attribute",
        });
      }
      const valueType = attributes.get(pattern.attribute);
      if (valueType === undefined) return pattern;
      if (codec.blindScope === "none") {
        return yield* new SensitiveQueryError({
          attribute: pattern.attribute,
          operation: "blind-index-unavailable",
          message: `Equality on sensitive attribute ${pattern.attribute} needs a blind index, but the configured codec has none`,
        });
      }
      const coerced = coerceValue(valueType, value);
      const blind =
        coerced === undefined ? NO_MATCH_BLIND : yield* blindFor(pattern.attribute, coerced);
      return { ...pattern, value: blindScanValue(valueType, blind ?? NO_MATCH_BLIND) };
    });

  const openValue: SensitivityService["openValue"] = (entityId, attribute, value, openOptions) => {
    if (value.type !== "sealed") return Effect.succeed(value);
    return codec.open(contextOf(entityId, attribute, value.valueType), value).pipe(
      Effect.map((opened): TripleValue => opened),
      Effect.catchIf(
        (error) => error.reason === "key-destroyed" && openOptions?.erased === "keep-sealed",
        () => Effect.succeed(value),
      ),
    );
  };

  return {
    database,
    attributes,
    codec,
    isSensitive: (attribute) => attributes.has(attribute),
    sealValue,
    preparePattern,
    prepareQuery: (query) => prepareQuery(policy, query),
    prepareWrappedQuery: (query) => prepareWrappedQuery(policy, query),
    openValue,
  };
};

// =============================================================================
// Triples decorator
// =============================================================================

const asWriteError = (cause: SensitiveQueryError | SensitiveValueError) =>
  new WriteError({ message: cause.message, cause });

const asReadError = (cause: SensitiveQueryError) =>
  new ReadError({ message: cause.message, cause });

/**
 * Write-side sensitive failures surface as `WriteError` whose `cause` is the
 * typed `SensitiveValueError` (or `SensitiveQueryError`) naming the attribute,
 * so the `Triples` write signature is unchanged.
 */
/**
 * Seal sensitive values in a transaction's operations and check enforced
 * rules. Pure with respect to storage: the inner store sees only sealed values.
 */
const prepareOperations = (
  sensitivity: SensitivityService,
  operations: readonly TransactOp[],
): Effect.Effect<readonly TransactOp[], SensitiveValueError | SensitiveQueryError> =>
  Effect.forEach(
    operations,
    (op): Effect.Effect<TransactOp, SensitiveValueError | SensitiveQueryError> => {
      switch (op.op) {
        case "assert":
          return sensitivity
            .sealValue(op.entityId, op.attribute, op.value)
            .pipe(Effect.map((value) => ({ ...op, value })));
        case "retract":
        case "append-entry":
        case "acknowledge-entry":
          return Effect.succeed(op);
        case "retract-pattern":
          return sensitivity.preparePattern(op.pattern as Pattern).pipe(
            Effect.map((pattern) => ({
              ...op,
              pattern: {
                ...op.pattern,
                ...(pattern.value === undefined ? {} : { value: pattern.value as TripleValue }),
              },
            })),
          );
      }
    },
  );

const decorate = (inner: TriplesService, sensitivity: SensitivityService): TriplesService => {
  const transact: TriplesService["transact"] = (operations, meta) =>
    Effect.gen(function* () {
      for (const rule of meta?.enforce?.constraints ?? []) {
        if (
          rule._tag === "Unique" &&
          sensitivity.isSensitive(rule.attribute) &&
          sensitivity.codec.blindScope === "none"
        ) {
          return yield* asWriteError(
            new SensitiveValueError({
              attribute: rule.attribute,
              reason: "blind-index-unavailable",
              message: `${rule.attribute}: uniqueness of a sensitive attribute needs a blind index, but the configured codec has none`,
            }),
          );
        }
      }
      const prepared = yield* prepareOperations(sensitivity, operations).pipe(
        Effect.mapError(asWriteError),
      );
      const preconditions = yield* Effect.forEach(meta?.preconditions ?? [], (condition) =>
        Effect.gen(function* () {
          if (condition._tag !== "AttributeValue") return condition;
          const pattern = yield* sensitivity
            .preparePattern({
              entityId: condition.entityId,
              attribute: condition.attribute,
              value: condition.value,
            })
            .pipe(Effect.mapError(asWriteError));
          return { ...condition, value: pattern.value as TripleValue };
        }),
      );
      return yield* inner.transact(
        prepared,
        meta === undefined ? undefined : { ...meta, preconditions },
      );
    });

  const writeOnly = <A>(
    effect: Effect.Effect<A, unknown>,
  ): Effect.Effect<A, WriteError | TransactionConflictError> =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause instanceof WriteError || cause instanceof TransactionConflictError
          ? cause
          : cause instanceof SensitiveValueError || cause instanceof SensitiveQueryError
            ? asWriteError(cause)
            : new WriteError({ message: "Sensitive write failed", cause }),
      ),
    );

  const preparePattern = (pattern: Pattern) =>
    sensitivity.preparePattern(pattern).pipe(Effect.mapError(asReadError));

  return {
    ...inner,
    assert: (input) =>
      writeOnly(transact([{ op: "assert", ...input }]).pipe(Effect.map((r) => r.triples[0]!))),
    assertBatch: (inputs) =>
      inputs.length === 0
        ? Effect.succeed([])
        : writeOnly(
            transact(inputs.map((input) => ({ op: "assert" as const, ...input }))).pipe(
              Effect.map((r) => r.triples),
            ),
          ),
    retractByPattern: (pattern) =>
      sensitivity.preparePattern(pattern).pipe(
        Effect.mapError(asWriteError),
        Effect.flatMap((prepared) => inner.retractByPattern(prepared)),
      ),
    transact,
    match: (pattern, basis) =>
      preparePattern(pattern).pipe(Effect.flatMap((prepared) => inner.match(prepared, basis))),
    queryAll: (query, options) =>
      validateDatalogQuery(query).pipe(
        Effect.flatMap(sensitivity.prepareQuery),
        Effect.flatMap((prepared) => inner.queryAll(prepared, options)),
      ),
    query: (query, options) =>
      validateDatalogQuery(query).pipe(
        Effect.flatMap(sensitivity.prepareQuery),
        Effect.flatMap((prepared) => inner.query(prepared, options)),
      ),
    queryPage: (query, options) =>
      validateWrappedQuery(query).pipe(
        Effect.flatMap(sensitivity.prepareWrappedQuery),
        Effect.flatMap((prepared) => inner.queryPage(prepared, options)),
      ),
    explain: (query) =>
      validateDatalogQuery(query).pipe(
        Effect.flatMap(sensitivity.prepareQuery),
        Effect.flatMap(inner.explain),
      ),
    explainPage: (query) =>
      validateWrappedQuery(query).pipe(
        Effect.flatMap(sensitivity.prepareWrappedQuery),
        Effect.flatMap(inner.explainPage),
      ),
  };
};

export interface LayerOptions {
  /**
   * Stable logical database identity given to the codec. It scopes keys and
   * blind tokens and is bound into every ciphertext, so it must not change for
   * the life of the database.
   */
  readonly database: string;
  /** Sensitive attribute sources. Non-sensitive definitions are ignored. */
  readonly attributes: readonly PolicySource[] | SensitiveAttributes;
}

const resolveAttributes = (
  attributes: readonly PolicySource[] | SensitiveAttributes,
): SensitiveAttributes =>
  attributes instanceof Map ? attributes : attributesOf(attributes as readonly PolicySource[]);

/**
 * Decorate `Triples` so sensitive attribute values are sealed by the
 * `ValueCodec` before they reach storage, every read returns them sealed,
 * and Datalog over them is checked during planning. Also provides
 * `Sensitivity`, which `open` and derivation overlays use.
 *
 * There is no implicit codec: provide `ValueCodec.aesGcm` (with a
 * `KeyProvider`) or, for development only, `ValueCodec.identity`.
 */
export const layer = (
  options: LayerOptions,
): Layer.Layer<Triples | Sensitivity, never, Triples | ValueCodec> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const inner = yield* Triples;
      const codec = yield* ValueCodec;
      const sensitivity = makeSensitivity({
        database: options.database,
        attributes: resolveAttributes(options.attributes),
        codec,
      });
      return Context.make(Triples, decorate(inner, sensitivity)).pipe(
        Context.add(Sensitivity, sensitivity),
      );
    }),
  );

// =============================================================================
// Opening
// =============================================================================

const openTriple = (
  sensitivity: SensitivityService,
  triple: Triple,
  options?: OpenOptions,
): Effect.Effect<Triple, SensitiveValueError> =>
  triple.value.type === "sealed"
    ? sensitivity
        .openValue(triple.entityId, triple.attribute, triple.value, options)
        .pipe(Effect.map((value) => ({ ...triple, value })))
    : Effect.succeed(triple);

const isTransactionRecord = (input: unknown): input is TransactionRecord =>
  typeof input === "object" && input !== null && "changes" in input && "position" in input;

/**
 * The only way to turn sealed values into plaintext. Accepts a triple, an
 * array of triples, or a transaction record; non-sealed values pass through.
 * Hosts authorize and audit this call.
 */
export const open: {
  (triple: Triple, options?: OpenOptions): Effect.Effect<Triple, SensitiveValueError, Sensitivity>;
  (
    triples: readonly Triple[],
    options?: OpenOptions,
  ): Effect.Effect<readonly Triple[], SensitiveValueError, Sensitivity>;
  (
    record: TransactionRecord,
    options?: OpenOptions,
  ): Effect.Effect<TransactionRecord, SensitiveValueError, Sensitivity>;
} = ((input: Triple | readonly Triple[] | TransactionRecord, options?: OpenOptions) =>
  Effect.gen(function* () {
    const sensitivity = yield* Sensitivity;
    if (Array.isArray(input)) {
      return yield* Effect.forEach(input as readonly Triple[], (triple) =>
        openTriple(sensitivity, triple, options),
      );
    }
    if (isTransactionRecord(input)) {
      const changes = yield* Effect.forEach(input.changes, (change) =>
        change.value === undefined || change.value.type !== "sealed"
          ? Effect.succeed(change)
          : sensitivity
              .openValue(change.entityId, change.attribute, change.value, options)
              .pipe(Effect.map((value) => ({ ...change, value }))),
      );
      return { ...input, changes };
    }
    return yield* openTriple(sensitivity, input as Triple, options);
  })) as never;

/** The `Sensitivity` service when this runtime has one. */
export const current: Effect.Effect<Option.Option<SensitivityService>> =
  Effect.serviceOption(Sensitivity);
