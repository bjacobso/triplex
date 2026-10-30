/**
 * Immutable import segments: a batch of facts sorted and indexed in one pass.
 *
 * A segment is to `transact` what a packfile is to loose git objects. Building
 * one sorts the facts once and keeps them as columns over a sorted string
 * dictionary, with permutation indexes for the hexastore's access paths. It is
 * plain data (typed arrays, arrays, a map), so it can be built in a worker and
 * transferred, encoded to bytes, and decoded again without re-sorting.
 *
 * A segment says nothing about when it was recorded. Attaching it to a store
 * is one transaction; that transaction's position, instant and ID become the
 * recorded time of every fact in it. Valid time is data: each fact keeps its
 * own `validFrom` and `validTo`.
 *
 * Identity is content: `id` is a `ContentId` over the canonical encoding of the
 * facts in segment order, so the same facts in any input order give the same
 * segment, and "loaded from segment sha256-…" is checkable by rebuilding it.
 */

import * as CanonicalJson from "../content/CanonicalJson.js";
import * as ContentIds from "../content/ContentId.js";
import * as Sha256 from "../content/Sha256.js";
import type { TripleInput } from "../Triple.js";
import { unsafe } from "../Branded.js";
import type { TripleValue } from "../Value.js";

/** Value kinds, in the hexastore's type order. */
const KIND = { string: 0, number: 1, boolean: 2, datetime: 3, ref: 4, json: 5, blob: 6 } as const;
const KIND_NAMES = ["string", "number", "boolean", "datetime", "ref", "json", "blob"] as const;

export interface Segment {
  readonly id: ContentIds.ContentId;
  readonly count: number;
  /** Sorted, distinct strings. Every string column holds indexes into it. */
  readonly strings: readonly string[];
  /** Facts in segment order: entity, attribute, value, then the rest. */
  readonly entity: Uint32Array;
  readonly attribute: Uint32Array;
  readonly kind: Uint8Array;
  /** Number, datetime and boolean (0/1) values. */
  readonly num: Float64Array;
  /** String, ref, blob-hash and canonical-JSON values, as dictionary indexes; -1 otherwise. */
  readonly str: Int32Array;
  /** Complete blob values, by ordinal. */
  readonly blobs: ReadonlyMap<number, TripleValue>;
  /** NaN: valid from the attaching transaction's instant. */
  readonly validFrom: Float64Array;
  /** NaN: open-ended. */
  readonly validTo: Float64Array;
  /** -1: none. */
  readonly entityType: Int32Array;
  /** -1: none; the attaching transaction's actor applies. */
  readonly createdBy: Int32Array;
  /** Ordinals by attribute, entity, value (AEVT). */
  readonly byAttribute: Uint32Array;
  /** Ordinals by attribute, value, entity (AVET). */
  readonly byAttributeValue: Uint32Array;
  /** Ref-valued ordinals by value, attribute, entity (VAET). */
  readonly byRef: Uint32Array;
  /** Typed ordinals by entity type, then segment order. */
  readonly byType: Uint32Array;
  /** Distinct attributes, sorted. */
  readonly attributes: readonly string[];
  /** Distinct entities. */
  readonly entities: number;
}

// ─── Comparison ────────────────────────────────────────────────────────────

/** Numbers with NaN (absent) first. */
const cmpNum = (a: number, b: number): number =>
  a === b || (a !== a && b !== b) ? 0 : a !== a ? -1 : b !== b ? 1 : a < b ? -1 : 1;

const cmpValue = (s: Columns, i: number, j: number): number =>
  s.kind[i]! - s.kind[j]! || s.str[i]! - s.str[j]! || cmpNum(s.num[i]!, s.num[j]!);

interface Columns {
  readonly entity: Uint32Array;
  readonly attribute: Uint32Array;
  readonly kind: Uint8Array;
  readonly num: Float64Array;
  readonly str: Int32Array;
  readonly validFrom: Float64Array;
  readonly validTo: Float64Array;
  readonly entityType: Int32Array;
  readonly createdBy: Int32Array;
}

const cmpFact = (s: Columns, i: number, j: number): number =>
  s.entity[i]! - s.entity[j]! ||
  s.attribute[i]! - s.attribute[j]! ||
  cmpValue(s, i, j) ||
  cmpNum(s.validFrom[i]!, s.validFrom[j]!) ||
  cmpNum(s.validTo[i]!, s.validTo[j]!) ||
  s.entityType[i]! - s.entityType[j]! ||
  s.createdBy[i]! - s.createdBy[j]!;

// ─── Values ────────────────────────────────────────────────────────────────

/** The dictionary string that orders and identifies a value, if it has one. */
const valueString = (value: TripleValue): string | undefined => {
  switch (value.type) {
    case "string":
    case "ref":
    case "blob":
      return value.value;
    case "json":
      return CanonicalJson.encodeOrThrow(value.value as CanonicalJson.CanonicalValue);
    default:
      return undefined;
  }
};

const valueNumber = (value: TripleValue): number =>
  value.type === "number" || value.type === "datetime"
    ? value.value
    : value.type === "boolean"
      ? value.value
        ? 1
        : 0
      : Number.NaN;

/** Decode the value of fact `i`. */
export const valueAt = (segment: Segment, i: number): TripleValue => {
  const kind = segment.kind[i]!;
  switch (kind) {
    case KIND.string:
      return { type: "string", value: segment.strings[segment.str[i]!]! };
    case KIND.ref:
      return { type: "ref", value: unsafe.entityId(segment.strings[segment.str[i]!]!) };
    case KIND.number:
      return { type: "number", value: segment.num[i]! };
    case KIND.datetime:
      return { type: "datetime", value: segment.num[i]! };
    case KIND.boolean:
      return { type: "boolean", value: segment.num[i]! === 1 };
    case KIND.json:
      return { type: "json", value: JSON.parse(segment.strings[segment.str[i]!]!) as unknown };
    default:
      return segment.blobs.get(i)!;
  }
};

// ─── Canonical content ─────────────────────────────────────────────────────

const canonicalValue = (value: TripleValue): string => {
  if ((value.type === "number" || value.type === "datetime") && !Number.isFinite(value.value)) {
    return CanonicalJson.encodeOrThrow({ type: value.type, value: String(value.value) });
  }
  return CanonicalJson.encodeOrThrow(value as unknown as CanonicalJson.CanonicalValue);
};

const canonicalNumber = (n: number): string => (n !== n ? "null" : JSON.stringify(n === 0 ? 0 : n));
const canonicalString = (strings: readonly string[], index: number): string =>
  index < 0 ? "null" : JSON.stringify(strings[index]!);

/**
 * The canonical encoding of fact `i`: the `CanonicalJson` encoding of
 * `[entity, attribute, value, validFrom, validTo, entityType, createdBy]`, with
 * `null` for absent fields. Facts are hashed in segment order, comma-separated
 * inside one JSON array, so the content is itself canonical JSON.
 */
const canonicalFact = (segment: Segment, i: number): string =>
  `[${JSON.stringify(segment.strings[segment.entity[i]!]!)},${JSON.stringify(
    segment.strings[segment.attribute[i]!]!,
  )},${canonicalValue(valueAt(segment, i))},${canonicalNumber(segment.validFrom[i]!)},${canonicalNumber(
    segment.validTo[i]!,
  )},${canonicalString(segment.strings, segment.entityType[i]!)},${canonicalString(
    segment.strings,
    segment.createdBy[i]!,
  )}]`;

/** The content ID of a segment's facts, recomputed from its columns. */
export const contentId = (segment: Omit<Segment, "id">): ContentIds.ContentId => {
  const domain = ContentIds.Domain.segment;
  const hasher = Sha256.create().update(`${domain.length}:${domain}:[`);
  const asSegment = segment as Segment;
  // Hash in batches: one string per fact would make the encoder the bottleneck.
  let batch = "";
  for (let i = 0; i < segment.count; i++) {
    batch += (i === 0 ? "" : ",") + canonicalFact(asSegment, i);
    if (batch.length > 1 << 16) {
      hasher.update(batch);
      batch = "";
    }
  }
  hasher.update(`${batch}]`);
  return `sha256-${hasher.hex()}` as ContentIds.ContentId;
};

/** Check that a segment's columns hash to its ID. */
export const verify = (segment: Segment): boolean => contentId(segment) === segment.id;

// ─── Build ─────────────────────────────────────────────────────────────────

const sortOrdinals = (count: number, compare: (i: number, j: number) => number): Uint32Array => {
  const order = Array.from({ length: count }, (_, i) => i);
  order.sort(compare);
  return Uint32Array.from(order);
};

/**
 * Build a segment from facts in any order. Pure and synchronous: run it in a
 * worker for large inputs, then transfer or encode the result.
 */
export const build = (facts: Iterable<TripleInput>): Segment => {
  const input = Array.isArray(facts) ? (facts as readonly TripleInput[]) : [...facts];
  const count = input.length;
  const ids = new Map<string, number>();
  const intern = (s: string): number => {
    let id = ids.get(s);
    if (id === undefined) ids.set(s, (id = ids.size));
    return id;
  };

  // First pass: columns over provisional dictionary IDs (insertion order).
  const raw: Columns = {
    entity: new Uint32Array(count),
    attribute: new Uint32Array(count),
    kind: new Uint8Array(count),
    num: new Float64Array(count),
    str: new Int32Array(count),
    validFrom: new Float64Array(count),
    validTo: new Float64Array(count),
    entityType: new Int32Array(count),
    createdBy: new Int32Array(count),
  };
  const rawBlobs = new Map<number, TripleValue>();
  for (let i = 0; i < count; i++) {
    const fact = input[i]!;
    raw.entity[i] = intern(fact.entityId);
    raw.attribute[i] = intern(fact.attribute);
    raw.kind[i] = KIND[fact.value.type];
    raw.num[i] = valueNumber(fact.value);
    const text = valueString(fact.value);
    raw.str[i] = text === undefined ? -1 : intern(text);
    if (fact.value.type === "blob") rawBlobs.set(i, fact.value);
    raw.validFrom[i] = fact.validFrom ?? Number.NaN;
    raw.validTo[i] = fact.validTo ?? Number.NaN;
    raw.entityType[i] = fact.entityType === undefined ? -1 : intern(fact.entityType);
    raw.createdBy[i] = fact.createdBy === undefined ? -1 : intern(fact.createdBy);
  }

  // Sort the dictionary so index order is string order, and remap.
  const provisional = [...ids.keys()];
  const strings = [...provisional].sort();
  const rank = new Int32Array(provisional.length);
  {
    const position = new Map(strings.map((s, i) => [s, i]));
    for (let i = 0; i < provisional.length; i++) rank[i] = position.get(provisional[i]!)!;
  }
  const remap = (column: Uint32Array | Int32Array) => {
    for (let i = 0; i < count; i++) {
      const id = column[i]!;
      if (id >= 0) column[i] = rank[id]!;
    }
  };
  remap(raw.entity);
  remap(raw.attribute);
  remap(raw.str);
  remap(raw.entityType);
  remap(raw.createdBy);

  // Second pass: put the facts in canonical (EAVT) order.
  const order = sortOrdinals(count, (i, j) => cmpFact(raw, i, j));
  const permute = <T extends Uint32Array | Int32Array | Float64Array | Uint8Array>(
    column: T,
  ): T => {
    const out = new (column.constructor as new (n: number) => T)(count);
    for (let i = 0; i < count; i++) out[i] = column[order[i]!]!;
    return out;
  };
  const columns: Columns = {
    entity: permute(raw.entity),
    attribute: permute(raw.attribute),
    kind: permute(raw.kind),
    num: permute(raw.num),
    str: permute(raw.str),
    validFrom: permute(raw.validFrom),
    validTo: permute(raw.validTo),
    entityType: permute(raw.entityType),
    createdBy: permute(raw.createdBy),
  };
  const blobs = new Map<number, TripleValue>();
  for (let i = 0; i < count; i++) {
    const blob = rawBlobs.get(order[i]!);
    if (blob !== undefined) blobs.set(i, blob);
  }

  // Permutation indexes. Sorts are stable, so ties keep segment order.
  const s = columns;
  const byAttribute = sortOrdinals(count, (i, j) => s.attribute[i]! - s.attribute[j]!);
  const byAttributeValue = sortOrdinals(
    count,
    (i, j) => s.attribute[i]! - s.attribute[j]! || cmpValue(s, i, j),
  );
  const refs: number[] = [];
  const typed: number[] = [];
  let entities = 0;
  const attributeIds = new Set<number>();
  for (let i = 0; i < count; i++) {
    if (s.kind[i] === KIND.ref) refs.push(i);
    if (s.entityType[i]! >= 0) typed.push(i);
    if (i === 0 || s.entity[i] !== s.entity[i - 1]) entities++;
    attributeIds.add(s.attribute[i]!);
  }
  refs.sort((i, j) => s.str[i]! - s.str[j]! || s.attribute[i]! - s.attribute[j]!);
  typed.sort((i, j) => s.entityType[i]! - s.entityType[j]!);

  const body: Omit<Segment, "id"> = {
    count,
    strings,
    ...columns,
    blobs,
    byAttribute,
    byAttributeValue,
    byRef: Uint32Array.from(refs),
    byType: Uint32Array.from(typed),
    attributes: [...attributeIds].sort((a, b) => a - b).map((id) => strings[id]!),
    entities,
  };
  return { id: contentId(body), ...body };
};

// ─── Lookup ────────────────────────────────────────────────────────────────

/** Dictionary index of `s`, or -1. */
export const stringIndex = (segment: Segment, s: string): number => {
  let lo = 0;
  let hi = segment.strings.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (segment.strings[mid]! < s) lo = mid + 1;
    else hi = mid;
  }
  return lo < segment.strings.length && segment.strings[lo] === s ? lo : -1;
};

/** First position in `[lo, hi)` whose key is not below `target`. */
const lowerBound = (lo: number, hi: number, below: (position: number) => boolean): number => {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (below(mid)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

export interface Pattern {
  readonly entity?: string;
  readonly attribute?: string;
  readonly value?: TripleValue;
  readonly entityType?: string;
}

const NONE = new Uint32Array(0);

/**
 * Ordinals of the facts matching `pattern`, using the narrowest index. The
 * result can include facts that match on an index prefix only; callers check
 * the rest (as the hexastore's own scans do).
 */
export const lookup = (segment: Segment, pattern: Pattern): Uint32Array => {
  const n = segment.count;
  if (pattern.entity !== undefined) {
    const e = stringIndex(segment, pattern.entity);
    if (e < 0) return NONE;
    const lo = lowerBound(0, n, (p) => segment.entity[p]! < e);
    const hi = lowerBound(lo, n, (p) => segment.entity[p]! <= e);
    if (pattern.attribute === undefined) return range(lo, hi);
    const a = stringIndex(segment, pattern.attribute);
    if (a < 0) return NONE;
    const alo = lowerBound(lo, hi, (p) => segment.attribute[p]! < a);
    const ahi = lowerBound(alo, hi, (p) => segment.attribute[p]! <= a);
    return range(alo, ahi);
  }
  if (pattern.attribute !== undefined) {
    const a = stringIndex(segment, pattern.attribute);
    if (a < 0) return NONE;
    const index = pattern.value === undefined ? segment.byAttribute : segment.byAttributeValue;
    const lo = lowerBound(0, n, (p) => segment.attribute[index[p]!]! < a);
    const hi = lowerBound(lo, n, (p) => segment.attribute[index[p]!]! <= a);
    if (pattern.value === undefined) return index.subarray(lo, hi);
    const key = valueKey(segment, pattern.value);
    if (key === undefined) return NONE;
    const vlo = lowerBound(lo, hi, (p) => compareKey(segment, index[p]!, key) < 0);
    const vhi = lowerBound(vlo, hi, (p) => compareKey(segment, index[p]!, key) <= 0);
    return index.subarray(vlo, vhi);
  }
  if (pattern.value?.type === "ref") {
    const v = stringIndex(segment, pattern.value.value);
    if (v < 0) return NONE;
    const index = segment.byRef;
    const lo = lowerBound(0, index.length, (p) => segment.str[index[p]!]! < v);
    const hi = lowerBound(lo, index.length, (p) => segment.str[index[p]!]! <= v);
    return index.subarray(lo, hi);
  }
  if (pattern.entityType !== undefined) {
    const t = stringIndex(segment, pattern.entityType);
    if (t < 0) return NONE;
    const index = segment.byType;
    const lo = lowerBound(0, index.length, (p) => segment.entityType[index[p]!]! < t);
    const hi = lowerBound(lo, index.length, (p) => segment.entityType[index[p]!]! <= t);
    return index.subarray(lo, hi);
  }
  return range(0, n);
};

const range = (lo: number, hi: number): Uint32Array => {
  const out = new Uint32Array(Math.max(0, hi - lo));
  for (let i = 0; i < out.length; i++) out[i] = lo + i;
  return out;
};

interface ValueKey {
  readonly kind: number;
  readonly str: number;
  readonly num: number;
}

const valueKey = (segment: Segment, value: TripleValue): ValueKey | undefined => {
  const text = valueString(value);
  const str = text === undefined ? -1 : stringIndex(segment, text);
  if (text !== undefined && str < 0) return undefined;
  return { kind: KIND[value.type], str, num: valueNumber(value) };
};

const compareKey = (segment: Segment, i: number, key: ValueKey): number =>
  segment.kind[i]! - key.kind || segment.str[i]! - key.str || cmpNum(segment.num[i]!, key.num);

/** Whether fact `i` has exactly `value`. */
export const valueEquals = (segment: Segment, i: number, value: TripleValue): boolean => {
  const key = valueKey(segment, value);
  return key !== undefined && compareKey(segment, i, key) === 0;
};

export const kindName = (segment: Segment, i: number) => KIND_NAMES[segment.kind[i]!]!;

// ─── Binary image ──────────────────────────────────────────────────────────
//
// Layout (little-endian, every column 8-byte aligned):
//   "TPXS" magic, u32 version, u32 count, u32 byRef length, u32 byType length,
//   u32 entities, u32 id length, id (ASCII), u32 JSON length, JSON (UTF-8):
//   { strings, attributes, blobs: [[ordinal, value], ...] },
//   then the columns in `COLUMN_ORDER`.
// Decoding views the columns in place: no copying or re-sorting.

const MAGIC = 0x53585054; // "TPXS"
const VERSION = 1;

type ColumnName =
  | "entity"
  | "attribute"
  | "kind"
  | "num"
  | "str"
  | "validFrom"
  | "validTo"
  | "entityType"
  | "createdBy"
  | "byAttribute"
  | "byAttributeValue"
  | "byRef"
  | "byType";

const COLUMNS: ReadonlyArray<
  readonly [
    ColumnName,
    new (buffer: ArrayBuffer, offset: number, length: number) => ArrayBufferView,
    number,
  ]
> = [
  ["num", Float64Array, 8],
  ["validFrom", Float64Array, 8],
  ["validTo", Float64Array, 8],
  ["entity", Uint32Array, 4],
  ["attribute", Uint32Array, 4],
  ["str", Int32Array, 4],
  ["entityType", Int32Array, 4],
  ["createdBy", Int32Array, 4],
  ["byAttribute", Uint32Array, 4],
  ["byAttributeValue", Uint32Array, 4],
  ["byRef", Uint32Array, 4],
  ["byType", Uint32Array, 4],
  ["kind", Uint8Array, 1],
];

const align8 = (n: number) => (n + 7) & ~7;

/** Encode a segment as one transferable buffer. */
export const encode = (segment: Segment): Uint8Array => {
  const text = new TextEncoder();
  const id = text.encode(segment.id);
  const meta = text.encode(
    JSON.stringify({
      strings: segment.strings,
      attributes: segment.attributes,
      blobs: [...segment.blobs],
    }),
  );
  let size = align8(28 + id.length + 4 + meta.length);
  for (const [name, , width] of COLUMNS) {
    size = align8(size + (segment[name] as ArrayLike<number>).length * width);
  }
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, segment.count, true);
  view.setUint32(12, segment.byRef.length, true);
  view.setUint32(16, segment.byType.length, true);
  view.setUint32(20, segment.entities, true);
  view.setUint32(24, id.length, true);
  bytes.set(id, 28);
  view.setUint32(28 + id.length, meta.length, true);
  bytes.set(meta, 32 + id.length);
  let offset = align8(32 + id.length + meta.length);
  for (const [name] of COLUMNS) {
    const column = segment[name] as ArrayBufferView;
    bytes.set(new Uint8Array(column.buffer, column.byteOffset, column.byteLength), offset);
    offset = align8(offset + column.byteLength);
  }
  return bytes;
};

export class SegmentDecodeError extends Error {
  override readonly name = "SegmentDecodeError";
}

/**
 * Decode an encoded segment. Columns are views over `bytes` (copied first if
 * it isn't 8-byte aligned). With `verify`, recompute the content ID and fail
 * if it doesn't match.
 */
export const decode = (input: Uint8Array, options: { readonly verify?: boolean } = {}): Segment => {
  const bytes = input.byteOffset % 8 === 0 ? input : input.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 32 || view.getUint32(0, true) !== MAGIC) {
    throw new SegmentDecodeError("Not a Triplex segment");
  }
  if (view.getUint32(4, true) !== VERSION) {
    throw new SegmentDecodeError(`Unsupported segment version ${view.getUint32(4, true)}`);
  }
  const count = view.getUint32(8, true);
  const refs = view.getUint32(12, true);
  const typed = view.getUint32(16, true);
  const entities = view.getUint32(20, true);
  const idLength = view.getUint32(24, true);
  const text = new TextDecoder();
  const id = text.decode(bytes.subarray(28, 28 + idLength));
  const metaLength = view.getUint32(28 + idLength, true);
  const meta = JSON.parse(
    text.decode(bytes.subarray(32 + idLength, 32 + idLength + metaLength)),
  ) as {
    strings: string[];
    attributes: string[];
    blobs: [number, TripleValue][];
  };
  let offset = align8(32 + idLength + metaLength);
  const columns: Partial<Record<ColumnName, ArrayBufferView>> = {};
  for (const [name, Type, width] of COLUMNS) {
    const length = name === "byRef" ? refs : name === "byType" ? typed : count;
    if (bytes.byteOffset + offset + length * width > bytes.buffer.byteLength) {
      throw new SegmentDecodeError("Truncated segment");
    }
    columns[name] = new Type(bytes.buffer as ArrayBuffer, bytes.byteOffset + offset, length);
    offset = align8(offset + length * width);
  }
  if (!ContentIds.isContentId(id)) throw new SegmentDecodeError("Invalid segment ID");
  const segment = {
    id,
    count,
    strings: meta.strings,
    attributes: meta.attributes,
    blobs: new Map(meta.blobs),
    entities,
    ...(columns as Record<ColumnName, never>),
  } as Segment;
  if (options.verify && !verify(segment)) {
    throw new SegmentDecodeError(`Segment content does not match its ID ${id}`);
  }
  return segment;
};
