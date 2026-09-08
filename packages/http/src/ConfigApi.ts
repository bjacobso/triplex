import {
  Attribute,
  ConfigNode,
  EntityValidation,
  GraphConstraint,
  TypeExpr,
  TypeSchema,
} from "@bjacobso/triplex/config";
import { Effect, Result, Schema } from "effect";

import { ConfigConflictError, type CompileError, UnsupportedConfigError } from "./Errors.js";

export type Operation = "read" | "create" | "replace" | "delete";
export type StorageFamily = "string" | "number" | "boolean" | "datetime" | "ref" | "json";

export interface ExposureOptions {
  /** Entity type to collection path override. Unlisted entities use a deterministic lowercase+s name. */
  readonly collections?: Readonly<Record<string, string>>;
  /** Per-entity operations. Defaults to all four operations. */
  readonly operations?: Readonly<Record<string, ReadonlyArray<Operation>>>;
}

export interface AttributeDescriptor {
  readonly key: string;
  readonly alias: string;
  readonly type: TypeExpr.TypeExpr;
  readonly required: boolean;
  readonly cardinality: "one" | "many";
  readonly unique: boolean;
  readonly storage: StorageFamily;
}

export interface EntityDescriptor {
  readonly entityType: string;
  readonly collection: string;
  readonly attributes: ReadonlyArray<AttributeDescriptor>;
  readonly operations: ReadonlyArray<Operation>;
}

export interface ConfigApiDescriptor {
  readonly protocolVersion: 1;
  readonly snapshotId: import("@bjacobso/triplex/config").ConfigStore.ConfigSnapshot["id"];
  readonly label: string;
  readonly entities: ReadonlyArray<EntityDescriptor>;
  readonly constraints: ReadonlyArray<GraphConstraint.Rule>;
}

const pathSegment = /^[a-z][a-z0-9_-]*$/;
const entityTypeName = /^[A-Z][A-Za-z0-9]*$/;
const attributeKey = /^:[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/;
const reservedCollections = new Set(["schema", "openapi.json", "docs"]);
const allOperations: ReadonlyArray<Operation> = ["read", "create", "replace", "delete"];

const unsupported = (path: string, message: string) =>
  new UnsupportedConfigError({ code: "unsupported_config", path, message });
const conflict = (path: string, message: string) =>
  new ConfigConflictError({ code: "config_conflict", path, message });

const storageFamily = (expr: TypeExpr.TypeExpr, path: string): StorageFamily => {
  switch (expr._tag) {
    case "Prim":
      switch (expr.prim) {
        case "text":
        case "date":
          return "string";
        case "number":
        case "integer":
          return "number";
        case "boolean":
          return "boolean";
        case "instant":
          return "datetime";
      }
    case "Enum":
      return "string";
    case "Ref":
      return "ref";
    case "List":
    case "Struct":
      return "json";
    case "Constrained":
      return storageFamily(expr.base, path);
    case "Union": {
      const families = new Set(expr.members.map((member) => storageFamily(member, path)));
      if (families.size !== 1) {
        throw unsupported(path, "Union members have ambiguous storage encodings");
      }
      return [...families][0]!;
    }
    case "Any":
      throw unsupported(path, "The Any type has no unambiguous REST storage encoding");
  }
};

const objectRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const parseType = (
  value: unknown,
  path: string,
): Effect.Effect<TypeExpr.TypeExpr, UnsupportedConfigError> => {
  const parsed = Schema.decodeUnknownResult(TypeExpr.TypeExprSchema)(value);
  if (Result.isFailure(parsed)) {
    return Effect.fail(unsupported(path, `Invalid TypeExpr: ${parsed.failure.message}`));
  }
  return Effect.succeed(parsed.success);
};

const defaultCollection = (entityType: string): string =>
  `${entityType.slice(0, 1).toLowerCase()}${entityType.slice(1)}s`;

const referenceKinds = (expr: TypeExpr.TypeExpr): ReadonlyArray<string> => {
  switch (expr._tag) {
    case "Ref":
      return [expr.kind];
    case "List":
      return referenceKinds(expr.item);
    case "Struct":
      return Object.values(expr.fields).flatMap((field) => referenceKinds(field.type));
    case "Union":
      return expr.members.flatMap(referenceKinds);
    case "Constrained":
      return referenceKinds(expr.base);
    case "Any":
    case "Prim":
    case "Enum":
      return [];
  }
};

/** Compile only persisted release data; no DSL handles are retained or consulted. */
export const compile = (
  snapshot: import("@bjacobso/triplex/config").ConfigStore.ConfigSnapshot,
  options: ExposureOptions = {},
): Effect.Effect<ConfigApiDescriptor, CompileError> =>
  Effect.gen(function* () {
    const bySlot = new Map<string, ConfigNode.ConfigNode>();
    for (const { node } of ConfigNode.walk(snapshot.root)) {
      const slot = `${node.kind}\u0000${node.key}`;
      const existing = bySlot.get(slot);
      if (existing !== undefined && existing.cid !== node.cid) {
        return yield* conflict(
          `config.${node.kind}.${node.key}`,
          `Configuration contains conflicting ${node.kind} definitions for ${node.key}`,
        );
      }
      bySlot.set(slot, node);
    }

    const attributeTypes = new Map<string, TypeExpr.TypeExpr>();
    for (const node of bySlot.values()) {
      if (node.kind !== Attribute.KIND) continue;
      if (!attributeKey.test(node.key)) {
        return yield* unsupported(
          `attributes.${node.key}`,
          `Attribute identity must be a lowercase namespaced keyword`,
        );
      }
      if (node.key.startsWith(":triplex/") || node.key.startsWith(":_tx/")) {
        return yield* conflict(`attributes.${node.key}`, `${node.key} is reserved by Triplex`);
      }
      const attrs = objectRecord(node.attrs);
      if (attrs?.["key"] !== node.key || attrs["valueType"] === undefined) {
        return yield* unsupported(
          `attributes.${node.key}`,
          `Attribute ${node.key} is missing complete Attribute metadata`,
        );
      }
      const type = yield* parseType(attrs["valueType"], `attributes.${node.key}.type`);
      try {
        TypeSchema.compile(type);
      } catch (error) {
        return yield* unsupported(
          `attributes.${node.key}.type`,
          `Attribute type cannot be compiled: ${String(error)}`,
        );
      }
      attributeTypes.set(node.key, type);
    }

    const collections = new Set<string>();
    const entityTypes = new Set<string>();
    const entities: EntityDescriptor[] = [];
    for (const node of bySlot.values()) {
      if (node.kind !== EntityValidation.ENTITY_SCHEMA_KIND) continue;
      if (!entityTypeName.test(node.key)) {
        return yield* unsupported(
          `entities.${node.key}`,
          `Entity type identity must be PascalCase`,
        );
      }
      if (node.key === "_Transaction" || node.key.startsWith("triplex.")) {
        return yield* conflict(
          `entities.${node.key}`,
          `${node.key} is reserved by Triplex and cannot be exposed`,
        );
      }
      entityTypes.add(node.key);
      const attrs = objectRecord(node.attrs);
      const usages = objectRecord(attrs?.["attributes"]);
      if (
        attrs?.["entityType"] !== node.key ||
        usages === undefined ||
        attrs["type"] === undefined
      ) {
        return yield* unsupported(
          `entities.${node.key}`,
          `Entity ${node.key} was defined without complete EntityType/Attribute usage metadata`,
        );
      }
      const entitySchema = yield* parseType(attrs["type"], `entities.${node.key}.type`);
      if (entitySchema._tag !== "Struct") {
        return yield* unsupported(
          `entities.${node.key}.type`,
          "Entity type must be a closed struct",
        );
      }
      const collection = options.collections?.[node.key] ?? defaultCollection(node.key);
      if (
        typeof collection !== "string" ||
        !pathSegment.test(collection) ||
        reservedCollections.has(collection)
      ) {
        return yield* conflict(
          `entities.${node.key}.collection`,
          `Collection ${JSON.stringify(collection)} is not a safe, non-reserved path segment`,
        );
      }
      if (collections.has(collection)) {
        return yield* conflict(
          `entities.${node.key}.collection`,
          `Collection path ${collection} is exposed more than once`,
        );
      }
      collections.add(collection);

      const descriptors: AttributeDescriptor[] = [];
      const seenAttributes = new Set<string>();
      for (const [alias, rawUsage] of Object.entries(usages).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const usage = objectRecord(rawUsage);
        const key = usage?.["attribute"];
        const required = usage?.["required"];
        const cardinality = usage?.["cardinality"];
        const unique = usage?.["unique"];
        if (
          typeof key !== "string" ||
          typeof required !== "boolean" ||
          (cardinality !== "one" && cardinality !== "many") ||
          typeof unique !== "boolean"
        ) {
          return yield* unsupported(
            `entities.${node.key}.attributes.${alias}`,
            `Entity ${node.key} has invalid usage metadata for ${alias}`,
          );
        }
        if (seenAttributes.has(key)) {
          return yield* conflict(
            `entities.${node.key}.attributes.${alias}`,
            `Entity ${node.key} uses ${key} more than once`,
          );
        }
        const type = attributeTypes.get(key);
        if (type === undefined) {
          return yield* unsupported(
            `entities.${node.key}.attributes.${alias}`,
            `Entity ${node.key} references unresolved attribute ${key}`,
          );
        }
        const field = entitySchema.fields[key];
        const expectedFieldType = cardinality === "many" ? TypeExpr.list(type) : type;
        if (
          field === undefined ||
          field.optional === required ||
          field.fallback !== undefined ||
          TypeExpr.canonical(field.type) !== TypeExpr.canonical(expectedFieldType)
        ) {
          return yield* conflict(
            `entities.${node.key}.attributes.${alias}`,
            `Entity schema and usage metadata disagree about ${key}`,
          );
        }
        seenAttributes.add(key);
        let storage: StorageFamily;
        try {
          storage = storageFamily(type, `entities.${node.key}.attributes.${alias}.type`);
        } catch (error) {
          return yield* error as UnsupportedConfigError;
        }
        descriptors.push({ key, alias, type, required, cardinality, unique, storage });
      }
      if (descriptors.length === 0) {
        return yield* unsupported(
          `entities.${node.key}.attributes`,
          "REST exposure requires at least one application attribute",
        );
      }
      const schemaFields = Object.keys(entitySchema.fields).sort();
      const usageFields = [...seenAttributes].sort();
      if (
        schemaFields.length !== usageFields.length ||
        schemaFields.some((key, index) => key !== usageFields[index])
      ) {
        return yield* conflict(
          `entities.${node.key}.type`,
          `Entity schema fields must exactly match its Attribute usage metadata`,
        );
      }
      const configuredOperations = options.operations?.[node.key];
      if (configuredOperations !== undefined && !Array.isArray(configuredOperations)) {
        return yield* conflict(`entities.${node.key}.operations`, "Operations must be an array");
      }
      const operations = configuredOperations ?? allOperations;
      if (
        operations.some((operation) => !allOperations.includes(operation)) ||
        new Set(operations).size !== operations.length
      ) {
        return yield* conflict(`entities.${node.key}.operations`, "Operations must be unique");
      }
      entities.push({
        entityType: node.key,
        collection,
        attributes: descriptors.sort((a, b) => a.key.localeCompare(b.key)),
        operations: [...operations],
      });
    }
    for (const entityType of Object.keys(options.collections ?? {})) {
      if (!entityTypes.has(entityType)) {
        return yield* conflict(
          `exposure.collections.${entityType}`,
          `Collection override refers to unknown entity type ${entityType}`,
        );
      }
    }
    for (const entityType of Object.keys(options.operations ?? {})) {
      if (!entityTypes.has(entityType)) {
        return yield* conflict(
          `exposure.operations.${entityType}`,
          `Operation override refers to unknown entity type ${entityType}`,
        );
      }
    }
    for (const entity of entities) {
      for (const attribute of entity.attributes) {
        for (const target of referenceKinds(attribute.type)) {
          if (!entityTypes.has(target)) {
            return yield* unsupported(
              `entities.${entity.entityType}.attributes.${attribute.alias}.type`,
              `Reference target ${target} is not defined in this configuration snapshot`,
            );
          }
        }
      }
    }
    const constraints = yield* GraphConstraint.collect(snapshot.root).pipe(
      Effect.map((items) => items.map((item) => item.rule)),
      Effect.mapError((error) =>
        conflict("constraints", "message" in error ? error.message : String(error)),
      ),
    );
    return {
      protocolVersion: 1,
      snapshotId: snapshot.id,
      label: snapshot.label,
      entities: entities.sort((a, b) => a.collection.localeCompare(b.collection)),
      constraints,
    };
  });
