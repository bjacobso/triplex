/**
 * Canonical JSON serialization for entity snapshots.
 *
 * Produces a deterministic JSON string from an entity's attribute map,
 * ensuring that the same entity state always produces the same bytes
 * (and therefore the same hash).
 *
 * Rules:
 * 1. Attribute keys sorted lexicographically
 * 2. Multi-valued attributes: values sorted by type, then by stringified value
 * 3. No whitespace (compact JSON)
 * 4. Absent attributes omitted (never null)
 * 5. Only the attribute map is serialized (no entityId, entityType, txId, txTime)
 */

import type { TripleValue } from "../Value.js";
import type { Triple } from "../Triple.js";
import * as CanonicalJson from "../content/CanonicalJson.js";
import * as ContentId from "../content/ContentId.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SnapshotValue =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "datetime"; value: number }
  | { type: "ref"; value: string }
  | { type: "json"; value: unknown }
  | {
      type: "sealed";
      valueType: string;
      keyId: string;
      ciphertext: string;
      blind?: string;
    };

export type SnapshotAttributeMap = Record<string, SnapshotValue | SnapshotValue[]>;

export interface EntitySnapshot {
  readonly entityId: string;
  readonly entityType: string | null;
  readonly attributes: SnapshotAttributeMap;
  readonly hash: ContentId.ContentId;
  readonly txId: string;
  readonly txTime: number;
}

export interface EntityDiff {
  readonly entityId: string;
  readonly fromTxId: string;
  readonly toTxId: string;
  readonly fromHash: ContentId.ContentId;
  readonly toHash: ContentId.ContentId;
  readonly added: Record<string, SnapshotValue | SnapshotValue[]>;
  readonly removed: Record<string, SnapshotValue | SnapshotValue[]>;
  readonly changed: Record<
    string,
    { old: SnapshotValue | SnapshotValue[]; new: SnapshotValue | SnapshotValue[] }
  >;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current canonical format version. Prefixed to hash input for future-proofing. */
export const CANONICAL_VERSION = "v1";

/** Format version number for the greenfield entity_blobs representation. */
export const FORMAT_VERSION = 1;

// ---------------------------------------------------------------------------
// Triple → SnapshotValue conversion
// ---------------------------------------------------------------------------

/**
 * Convert a TripleValue to a SnapshotValue.
 * Blob values are stored as their hash (a string ref to blob storage).
 */
export const tripleValueToSnapshotValue = (tv: TripleValue): SnapshotValue => {
  switch (tv.type) {
    case "string":
      return { type: "string", value: tv.value };
    case "number":
      return { type: "number", value: tv.value };
    case "boolean":
      return { type: "boolean", value: tv.value };
    case "datetime":
      return { type: "datetime", value: tv.value };
    case "ref":
      return { type: "ref", value: tv.value };
    case "json":
      return { type: "json", value: tv.value };
    case "blob":
      // Blobs are stored by their content hash in the triple store
      return { type: "string", value: tv.value };
    case "sealed":
      // Snapshots commit to the sealed envelope, never to plaintext.
      return {
        type: "sealed",
        valueType: tv.valueType,
        keyId: tv.keyId,
        ciphertext: tv.ciphertext,
        ...(tv.blind === undefined ? {} : { blind: tv.blind }),
      };
  }
};

// ---------------------------------------------------------------------------
// Triples → Attribute Map
// ---------------------------------------------------------------------------

/**
 * Convert active triples for an entity into a snapshot attribute map.
 * Multi-valued attributes (same attribute, different values) become arrays.
 */
export const triplesToAttributeMap = (triples: readonly Triple[]): SnapshotAttributeMap => {
  const map: Record<string, SnapshotValue[]> = {};

  for (const triple of triples) {
    const attr = triple.attribute;
    const sv = tripleValueToSnapshotValue(triple.value);
    if (!map[attr]) {
      map[attr] = [];
    }
    map[attr].push(sv);
  }

  // Collapse single-valued attributes from arrays to scalars
  const result: SnapshotAttributeMap = {};
  for (const [attr, values] of Object.entries(map)) {
    result[attr] = values.length === 1 ? values[0]! : values;
  }

  return result;
};

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Produce a stable string representation of a SnapshotValue for sorting.
 * Used to establish deterministic ordering within multi-valued attributes.
 */
const canonicalValueSortKey = (sv: SnapshotValue): string => {
  // Sort by type first, then by a stringified value representation
  const valuePart =
    sv.type === "sealed"
      ? (sv.blind ?? sv.ciphertext)
      : sv.type === "json"
        ? JSON.stringify(sv.value)
        : String(sv.value);
  return `${sv.type}:${valuePart}`;
};

/**
 * Produce the canonical JSON string for an attribute map.
 *
 * The output is a JSON array of `[key, value]` pairs (sorted by key).
 * Multi-valued attributes have their values sorted by canonicalValueSortKey.
 */
export const canonicalize = (attributes: SnapshotAttributeMap): string => {
  const keys = Object.keys(attributes).sort();

  const entries: Array<[string, SnapshotValue | SnapshotValue[]]> = keys.map((key) => {
    const val = attributes[key]!;
    if (Array.isArray(val)) {
      // Sort array values deterministically
      const sorted = [...val].sort((a, b) =>
        canonicalValueSortKey(a).localeCompare(canonicalValueSortKey(b)),
      );
      return [key, sorted];
    }
    return [key, val];
  });

  return CanonicalJson.encodeOrThrow(entries as CanonicalJson.CanonicalValue);
};

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Compute the content-address hash for a canonical JSON string.
 * Uses the shared browser-safe, domain-separated SHA-256 foundation.
 */
export const hashCanonical = (canonical: string): ContentId.ContentId => {
  const input = `${CANONICAL_VERSION}:${canonical}`;
  return ContentId.hash(ContentId.Domain.entitySnapshot, input);
};

/**
 * Compute the empty-entity hash (tombstone for fully-retracted entities).
 */
export const EMPTY_ENTITY_HASH = hashCanonical(canonicalize({}));

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * Compute a structured diff between two snapshot attribute maps.
 */
export const diffAttributes = (
  oldAttrs: SnapshotAttributeMap,
  newAttrs: SnapshotAttributeMap,
): {
  added: Record<string, SnapshotValue | SnapshotValue[]>;
  removed: Record<string, SnapshotValue | SnapshotValue[]>;
  changed: Record<
    string,
    { old: SnapshotValue | SnapshotValue[]; new: SnapshotValue | SnapshotValue[] }
  >;
} => {
  const added: Record<string, SnapshotValue | SnapshotValue[]> = {};
  const removed: Record<string, SnapshotValue | SnapshotValue[]> = {};
  const changed: Record<
    string,
    { old: SnapshotValue | SnapshotValue[]; new: SnapshotValue | SnapshotValue[] }
  > = {};

  const allKeys = new Set([...Object.keys(oldAttrs), ...Object.keys(newAttrs)]);

  for (const key of allKeys) {
    const oldVal = oldAttrs[key];
    const newVal = newAttrs[key];

    if (oldVal === undefined && newVal !== undefined) {
      added[key] = newVal;
    } else if (oldVal !== undefined && newVal === undefined) {
      removed[key] = oldVal;
    } else if (oldVal !== undefined && newVal !== undefined) {
      // Compare by canonical representation
      const oldCanonical = JSON.stringify(
        Array.isArray(oldVal)
          ? [...oldVal].sort((a, b) =>
              canonicalValueSortKey(a).localeCompare(canonicalValueSortKey(b)),
            )
          : oldVal,
      );
      const newCanonical = JSON.stringify(
        Array.isArray(newVal)
          ? [...newVal].sort((a, b) =>
              canonicalValueSortKey(a).localeCompare(canonicalValueSortKey(b)),
            )
          : newVal,
      );
      if (oldCanonical !== newCanonical) {
        changed[key] = { old: oldVal, new: newVal };
      }
    }
  }

  return { added, removed, changed };
};
