import { EntityId, type Triple, type TripleValue } from "@triplex-build/triplex";
import { CanonicalJson, TypeSchema } from "@triplex-build/triplex/config";
import { Effect, Option, Result, Schema } from "effect";

import type { AttributeDescriptor, EntityDescriptor } from "./ConfigApi.js";
import { DataShapeConflictError, RequestValidationError } from "./Errors.js";

export interface EntityDocument {
  readonly id: string;
  readonly type: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

const requestError = (path: string, message: string) =>
  new RequestValidationError({ code: "invalid_request", path, message });

const conflict = (entityId: string, path: string, message: string) =>
  new DataShapeConflictError({ code: "data_shape_conflict", entityId, path, message });

const valueSchema = (attribute: AttributeDescriptor): Schema.Codec<unknown, unknown> => {
  const scalar = TypeSchema.compile(attribute.type);
  return attribute.cardinality === "many"
    ? (Schema.Array(scalar) as Schema.Codec<unknown, unknown>)
    : scalar;
};

export const attributesSchema = (entity: EntityDescriptor): Schema.Codec<unknown, unknown> => {
  const fields = Object.fromEntries(
    entity.attributes.map((attribute) => [
      attribute.key,
      attribute.required ? valueSchema(attribute) : Schema.optional(valueSchema(attribute)),
    ]),
  ) as Schema.Struct.Fields;
  return Schema.Struct(fields).annotate({
    identifier: `${entity.entityType}Attributes`,
    parseOptions: { onExcessProperty: "error" },
  }) as unknown as Schema.Codec<unknown, unknown>;
};

export const inputSchema = (entity: EntityDescriptor): Schema.Codec<unknown, unknown> =>
  Schema.Struct({ attributes: attributesSchema(entity) }).annotate({
    identifier: `${entity.entityType}Input`,
    parseOptions: { onExcessProperty: "error" },
  }) as Schema.Codec<unknown, unknown>;

export const outputSchema = (entity: EntityDescriptor): Schema.Codec<unknown, unknown> =>
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal(entity.entityType),
    attributes: attributesSchema(entity),
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

const decodeStoredValue = (
  entityId: string,
  attribute: AttributeDescriptor,
  value: TripleValue,
): unknown => {
  if (value.type !== attribute.storage) {
    throw conflict(
      entityId,
      `$.attributes[${JSON.stringify(attribute.key)}]`,
      `Stored ${value.type} value is incompatible with configured ${attribute.storage} storage`,
    );
  }
  const raw = value.value;
  if (attribute.storage === "ref" && typeof raw === "string" && raw.length === 0) {
    throw conflict(
      entityId,
      `$.attributes[${JSON.stringify(attribute.key)}]`,
      "Stored reference is not a valid entity ID",
    );
  }
  const decoded = Schema.decodeUnknownResult(TypeSchema.compile(attribute.type))(raw);
  if (Result.isFailure(decoded)) {
    throw conflict(
      entityId,
      `$.attributes[${JSON.stringify(attribute.key)}]`,
      `Stored value does not satisfy the configured type: ${decoded.failure.message}`,
    );
  }
  return decoded.success;
};

/** Materialize only declared attributes and reject ambiguous or incompatible stored state. */
export const encodeEntity = (
  entity: EntityDescriptor,
  facts: readonly Triple[],
): Effect.Effect<EntityDocument, DataShapeConflictError> =>
  Effect.try({
    try: () => {
      const entityId = facts[0]?.entityId ?? "";
      const memberships = new Set(
        facts.flatMap((fact) => (Option.isSome(fact.entityType) ? [fact.entityType.value] : [])),
      );
      if (!memberships.has(entity.entityType)) {
        throw conflict(entityId, "$.type", `Entity is not a ${entity.entityType}`);
      }
      if ([...memberships].some((membership) => membership !== entity.entityType)) {
        throw conflict(entityId, "$.type", "Mixed entity-type membership is not supported");
      }
      const attributes: Record<string, unknown> = {};
      for (const descriptor of entity.attributes) {
        const values = facts
          .filter((fact) => fact.attribute === descriptor.key)
          .map((fact) => decodeStoredValue(entityId, descriptor, fact.value));
        const distinct = [...new Map(values.map((value) => [canonical(value), value])).entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, value]) => value);
        if (descriptor.cardinality === "one" && distinct.length > 1) {
          throw conflict(
            entityId,
            `$.attributes[${JSON.stringify(descriptor.key)}]`,
            "A scalar attribute has multiple distinct live values",
          );
        }
        if (descriptor.required && distinct.length === 0) {
          throw conflict(
            entityId,
            `$.attributes[${JSON.stringify(descriptor.key)}]`,
            "A required attribute is missing",
          );
        }
        if (distinct.length > 0) {
          attributes[descriptor.key] = descriptor.cardinality === "many" ? distinct : distinct[0];
        }
      }
      return { id: entityId, type: entity.entityType, attributes };
    },
    catch: (error) =>
      error instanceof DataShapeConflictError
        ? error
        : conflict(facts[0]?.entityId ?? "", "$", String(error)),
  });
