import {
  Attribute,
  ConfigNode,
  type ConfigStore,
  EntityValidation,
  TypeExpr,
} from "@triplex-internal/core/config";
import { Effect, Schema } from "effect";

import type { AttributeView, TypeView, ValueKind } from "../shared/protocol.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const kindOf = (type: TypeExpr.TypeExpr): { kind: ValueKind; label: string; values: string[] } => {
  switch (type._tag) {
    case "Prim":
      return { kind: type.prim, label: type.prim, values: [] };
    case "Enum":
      return { kind: "enum", label: `enum ${type.values.join(" | ")}`, values: [...type.values] };
    case "Ref":
      return { kind: "ref", label: `ref ${type.kind}`, values: [] };
    default:
      return { kind: "other", label: type._tag.toLowerCase(), values: [] };
  }
};

/**
 * Entity types and attribute usage from a release's configuration graph, read the
 * same way as the CLI's `describe` until core exports a shared release descriptor.
 */
export const describeTypes = (
  snapshot: ConfigStore.ConfigSnapshot,
): Effect.Effect<readonly TypeView[], unknown> =>
  Effect.try(() => {
    const nodes = new Map<string, ConfigNode.ConfigNode>();
    for (const { node } of ConfigNode.walk(snapshot.root)) {
      nodes.set(`${node.kind}\u0000${node.key}`, node);
    }
    const all = [...nodes.values()];
    const valueTypes = new Map(
      all
        .filter((node) => node.kind === Attribute.KIND)
        .map((node) => [
          node.key,
          {
            type: Schema.decodeUnknownSync(TypeExpr.TypeExprSchema)(
              record(node.attrs)["valueType"],
            ),
            sensitive: record(node.attrs)["sensitive"] === true,
          },
        ]),
    );
    const types = all
      .filter((node) => node.kind === EntityValidation.ENTITY_SCHEMA_KIND)
      .map((node) => {
        const uses = Object.values(record(record(node.attrs)["attributes"])).map(record);
        const attributes = node.refs
          .filter((edge) => edge.rel === "uses-attribute" && edge.kind === Attribute.KIND)
          .flatMap((edge): AttributeView[] => {
            const declared = valueTypes.get(edge.key);
            const usage = uses.find((use) => use["attribute"] === edge.key);
            if (declared === undefined || usage === undefined) return [];
            const { kind, label, values } = kindOf(declared.type);
            return [
              {
                key: edge.key,
                kind,
                type: label,
                enumValues: values,
                required: usage["required"] === true,
                cardinality: usage["cardinality"] === "many" ? "many" : "one",
                unique: usage["unique"] === true,
                ref: declared.type._tag === "Ref" ? declared.type.kind : null,
                sensitive: declared.sensitive,
              },
            ];
          });
        return { name: node.key, attributes };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const usedBy = new Map<string, Set<string>>();
    for (const type of types) {
      for (const attribute of type.attributes) {
        const users = usedBy.get(attribute.key) ?? new Set<string>();
        users.add(type.name);
        usedBy.set(attribute.key, users);
      }
    }
    return types.map(
      (type): TypeView => ({
        ...type,
        // Shared attributes would also match other types' entities.
        anchor:
          type.attributes.find(
            (attribute) =>
              attribute.required && !attribute.sensitive && usedBy.get(attribute.key)?.size === 1,
          )?.key ?? null,
        referencedBy: types.flatMap((other) =>
          other.attributes
            .filter((attribute) => attribute.ref === type.name)
            .map((attribute) => ({ type: other.name, attribute: attribute.key })),
        ),
      }),
    );
  });
