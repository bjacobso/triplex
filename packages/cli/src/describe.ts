import { EntityId, type TransactRequest, type TripleValue } from "@triplex-build/triplex";
import {
  Attribute,
  ConfigNode,
  type ConfigStore,
  EntityValidation,
  GraphConstraint,
  TypeExpr,
} from "@triplex-build/triplex/config";
import { Effect, Schema } from "effect";

export const manifest = {
  output: "JSON envelope: { ok, command, data }",
  input: "JSON via --input <file>, or --input - for stdin",
  backends: ["SQLite file", "PostgreSQL URL", "database-scoped PostgreSQL"],
  commands: {
    status: "Database and configuration summary",
    entity: ["types", "list", "get", "facts", "history"],
    fact: ["match"],
    query: ["run", "page", "explain"],
    transaction: ["apply"],
    journal: ["list", "receipt", "transaction"],
    config: ["refs", "releases", "release", "objects", "object", "set-ref", "impact"],
    db: ["create", "list", "get", "update", "clear", "delete"],
  },
};

const rules = [
  "One application command is one transaction; all its changes commit or roll back together.",
  "Set meta.actor and a deterministic meta.commandId derived from the request; reuse the ID on retry.",
  "Pin meta.configSnapshot and meta.enforce from the same release; pinning alone does not enforce constraints.",
  "Give every fact of an entity one valid interval; referenced entities must be valid from the same or an earlier time.",
  "To change a value from time T on, use Change.replace (or Change.end to stop it): it retracts the open assertion, re-asserts it with validTo T, asserts the new value from T, and adds a TripleLive precondition, all in one transaction.",
];

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected configuration metadata object");
  }
  return value as Record<string, unknown>;
};

/** Ontology scalar values use the public transaction wire representation. */
const placeholder = (type: TypeExpr.TypeExpr): TripleValue => {
  switch (type._tag) {
    case "Prim":
      switch (type.prim) {
        case "text":
          return { type: "string", value: "<text>" };
        case "number":
        case "integer":
          return { type: "number", value: 0 };
        case "boolean":
          return { type: "boolean", value: false };
        case "date":
          return { type: "string", value: "2000-01-01" };
        case "instant":
          return { type: "datetime", value: 0 };
      }
      break;
    case "Enum": {
      const value = type.values[0];
      if (value === undefined) throw new Error("Cannot generate an example for an empty enum");
      return { type: "string", value };
    }
    case "Ref":
      return { type: "ref", value: EntityId.make(`<entity-id of ${type.kind}>`) };
    default:
      throw new Error(`Cannot generate a transaction example for ${type._tag}`);
  }
};

interface Usage {
  readonly key: string;
  readonly valueType: TypeExpr.TypeExpr;
  readonly required: boolean;
  readonly cardinality: "one" | "many";
  readonly unique: boolean;
  readonly referenceTarget: string | null;
  readonly sensitive: boolean;
}

interface ReleaseDescription {
  readonly release: {
    readonly id: string;
    readonly label: string;
    readonly rootContentId: string;
    readonly ref: string;
  };
  readonly entityTypes: ReadonlyArray<{
    readonly name: string;
    readonly attributes: ReadonlyArray<Usage>;
  }>;
  readonly attributes: ReadonlyArray<{
    readonly key: string;
    readonly valueType: TypeExpr.TypeExpr;
  }>;
  readonly constraints: ReadonlyArray<{
    readonly key: string;
    readonly kind: GraphConstraint.Rule["_tag"];
  }>;
  readonly derivations: ReadonlyArray<{ readonly kind: string; readonly key: string }>;
  readonly examples: ReadonlyArray<{
    readonly entityType: string;
    readonly input: TransactRequest;
  }>;
  readonly rules: ReadonlyArray<string>;
}

/** Compile a release locally until a shared public config descriptor exists in core. */
export const describeRelease = (
  snapshot: ConfigStore.ConfigSnapshot,
  ref: string,
): Effect.Effect<ReleaseDescription, unknown> =>
  Effect.gen(function* () {
    const definitions = yield* GraphConstraint.collect(snapshot.root);
    return yield* Effect.try(() => {
      const nodes = new Map<string, ConfigNode.ConfigNode>();
      for (const { node } of ConfigNode.walk(snapshot.root)) {
        const slot = `${node.kind}\u0000${node.key}`;
        const existing = nodes.get(slot);
        if (existing !== undefined && existing.cid !== node.cid) {
          throw new Error(`Conflicting ${node.kind} definitions for ${node.key}`);
        }
        nodes.set(slot, node);
      }
      const sorted = [...nodes.values()].sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key),
      );
      const attributes = sorted
        .filter((node) => node.kind === Attribute.KIND)
        .map((node) => ({
          key: node.key,
          valueType: Schema.decodeUnknownSync(TypeExpr.TypeExprSchema)(
            record(node.attrs)["valueType"],
          ),
        }));
      const byKey = new Map(attributes.map((attribute) => [attribute.key, attribute]));
      const entityTypes = sorted
        .filter((node) => node.kind === EntityValidation.ENTITY_SCHEMA_KIND)
        .map((node) => {
          const metadata = record(record(node.attrs)["attributes"]);
          const attributes: Usage[] = node.refs
            .filter((edge) => edge.rel === "uses-attribute" && edge.kind === Attribute.KIND)
            .map((edge): Usage => {
              const attribute = byKey.get(edge.key);
              const usage = Object.values(metadata)
                .map(record)
                .find((use) => use["attribute"] === edge.key);
              if (
                attribute === undefined ||
                usage === undefined ||
                typeof usage["required"] !== "boolean" ||
                typeof usage["unique"] !== "boolean" ||
                (usage["cardinality"] !== "one" && usage["cardinality"] !== "many")
              ) {
                throw new Error(`Incomplete attribute usage metadata for ${node.key}/${edge.key}`);
              }
              const attributeNode = nodes.get(`${Attribute.KIND}\u0000${edge.key}`)!;
              return {
                ...attribute,
                required: usage["required"],
                cardinality: usage["cardinality"],
                unique: usage["unique"],
                referenceTarget:
                  attribute.valueType._tag === "Ref" ? attribute.valueType.kind : null,
                sensitive: record(attributeNode.attrs)["sensitive"] === true,
              };
            })
            .sort((a, b) => a.key.localeCompare(b.key));
          return { name: node.key, attributes };
        });
      return {
        release: { id: snapshot.id, label: snapshot.label, rootContentId: snapshot.rootCid, ref },
        entityTypes,
        attributes,
        constraints: definitions.map(({ key, rule }) => ({ key, kind: rule._tag })),
        derivations: sorted
          .filter(
            (node) =>
              node !== snapshot.root &&
              node.kind !== Attribute.KIND &&
              node.kind !== EntityValidation.ENTITY_SCHEMA_KIND &&
              node.kind !== GraphConstraint.KIND,
          )
          .map(({ kind, key }) => ({ kind, key })),
        examples: entityTypes.map(({ name, attributes }) => {
          const required = attributes.filter((attribute) => attribute.required);
          // An optional-only entity needs a fact to exist in the fact model.
          const exampleAttributes = required.length > 0 ? required : attributes.slice(0, 1);
          return {
            entityType: name,
            input: {
              operations: exampleAttributes.map((attribute) => ({
                op: "assert" as const,
                entityId: EntityId.make(`<entity-id of ${name}>`),
                entityType: name,
                attribute: attribute.key,
                value: placeholder(attribute.valueType),
              })),
              meta: {
                actor: "<actor>",
                commandId: `<command-id for ${name}>`,
                configSnapshot: snapshot.id,
                enforce: GraphConstraint.enforcement(definitions),
              },
            },
          };
        }),
        rules,
      };
    });
  });
