/**
 * Pattern clause execution against the hexastore.
 *
 * Converts a Datalog PatternClause into a hexastore scan, then
 * produces Context bindings from each matching Datom.
 *
 * This is the bridge between Datalog variables and KV range scans.
 */

import { Effect } from "effect";
import {
  SEALED_BINDING_PREFIX,
  isSealedBinding,
  sealedBinding,
  type SealedValue,
  type TripleValue,
} from "../../Value.js";
import type { Datom } from "../hexastore/KvTripleStore.js";
import type { KvTripleStore } from "../hexastore/KvTripleStore.js";
import type { ScanPattern } from "../hexastore/scan.js";
import { isVariable, type Context, type Term, type Constant, type PatternClause } from "./types.js";
import type { ResolvedTemporalBasis } from "../../Temporal.js";
import { unsafe } from "../../Branded.js";

// ─── TripleValue → Constant ────────────────────────────────────────────────

/**
 * Flatten a TripleValue to a Constant for use in variable bindings.
 *
 * The domain uses typed discriminated unions for values (e.g., { type: "string", value: "Alice" }).
 * Datalog contexts use flat constants (e.g., "Alice" or 42).
 * Refs are kept as their entity ID strings.
 */
export const tripleValueToConstant = (tv: TripleValue): Constant => {
  switch (tv.type) {
    case "string":
    case "ref":
    case "blob":
      return tv.value;
    case "number":
    case "datetime":
      return tv.value;
    case "boolean":
      return tv.value;
    case "json":
      // JSON values become their stringified form for comparison
      return JSON.stringify(tv.value);
    case "sealed":
      // Joins compare blind tokens; projection maps this binding to null.
      return sealedBinding(tv);
  }
};

/** A scan-only sealed value that selects facts by blind token or opaque identity. */
const sealedScanValue = (binding: string): SealedValue => {
  const token = binding.slice(SEALED_BINDING_PREFIX.length);
  return token.startsWith("opaque:")
    ? {
        type: "sealed",
        valueType: "string",
        keyId: "",
        ciphertext: token.slice("opaque:".length),
      }
    : { type: "sealed", valueType: "string", keyId: "", ciphertext: "", blind: token };
};

/**
 * Convert a Constant back to a TripleValue for hexastore scans.
 * Since we lose type information when flattening, we use heuristics:
 * - strings starting with certain patterns could be refs, but we default to string
 * - numbers are numbers
 * - booleans are booleans
 *
 * For bound variables from previous patterns, we use the original TripleValue
 * stored alongside the binding when possible.
 */
export const constantToTripleValue = (c: Constant): TripleValue => {
  if (typeof c === "string" && isSealedBinding(c)) return sealedScanValue(c);
  if (typeof c === "string") return { type: "string", value: c };
  if (typeof c === "number") return { type: "number", value: c };
  if (typeof c === "boolean") return { type: "boolean", value: c };
  // TypedConstant (blind token for a sealed value)
  if (typeof c === "object" && c !== null && "type" in c && c.type === "blind") {
    return sealedScanValue(`${SEALED_BINDING_PREFIX}${c.value}`);
  }
  // TypedConstant (ref)
  if (typeof c === "object" && c !== null && "type" in c && c.type === "ref") {
    return { type: "ref", value: unsafe.entityId((c as { type: "ref"; value: string }).value) };
  }
  return { type: "string", value: String(c) };
};

/**
 * Convert an untyped Datalog constant to every stored value encoding with the
 * same scalar representation. Explicitly typed constants remain exact.
 *
 * Datalog bindings intentionally expose ergonomic scalar values, so a string
 * bound from a ref cannot retain its storage tag. Scanning every compatible
 * encoding keeps later joins symmetric with that public binding shape.
 */
const constantToScanValues = (c: Constant): readonly TripleValue[] => {
  if (typeof c === "string" && isSealedBinding(c)) return [sealedScanValue(c)];
  if (typeof c === "string") {
    const values: TripleValue[] = [
      { type: "string", value: c },
      { type: "ref", value: unsafe.entityId(c) },
      { type: "blob", value: c, mimeType: "", size: 0 },
    ];
    try {
      values.push({ type: "json", value: JSON.parse(c) as unknown });
    } catch {
      // Only serialized JSON scalars participate in the flattened text family.
    }
    return values;
  }
  if (typeof c === "number") {
    return [
      { type: "number", value: c },
      { type: "datetime", value: c },
    ];
  }
  return [constantToTripleValue(c)];
};

// ─── Pattern → ScanPattern ─────────────────────────────────────────────────

/**
 * Resolve a term in a pattern clause to either a concrete value or undefined (variable).
 * If the term is a variable already bound in the context, use the bound value.
 */
const resolveTermForScan = (
  term: Term,
  context: Context,
): { bound: true; value: Constant } | { bound: false } => {
  if (isVariable(term)) {
    if (term in context) {
      return { bound: true, value: context[term]! };
    }
    return { bound: false };
  }
  // Constant
  return { bound: true, value: term as Constant };
};

/**
 * Convert a PatternClause + current Context into a ScanPattern for the hexastore.
 *
 * A PatternClause is [entity, attribute, value] or [entity, attribute, value, tx].
 * Terms can be variables (?x) or constants.
 * Variables already bound in the context are treated as constants.
 */
export const patternToScanPattern = (pattern: PatternClause, context: Context): ScanPattern => {
  const [entityTerm, attrTerm, valueTerm] = pattern;

  const entity = resolveTermForScan(entityTerm, context);
  const attr = resolveTermForScan(attrTerm, context);
  const value = resolveTermForScan(valueTerm, context);

  const result: {
    entity?: string;
    attribute?: string;
    value?: TripleValue;
  } = {};

  if (entity.bound) result.entity = String(entity.value);
  if (attr.bound) result.attribute = String(attr.value);
  if (value.bound) result.value = constantToTripleValue(value.value);

  return result;
};

/**
 * Convert a pattern to all index scans required by Datalog's untyped-constant
 * matching semantics. The singular helper above remains the canonical exact
 * conversion for callers that need one scan plan.
 */
const patternToScanPatterns = (
  pattern: PatternClause,
  context: Context,
): readonly ScanPattern[] => {
  const base = patternToScanPattern(pattern, context);
  const value = resolveTermForScan(pattern[2], context);

  if (!value.bound) return [base];

  return constantToScanValues(value.value).map((scanValue) => ({
    ...base,
    value: scanValue,
  }));
};

// ─── Datom → Context binding ───────────────────────────────────────────────

/**
 * Try to bind a Datom's components against a PatternClause, extending the given Context.
 *
 * For each position (entity, attribute, value, tx):
 * - If the term is a constant, verify the datom matches
 * - If the term is an unbound variable, bind it to the datom's value
 * - If the term is a bound variable, verify the binding matches
 *
 * Returns the extended context, or null if the datom doesn't match.
 */
export const bindDatom = (
  pattern: PatternClause,
  datom: Datom,
  context: Context,
): Context | null => {
  const [entityTerm, attrTerm, valueTerm] = pattern;
  const txTerm = pattern.length === 4 ? pattern[3] : undefined;

  let ctx: Context | null = context;

  // Bind entity
  ctx = matchTerm(entityTerm, datom.entity, ctx);
  if (ctx === null) return null;

  // Bind attribute
  ctx = matchTerm(attrTerm, datom.attribute, ctx);
  if (ctx === null) return null;

  // Bind value. Typed constants match the stored tag exactly; variables and
  // untyped constants use the flattened scalar exposed in result contexts.
  if (typeof valueTerm === "object" && valueTerm !== null && "type" in valueTerm) {
    if (valueTerm.type === "blind") {
      if (datom.value.type !== "sealed" || datom.value.blind !== valueTerm.value) return null;
    } else if (datom.value.type !== "ref" || valueTerm.value !== datom.value.value) {
      return null;
    }
  } else {
    ctx = matchTerm(valueTerm, tripleValueToConstant(datom.value), ctx);
  }
  if (ctx === null) return null;

  // Bind tx if pattern has 4 elements
  if (txTerm !== undefined) {
    ctx = matchTerm(txTerm, datom.txId, ctx);
    if (ctx === null) return null;
  }

  return ctx;
};

/**
 * Match a single term against a value in the context.
 */
const matchTerm = (term: Term, value: Constant, context: Context | null): Context | null => {
  if (context === null) return null;

  if (isVariable(term)) {
    if (term in context) {
      // Already bound — verify match
      return context[term] === value ? context : null;
    }
    // Bind the variable
    return { ...context, [term]: value };
  }

  // Constant — verify equality
  // Handle TypedConstant (ref) comparison
  if (typeof term === "object" && term !== null && "type" in term) {
    const typedTerm = term as { type: string; value: string };
    if (typedTerm.type === "ref") {
      return typedTerm.value === value ? context : null;
    }
  }
  return term === value ? context : null;
};

// ─── Execute a pattern clause ──────────────────────────────────────────────

/**
 * Execute a single pattern clause against the hexastore.
 *
 * For each input context:
 * 1. Convert the pattern + context to a ScanPattern (binding known variables)
 * 2. Scan the hexastore for matching datoms
 * 3. For each datom, try to extend the context with new bindings
 * 4. Yield all successful bindings
 *
 * This is the index nested loop join operation at the core of the executor.
 * Uses the synchronous scanCollect path when available (in-memory backend)
 * to avoid Effect/Stream overhead in the hot loop.
 */
export const executePattern = (
  store: KvTripleStore,
  pattern: PatternClause,
  contexts: readonly Context[],
  basis?: ResolvedTemporalBasis,
): Effect.Effect<Context[]> => {
  // Try synchronous fast path first (available with InMemoryKvBackend)
  const syncResults = executePatternSync(store, pattern, contexts, basis);
  if (syncResults !== null) return Effect.succeed(syncResults);

  // Async path: try hash join first for large context sets, then nested loop
  // Uses scanCollectAsync which batches META reads via getMany (2 round trips
  // instead of N+1 for FDB).
  return Effect.gen(function* () {
    // Try async hash join for large context sets
    if (contexts.length > 100) {
      const hashResult = yield* executePatternHashJoinAsync(store, pattern, contexts, basis);
      if (hashResult !== null) return hashResult;
    }

    const results: Context[] = [];

    for (const ctx of contexts) {
      for (const scanPattern of patternToScanPatterns(pattern, ctx)) {
        const datoms = yield* basis === undefined
          ? store.scanCollectAsync(scanPattern)
          : store.scanCollectTemporalAsync(scanPattern, basis);

        for (let i = 0; i < datoms.length; i++) {
          const bound = bindDatom(pattern, datoms[i]!, ctx);
          if (bound !== null) {
            results.push(bound);
          }
        }
      }
    }

    return results;
  });
};

/**
 * Synchronous fast path for pattern execution.
 * Returns null if the backend doesn't support sync operations.
 *
 * When there are many contexts and the join variable is the entity position,
 * uses a hash join instead of nested loop: one attribute scan → hash map → O(1) lookups.
 * This turns D2's 100k × O(log n) scans into 1 × O(n) scan + 100k × O(1) lookups.
 */
const executePatternSync = (
  store: KvTripleStore,
  pattern: PatternClause,
  contexts: readonly Context[],
  basis?: ResolvedTemporalBasis,
): Context[] | null => {
  // Try hash join optimization for the common case:
  // - Many contexts (>100) to amortize the full attribute scan cost
  // - Entity term is a variable that is already bound in the contexts
  // - Attribute term is a constant
  // - Value term is unbound
  if (contexts.length > 100) {
    const hashResult = executePatternHashJoin(store, pattern, contexts, basis);
    if (hashResult !== null) return hashResult;
  }

  // Fallback: nested loop with individual scans
  const results: Context[] = [];

  for (const ctx of contexts) {
    for (const scanPattern of patternToScanPatterns(pattern, ctx)) {
      const datoms =
        basis === undefined
          ? store.scanCollect(scanPattern)
          : store.scanCollectTemporal(scanPattern, basis);
      if (datoms === null) return null; // Backend doesn't support sync

      for (let i = 0; i < datoms.length; i++) {
        const bound = bindDatom(pattern, datoms[i]!, ctx);
        if (bound !== null) {
          results.push(bound);
        }
      }
    }
  }

  return results;
};

/**
 * Hash join optimization: instead of N individual index scans,
 * do ONE full attribute scan and build a hash map entity → Datom[].
 * Then for each context, look up the bound entity in O(1).
 *
 * Applicable when:
 * - Entity is a variable bound in contexts (the join key)
 * - Attribute is a constant (determines which index to scan)
 * - Value is unbound (or also bound, we filter post-scan)
 *
 * Returns null if the pattern shape doesn't match or sync is unavailable.
 */
const executePatternHashJoin = (
  store: KvTripleStore,
  pattern: PatternClause,
  contexts: readonly Context[],
  basis?: ResolvedTemporalBasis,
): Context[] | null => {
  const [entityTerm, attrTerm] = pattern;

  // Entity must be a variable that is bound in contexts
  if (!isVariable(entityTerm)) return null;
  // Check if entity var is bound in the first context (assume uniform binding shape)
  if (!(entityTerm in contexts[0]!)) return null;

  // Attribute must be a constant
  if (isVariable(attrTerm)) return null;
  const attrValue = String(attrTerm);

  // Do ONE scan of the attribute index
  const scanPattern: ScanPattern = { attribute: attrValue };
  const allDatoms =
    basis === undefined
      ? store.scanCollect(scanPattern)
      : store.scanCollectTemporal(scanPattern, basis);
  if (allDatoms === null) return null;

  // Build hash map: entity → Datom[]
  const entityMap = new Map<string, Datom[]>();
  for (let i = 0; i < allDatoms.length; i++) {
    const d = allDatoms[i]!;
    let arr = entityMap.get(d.entity);
    if (arr === undefined) {
      arr = [];
      entityMap.set(d.entity, arr);
    }
    arr.push(d);
  }

  // Join: for each context, look up the bound entity
  const results: Context[] = [];
  for (const ctx of contexts) {
    const entityId = String(ctx[entityTerm]);
    const datoms = entityMap.get(entityId);
    if (datoms === undefined) continue;

    for (let i = 0; i < datoms.length; i++) {
      const bound = bindDatom(pattern, datoms[i]!, ctx);
      if (bound !== null) {
        results.push(bound);
      }
    }
  }

  return results;
};

/**
 * Async hash join optimization: same as executePatternHashJoin but uses
 * scanCollectAsync for batched META reads (2 round trips instead of N+1).
 *
 * Returns Effect<Context[] | null> — null if the pattern shape doesn't match.
 */
const executePatternHashJoinAsync = (
  store: KvTripleStore,
  pattern: PatternClause,
  contexts: readonly Context[],
  basis?: ResolvedTemporalBasis,
): Effect.Effect<Context[] | null> => {
  const [entityTerm, attrTerm] = pattern;

  // Entity must be a variable that is bound in contexts
  if (!isVariable(entityTerm)) return Effect.succeed(null);
  if (!(entityTerm in contexts[0]!)) return Effect.succeed(null);

  // Attribute must be a constant
  if (isVariable(attrTerm)) return Effect.succeed(null);
  const attrValue = String(attrTerm);

  // Do ONE batched scan of the attribute index
  const scanPattern: ScanPattern = { attribute: attrValue };

  return Effect.gen(function* () {
    const allDatoms = yield* basis === undefined
      ? store.scanCollectAsync(scanPattern)
      : store.scanCollectTemporalAsync(scanPattern, basis);

    // Build hash map: entity → Datom[]
    const entityMap = new Map<string, Datom[]>();
    for (let i = 0; i < allDatoms.length; i++) {
      const d = allDatoms[i]!;
      let arr = entityMap.get(d.entity);
      if (arr === undefined) {
        arr = [];
        entityMap.set(d.entity, arr);
      }
      arr.push(d);
    }

    // Join: for each context, look up the bound entity in O(1)
    const results: Context[] = [];
    for (const ctx of contexts) {
      const entityId = String(ctx[entityTerm]);
      const datoms = entityMap.get(entityId);
      if (datoms === undefined) continue;

      for (let i = 0; i < datoms.length; i++) {
        const bound = bindDatom(pattern, datoms[i]!, ctx);
        if (bound !== null) {
          results.push(bound);
        }
      }
    }

    return results as Context[] | null;
  });
};
