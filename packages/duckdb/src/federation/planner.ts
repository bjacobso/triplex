import { assertDatalogQuery } from "@bjacobso/triplex/internal";
import type { DatalogQuery } from "@bjacobso/triplex";
import {
  DATABASE_ATTRIBUTE,
  TENANT_ATTRIBUTE,
  databaseEntity,
  sourceEntity,
  type FederatedQuery,
  type LocalDatabase,
} from "./types.js";

export interface FederationPlan {
  readonly query: DatalogQuery;
  readonly databases: readonly string[];
  readonly attributes: readonly string[] | null;
}

/** Normalize only; all typing, joins, aggregation and recursion stay in the shared compiler. */
export const planFederation = (
  input: FederatedQuery,
  catalog: readonly LocalDatabase[],
): FederationPlan => {
  const ids = new Set(catalog.map((db) => db.id));
  const sources = input.sources ?? {};
  for (const [alias, id] of Object.entries(sources)) {
    if (!/^\$[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias) || !ids.has(id))
      throw new Error(`Unknown database or invalid source alias: ${alias} -> ${id}`);
  }
  const expand = (clause: readonly unknown[]): readonly (readonly unknown[])[] => {
    if (clause[0] === "not")
      return [["not", ...clause.slice(1).flatMap((inner) => expand(inner as readonly unknown[]))]];
    if (typeof clause[0] !== "string" || !clause[0].startsWith("$")) return [clause];
    const id = sources[clause[0] as `$${string}`];
    if (id === undefined) throw new Error(`Unbound source: ${clause[0]}`);
    if (clause.length !== 4 && clause.length !== 5)
      throw new Error("Source patterns require four or five terms");
    const identity = (value: unknown): string => {
      if (typeof value !== "string") throw new Error("Source identities must be strings");
      return value.startsWith("?") ? value : sourceEntity(id, value);
    };
    const entity = identity(clause[1]);
    const value = clause[3];
    const qualifiedValue =
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "ref" &&
      "value" in value
        ? { type: "ref", value: sourceEntity(id, String(value.value)) }
        : value;
    return [
      [entity, clause[2], qualifiedValue, ...(clause.length === 5 ? [identity(clause[4])] : [])],
      [entity, DATABASE_ATTRIBUTE, { type: "ref", value: databaseEntity(id) }],
    ];
  };
  const { sources: _sources, ...rest } = input;
  const normalized = { ...rest, where: input.where.flatMap(expand) };
  // Explicitly reject shortcuts where expansion would change core rule/OR semantics.
  const rejectRemainingSources = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "string" && value[0].startsWith("$"))
      throw new Error(
        "Source shortcuts are supported in top-level patterns and not; use membership patterns in or and ordinary rules",
      );
    value.forEach(rejectRemainingSources);
  };
  rejectRemainingSources(normalized.where);
  normalized.rules?.forEach((rule) => rejectRemainingSources(rule.body));
  const query = assertDatalogQuery(normalized);
  const attributes = new Set<string>();
  let wildcard = false;
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (
      typeof value[0] === "string" &&
      value[0] !== "not" &&
      value[0] !== "or" &&
      typeof value[1] === "string"
    ) {
      if (value[1].startsWith(":")) attributes.add(value[1]);
      else if (value[1].startsWith("?") && !["=", "!=", ">", ">=", "<", "<="].includes(value[0]))
        wildcard = true;
    }
    value.forEach(walk);
  };
  walk(query.where);
  query.rules?.forEach((rule) => walk(rule.body));
  query.optionalProjection?.fields.forEach((field) => attributes.add(field.attribute));
  // Conservatively prune only flat conjunctions whose every entity has an explicit source.
  const bindings = new Map<string, Set<string>>();
  const databaseBindings = new Map<string, Set<string>>();
  for (const clause of query.where) {
    if (
      clause[1] === TENANT_ATTRIBUTE &&
      typeof clause[0] === "string" &&
      typeof clause[2] === "string" &&
      !clause[2].startsWith("?")
    ) {
      const matches = databaseBindings.get(clause[0]) ?? new Set<string>();
      catalog.filter((db) => db.tenant === clause[2]).forEach((db) => matches.add(db.id));
      databaseBindings.set(clause[0], matches);
    }
  }
  for (const clause of query.where) {
    if (clause[1] === DATABASE_ATTRIBUTE && typeof clause[0] === "string") {
      const value = clause[2];
      const matches =
        typeof value === "string"
          ? databaseBindings.get(value)
          : typeof value === "object" && value !== null && "value" in value
            ? new Set(
                catalog.filter((db) => databaseEntity(db.id) === value.value).map((db) => db.id),
              )
            : undefined;
      if (matches !== undefined) {
        const bound = bindings.get(clause[0]) ?? new Set<string>();
        matches.forEach((id) => bound.add(id));
        bindings.set(clause[0], bound);
      }
    }
  }
  const used = new Set<string>();
  let all = query.rules !== undefined || query.optionalProjection !== undefined;
  for (const clause of query.where) {
    if (["=", "!=", ">", ">=", "<", "<="].includes(String(clause[0]))) continue;
    if (clause[1] === TENANT_ATTRIBUTE) continue; // The coordinator owns the complete catalog.
    const bound = bindings.get(String(clause[0]));
    if (!bound || typeof clause[1] !== "string" || !clause[1].startsWith(":")) all = true;
    else bound.forEach((id) => used.add(id));
  }
  return {
    query,
    databases: catalog.filter((db) => all || used.has(db.id)).map((db) => db.id),
    attributes: wildcard ? null : [...attributes].sort(),
  };
};
