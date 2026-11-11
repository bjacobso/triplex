/**
 * Hexastore index definitions and selection logic.
 *
 * The hexastore maintains 4 sort orderings of the same data (Datomic-style):
 * - EAVT: Entity → Attribute → Value → TxId (entity lookup)
 * - AEVT: Attribute → Entity → Value → TxId (column scan)
 * - AVET: Attribute → Value → Entity → TxId (value lookup)
 * - VAET: Value → Attribute → Entity → TxId (reverse ref lookup)
 *
 * Plus supplementary indexes:
 * - META: TripleId → full serialized triple (the "heap")
 */

import type { TuplePart } from "./tuple.js";
import { encodeTuple, tString, tMax } from "./tuple.js";
import { concat, increment } from "../kv/encoding.js";

// ─── Index Prefixes ────────────────────────────────────────────────────────

/** Entity → Attribute → Value → TxId */
export const EAVT_PREFIX = new Uint8Array([0x01]);

/** Attribute → Entity → Value → TxId */
export const AEVT_PREFIX = new Uint8Array([0x02]);

/** Attribute → Value → Entity → TxId */
export const AVET_PREFIX = new Uint8Array([0x03]);

/** Value → Attribute → Entity → TxId (refs only) */
export const VAET_PREFIX = new Uint8Array([0x04]);

/** EntityType → TripleId (entity type lookup) */
export const TYPE_PREFIX = new Uint8Array([0x05]);

/** Current unretracted facts, ordered by entity, attribute, ID. History stays in EAVT. */
export const LIVE_FACT_PREFIX = new Uint8Array([0x06]);
export const LIVE_FACT_READY_KEY = new Uint8Array([0x26, 0x01]);
export const LIVE_FACT_CURSOR_KEY = new Uint8Array([0x26, 0x02]);
export const liveFactKey = (entity: string, attribute: string, id: string) =>
  concat(LIVE_FACT_PREFIX, encodeTuple(tString(entity), tString(attribute), tString(id)));
export const liveFactKeyStr = (entity: string, attribute: string, id: string) =>
  `\x06${entity}${attribute}${id}`;
export const liveFactRange = (entity: string, attribute?: string) => {
  const start = concat(
    LIVE_FACT_PREFIX,
    encodeTuple(tString(entity), ...(attribute === undefined ? [] : [tString(attribute)])),
  );
  return { start, end: increment(start) };
};

/** TripleId → full triple data */
export const META_PREFIX = new Uint8Array([0x20]);

export type IndexName = "EAVT" | "AEVT" | "AVET" | "VAET";

export const INDEX_PREFIX: Record<IndexName, Uint8Array> = {
  EAVT: EAVT_PREFIX,
  AEVT: AEVT_PREFIX,
  AVET: AVET_PREFIX,
  VAET: VAET_PREFIX,
};

// ─── Index Key Construction ────────────────────────────────────────────────

/**
 * Build a EAVT index key.
 */
export const eavtKey = (
  entity: TuplePart,
  attribute: TuplePart,
  value: TuplePart,
  txId: TuplePart,
  tripleId: TuplePart,
): Uint8Array => concat(EAVT_PREFIX, encodeTuple(entity, attribute, value, txId, tripleId));

/**
 * Build an AEVT index key.
 */
export const aevtKey = (
  attribute: TuplePart,
  entity: TuplePart,
  value: TuplePart,
  txId: TuplePart,
  tripleId: TuplePart,
): Uint8Array => concat(AEVT_PREFIX, encodeTuple(attribute, entity, value, txId, tripleId));

/**
 * Build an AVET index key.
 */
export const avetKey = (
  attribute: TuplePart,
  value: TuplePart,
  entity: TuplePart,
  txId: TuplePart,
  tripleId: TuplePart,
): Uint8Array => concat(AVET_PREFIX, encodeTuple(attribute, value, entity, txId, tripleId));

/**
 * Build a VAET index key (for ref values only).
 */
export const vaetKey = (
  value: TuplePart,
  attribute: TuplePart,
  entity: TuplePart,
  txId: TuplePart,
  tripleId: TuplePart,
): Uint8Array => concat(VAET_PREFIX, encodeTuple(value, attribute, entity, txId, tripleId));

/**
 * Build a META key for a triple ID.
 */
export const metaKey = (tripleId: string): Uint8Array =>
  concat(META_PREFIX, encodeTuple(tString(tripleId)));

/**
 * Build a TYPE index key: TYPE:{entityType}:{tripleId}
 * This enables prefix scans by entityType for O(k) entity type queries.
 */
export const typeKey = (entityType: string, tripleId: string): Uint8Array =>
  concat(TYPE_PREFIX, encodeTuple(tString(entityType), tString(tripleId)));

/**
 * Compute the [start, end) byte range for scanning all entries of a given entityType.
 */
export const typePrefixRange = (entityType: string): { start: Uint8Array; end: Uint8Array } => {
  const start = concat(TYPE_PREFIX, encodeTuple(tString(entityType)));
  const end = concat(TYPE_PREFIX, encodeTuple(tString(entityType), tMax()));
  return { start, end };
};

// ─── Latin1 String Key Builders (fast path) ───────────────────────────────
// These produce latin1 string keys directly for the InMemoryKvBackend,
// completely bypassing Uint8Array allocation. Each prefix byte is converted
// to a char code and prepended to the concatenated encoded parts.

const EAVT_STR = String.fromCharCode(0x01);
const AEVT_STR = String.fromCharCode(0x02);
const AVET_STR = String.fromCharCode(0x03);
const VAET_STR = String.fromCharCode(0x04);
const TYPE_STR = String.fromCharCode(0x05);
const META_STR = String.fromCharCode(0x20);

/** Build EAVT key as latin1 string (zero Uint8Array allocations). */
export const eavtKeyStr = (e: string, a: string, v: string, tx: string, id: string): string =>
  EAVT_STR + e + a + v + tx + id;

/** Build AEVT key as latin1 string. */
export const aevtKeyStr = (a: string, e: string, v: string, tx: string, id: string): string =>
  AEVT_STR + a + e + v + tx + id;

/** Build AVET key as latin1 string. */
export const avetKeyStr = (a: string, v: string, e: string, tx: string, id: string): string =>
  AVET_STR + a + v + e + tx + id;

/** Build VAET key as latin1 string. */
export const vaetKeyStr = (v: string, a: string, e: string, tx: string, id: string): string =>
  VAET_STR + v + a + e + tx + id;

/** Build META key as latin1 string. */
export const metaKeyStr = (tripleIdEncoded: string): string => META_STR + tripleIdEncoded;

/** Build TYPE key as latin1 string. */
export const typeKeyStr = (entityTypeEncoded: string, tripleIdEncoded: string): string =>
  TYPE_STR + entityTypeEncoded + tripleIdEncoded;

// ─── Index Selection ───────────────────────────────────────────────────────

/**
 * Describes which components of a triple pattern are bound (known).
 */
export interface PatternShape {
  readonly entity: boolean;
  readonly attribute: boolean;
  readonly value: boolean;
}

/**
 * The result of index selection: which index to use and what prefix parts.
 */
export interface IndexChoice {
  readonly index: IndexName;
  /** Tuple parts to use as the prefix for the range scan. */
  readonly prefixParts: readonly TuplePart[];
}

/**
 * Select the optimal index for a given pattern shape.
 *
 * The heuristic: choose the index whose leading columns match the most
 * bound components. This maximizes the prefix length and minimizes scan range.
 */
export const selectIndex = (
  shape: PatternShape,
  entityPart?: TuplePart,
  attributePart?: TuplePart,
  valuePart?: TuplePart,
  isRef?: boolean,
): IndexChoice => {
  const { entity, attribute, value } = shape;

  // All three bound → EAVT (any would work, EAVT is canonical)
  if (entity && attribute && value) {
    return { index: "EAVT", prefixParts: [entityPart!, attributePart!, valuePart!] };
  }

  // Entity + attribute → EAVT
  if (entity && attribute) {
    return { index: "EAVT", prefixParts: [entityPart!, attributePart!] };
  }

  // Entity only → EAVT
  if (entity) {
    return { index: "EAVT", prefixParts: [entityPart!] };
  }

  // Attribute + value → AVET
  if (attribute && value) {
    return { index: "AVET", prefixParts: [attributePart!, valuePart!] };
  }

  // Attribute only → AEVT
  if (attribute) {
    return { index: "AEVT", prefixParts: [attributePart!] };
  }

  // Value only (ref) → VAET
  if (value && isRef) {
    return { index: "VAET", prefixParts: [valuePart!] };
  }

  // Nothing bound → full EAVT scan
  return { index: "EAVT", prefixParts: [] };
};

// ─── Range Computation ─────────────────────────────────────────────────────

/**
 * Compute the [start, end) byte range for a prefix scan on a given index.
 * Start is the encoded prefix; end is the prefix incremented by 1 byte.
 */
export const prefixRange = (
  indexName: IndexName,
  prefixParts: readonly TuplePart[],
): { start: Uint8Array; end: Uint8Array } => {
  const prefix = INDEX_PREFIX[indexName];
  if (prefixParts.length === 0) {
    // Full index scan: start at prefix, end at prefix+1
    return { start: prefix, end: increment(prefix) };
  }
  const start = concat(prefix, encodeTuple(...prefixParts));
  const end = concat(prefix, encodeTuple(...prefixParts, tMax()));
  return { start, end };
};
