import { EntityId, type Triple, type TripleValue } from "@triplex-build/triplex";
import { Attribute, CanonicalJson, EntityType, TypeSchema } from "@triplex-build/triplex/config";
import { Effect, Schema } from "effect";

import type { AttributeDescriptor, EntityDescriptor } from "./ConfigApi.js";
import { DataShapeConflictError, RequestValidationError } from "./Errors.js";

export interface EntityDocument {
  readonly id: string;
  readonly type: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

const requestError = (path: string, message: string) =>
  new RequestValidationError({ code: "http.invalid-request", path, message });

const conflict = (entityId: string, path: string, message: string) =>
  new DataShapeConflictError({ code: "http.data-shape-conflict", entityId, path, message });

/** Response marker for a sealed (sensitive) value: no plaintext, ciphertext, or blind token. */
export interface SealedMarker {
  readonly $sealed: { readonly valueType: string; readonly keyId: string };
}

const SealedMarkerSchema = Schema.Struct({
  $sealed: Schema.Struct({ valueType: Schema.String, keyId: Schema.String }),
}).annotate({
  identifier: "SealedValue",
  description: "A sensitive value sealed at rest. Plaintext is never returned by this API.",
});

const valueSchema = (
  attribute: AttributeDescriptor,
  mode: "input" | "output",
): Schema.Codec<unknown, unknown> => {
  const scalar =
    mode === "output" && attribute.sensitive
      ? (SealedMarkerSchema as unknown as Schema.Codec<unknown, unknown>)
      : TypeSchema.compile(attribute.type);
  return attribute.cardinality === "many"
    ? (Schema.Array(scalar) as Schema.Codec<unknown, unknown>)
    : scalar;
};

// Reject undeclared keys in the schema itself: Effect 4 stable no longer
// applies parseOptions annotations, including inside HttpApi payloads.
const closedStruct = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(Schema.Union([Schema.String, Schema.Symbol]), Schema.Unknown),
  ]).check(Schema.isPropertyNames(Schema.Literals(Object.keys(fields))));

export const attributesSchema = (
  entity: EntityDescriptor,
  mode: "input" | "output" = "input",
): Schema.Codec<unknown, unknown> => {
  const fields = Object.fromEntries(
    entity.attributes.map((attribute) => [
      attribute.key,
      attribute.required
        ? valueSchema(attribute, mode)
        : Schema.optional(valueSchema(attribute, mode)),
    ]),
  ) as Schema.Struct.Fields;
  const sealed = mode === "output" && entity.attributes.some((attribute) => attribute.sensitive);
  return closedStruct(fields).annotate({
    identifier: `${entity.entityType}${sealed ? "Sealed" : ""}Attributes`,
  }) as unknown as Schema.Codec<unknown, unknown>;
};

export const inputSchema = (entity: EntityDescriptor): Schema.Codec<unknown, unknown> =>
  closedStruct({ attributes: attributesSchema(entity, "input") }).annotate({
    identifier: `${entity.entityType}Input`,
  }) as Schema.Codec<unknown, unknown>;

export const outputSchema = (entity: EntityDescriptor): Schema.Codec<unknown, unknown> =>
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal(entity.entityType),
    attributes: attributesSchema(entity, "output"),
  }).annotate({ identifier: entity.entityType }) as Schema.Codec<unknown, unknown>;

const normalize = (
  attribute: AttributeDescriptor,
  value: unknown,
  path: string,
): Effect.Effect<unknown, RequestValidationError> =>
  TypeSchema.normalize(attribute.type, value).pipe(
    Effect.mapError((error) => requestError(path, error.message)),
    Effect.flatMap((normalized) =>
      attribute.storage === "ref"
        ? EntityId.decode(normalized as string).pipe(
            Effect.mapError((error) => requestError(path, error.message)),
          )
        : Effect.succeed(normalized),
    ),
  );

const tripleValue = (attribute: AttributeDescriptor, value: unknown): TripleValue => {
  switch (attribute.storage) {
    case "string":
      return { type: "string", value: value as string };
    case "number":
      return { type: "number", value: value as number };
    case "boolean":
      return { type: "boolean", value: value as boolean };
    case "datetime":
      return { type: "datetime", value: value as number };
    case "ref":
      return { type: "ref", value: EntityId.make(value as string) };
    case "json":
      return { type: "json", value };
  }
};

const canonical = (value: unknown): string =>
  CanonicalJson.encodeOrThrow(value as CanonicalJson.CanonicalValue);

export const decodeInput = (
  entity: EntityDescriptor,
  body: unknown,
): Effect.Effect<
  ReadonlyMap<AttributeDescriptor, ReadonlyArray<TripleValue>>,
  RequestValidationError
> =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(inputSchema(entity))(body).pipe(
      Effect.mapError((error) => requestError("$", error.message)),
    );
    const record = (parsed as { readonly attributes: Readonly<Record<string, unknown>> })
      .attributes;
    const result = new Map<AttributeDescriptor, ReadonlyArray<TripleValue>>();
    for (const attribute of entity.attributes) {
      const raw = record[attribute.key];
      if (raw === undefined) continue;
      const values = attribute.cardinality === "many" ? (raw as readonly unknown[]) : [raw];
      if (attribute.required && values.length === 0) {
        return yield* requestError(
          `$.attributes[${JSON.stringify(attribute.key)}]`,
          "A required cardinality-many attribute must contain at least one value",
        );
      }
      const normalized = yield* Effect.forEach(values, (value, index) =>
        normalize(
          attribute,
          value,
          `$.attributes[${JSON.stringify(attribute.key)}]${attribute.cardinality === "many" ? `[${index}]` : ""}`,
        ),
      );
      const distinct = [...new Map(normalized.map((value) => [canonical(value), value])).entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, value]) => tripleValue(attribute, value));
      result.set(attribute, distinct);
    }
    if ([...result.values()].every((values) => values.length === 0)) {
      return yield* requestError(
        "$.attributes",
        "An entity must contain at least one application fact",
      );
    }
    return result;
  });

// Rehydrate only the public model declaration; all stored-value decoding lives in core.
const decoders = new WeakMap<EntityDescriptor, ReturnType<typeof entityDecoder>>();
const entityDecoder = (entity: EntityDescriptor) =>
  EntityType.make(
    entity.entityType,
    Object.fromEntries(
      entity.attributes.map((attribute) => {
        const definition = {
          ...Attribute.text(attribute.key),
          type: attribute.type,
          valueType: attribute.storage,
          sensitive: attribute.sensitive,
          encode: (value: unknown) => tripleValue(attribute, value),
        };
        return [
          attribute.key,
          Attribute.use(definition, {
            required: attribute.required,
            cardinality: attribute.cardinality,
            unique: attribute.unique,
          }),
        ];
      }),
    ),
  );

/** Adapt the shared core entity decoder to the HTTP document and diagnostic envelope. */
export const encodeEntity = (
  entity: EntityDescriptor,
  facts: readonly Triple[],
): Effect.Effect<EntityDocument, DataShapeConflictError> =>
  Effect.gen(function* () {
    let decoder = decoders.get(entity);
    if (decoder === undefined) {
      decoder = entityDecoder(entity);
      decoders.set(entity, decoder);
    }
    const entityId = facts[0]?.entityId ?? "";
    const decoded = yield* decoder
      .decode(facts, {
        scalarCardinality: "distinct",
        factValidation: "membership",
        valueDiagnostics: "detailed",
      })
      .pipe(
        Effect.mapError((error) =>
          conflict(
            entityId,
            error.reason === "entityType"
              ? "$.type"
              : error.alias === undefined
                ? "$"
                : `$.attributes[${JSON.stringify(error.alias)}]`,
            error.message,
          ),
        ),
      );
    const attributes: Record<string, unknown> = {};
    for (const attribute of entity.attributes) {
      const value = decoded[attribute.key];
      if (
        value !== undefined &&
        !(attribute.cardinality === "many" && (value as readonly unknown[]).length === 0)
      )
        attributes[attribute.key] = value;
    }
    return { id: entityId, type: entity.entityType, attributes };
  });
