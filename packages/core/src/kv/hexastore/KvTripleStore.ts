/**
 * Hexastore triple store implementation on ordered KV storage.
 *
 * Each triple is stored in 4 (or 5, for refs) index orderings plus a META record.
 * This enables efficient pattern matching from any starting point:
 * - Know the entity? Use EAVT.
 * - Know the attribute? Use AEVT.
 * - Know the attribute + value? Use AVET.
 * - Know a ref target? Use VAET.
 *
 * Index entries store the tripleId as their value (UTF-8 encoded).
 * Full datom data is stored in the META index keyed by tripleId.
 * This enables efficient META lookups during scans.
 */

import { Effect, Stream } from "effect";
import type { TripleValue } from "../../Value.js";
import type { KvBackendService } from "../kv/KvBackend.js";
import type { ResolvedTemporalBasis } from "../../Temporal.js";
import { unsafe } from "../../Branded.js";
import {
  eavtKey,
  aevtKey,
  avetKey,
  vaetKey,
  metaKey,
  typeKey,
  typePrefixRange,
  eavtKeyStr,
  aevtKeyStr,
  avetKeyStr,
  vaetKeyStr,
  metaKeyStr,
  typeKeyStr,
} from "./indexes.js";
import { tString, encodeStringStr, TAG_STRING } from "./tuple.js";
import { concat } from "../kv/encoding.js";
import { META_PREFIX } from "./indexes.js";
import * as Segment from "../../segment/Segment.js";
import {
  ATTACHMENT_RANGE,
  attachmentVisible,
  datomAt,
  decodeAttachment,
  parseTripleId,
  tripleId as segmentTripleId,
  validAt as segmentValidAt,
  type Attachment,
} from "./segments.js";
import { valueToTuplePart, type ScanPattern, patternToScan, valueToPartStr } from "./scan.js";

// ─── Datom: The fundamental unit of data ───────────────────────────────────

/**
 * A datom is a single fact: (entity, attribute, value, txId, tripleId).
 * This is what the hexastore stores and what the Datalog executor operates on.
 */
export interface Datom {
  readonly tripleId: string;
  readonly entity: string;
  readonly attribute: string;
  readonly value: TripleValue;
  readonly txId: string;
  readonly recordedAt: number;
  readonly recordedPosition: number;
  readonly validFrom: number;
  readonly validTo: number | null;
  readonly createdBy: string | null;
  readonly retractedAt: number | null;
  readonly retractedPosition: number | null;
  readonly retractTxId: string | null;
  readonly entityType: string | null;
}

// ─── META record serialization ─────────────────────────────────────────────

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Fast ASCII-only string to Uint8Array conversion.
 * Triple IDs are always ASCII (UUIDs), so this avoids TextEncoder overhead.
 * Falls back to TextEncoder for non-ASCII (shouldn't happen for triple IDs).
 */
const asciiToBytes = (s: string): Uint8Array => {
  const len = s.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x80) return textEncoder.encode(s); // fallback
    bytes[i] = c;
  }
  return bytes;
};

// ─── Binary Datom Format ───────────────────────────────────────────────────
//
// Custom binary format for META records, replacing JSON.stringify/parse.
// Eliminates 2 allocations per triple (JSON string + textEncoder.encode).
//
// Layout (all multi-byte integers are big-endian):
//   [1 byte]  format version (0x01)
//   [4 bytes] tripleId length, then [N bytes] tripleId (UTF-8)
//   [4 bytes] entity length, then [N bytes] entity
//   [4 bytes] attribute length, then [N bytes] attribute
//   [1 byte]  value type tag (0=string, 1=number, 2=boolean, 3=datetime, 4=ref, 5=json, 6=blob)
//   [varies]  value payload (see below)
//   [4 bytes] txId length, then [N bytes] txId
//   [8 bytes] recordedAt (float64 big-endian)
//   [1 byte]  flags: bit0 = hasCreatedBy, bit1 = hasRetractedAt, bit2 = hasRetractTxId, bit3 = hasEntityType
//   [conditional] createdBy: [4 bytes] length + [N bytes] string
//   [conditional] retractedAt: [8 bytes] float64
//   [conditional] retractTxId: [4 bytes] length + [N bytes] string
//   [conditional] entityType: [4 bytes] length + [N bytes] string
//   [8 bytes] validFrom (float64)
//   [1 byte] temporal flags: bit0 = hasValidTo
//   [conditional] validTo: [8 bytes]
//   [8 bytes] recordedPosition (float64)
//   [1 byte] hasRetractedPosition
//   [conditional: 8 bytes retractedPosition]
//
// Value payloads:
//   string/ref/blob: [4 bytes] length + [N bytes] UTF-8
//   number/datetime: [8 bytes] float64
//   boolean: [1 byte] 0x00/0x01
//   json: [4 bytes] length + [N bytes] JSON string UTF-8
//   blob: [4 bytes] value length + [N bytes] value + [4 bytes] mimeType length + [N bytes] mimeType
//         + [8 bytes] size (float64) + [1 byte] hasFilename + [conditional: 4 bytes len + N bytes]

const FORMAT_VERSION = 0x01;

// Value type tags for binary format
const VT_STRING = 0;
const VT_NUMBER = 1;
const VT_BOOLEAN = 2;
const VT_DATETIME = 3;
const VT_REF = 4;
const VT_JSON = 5;
const VT_BLOB = 6;

// Reusable write buffer (4KB, grows if needed). Avoids per-datom allocation.
let _writeBuf = new Uint8Array(4096);
let _writeDV = new DataView(_writeBuf.buffer, _writeBuf.byteOffset, _writeBuf.byteLength);

const ensureCapacity = (needed: number, offset: number): void => {
  if (offset + needed > _writeBuf.length) {
    const newSize = Math.max(_writeBuf.length * 2, offset + needed);
    const newBuf = new Uint8Array(newSize);
    newBuf.set(_writeBuf.subarray(0, offset), 0);
    _writeBuf = newBuf;
    _writeDV = new DataView(_writeBuf.buffer, _writeBuf.byteOffset, _writeBuf.byteLength);
  }
};

/** Write a length-prefixed string (4-byte length + UTF-8 bytes). Returns new offset. */
const writeStr = (s: string, offset: number): number => {
  // Fast path: ASCII-only (common for entity IDs, attributes, UUIDs)
  const len = s.length;
  ensureCapacity(4 + len * 3, offset); // worst case: 3 bytes per char for UTF-8
  let isAscii = true;
  for (let i = 0; i < len; i++) {
    if (s.charCodeAt(i) >= 0x80) {
      isAscii = false;
      break;
    }
  }
  if (isAscii) {
    _writeDV.setUint32(offset, len, false);
    offset += 4;
    for (let i = 0; i < len; i++) {
      _writeBuf[offset++] = s.charCodeAt(i);
    }
    return offset;
  }
  // Slow path: use TextEncoder
  const encoded = textEncoder.encode(s);
  ensureCapacity(4 + encoded.length, offset);
  _writeDV.setUint32(offset, encoded.length, false);
  offset += 4;
  _writeBuf.set(encoded, offset);
  return offset + encoded.length;
};

/** Write a nullable length-prefixed string. Returns new offset. */
const writeNullableStr = (s: string | null, offset: number): number => {
  if (s === null) return offset;
  return writeStr(s, offset);
};

/**
 * Serialize a Datom to bytes for META storage using custom binary format.
 * Uses a reusable write buffer to avoid per-datom allocation.
 */
const serializeDatom = (datom: Datom): Uint8Array => {
  let offset = 0;

  // Version
  ensureCapacity(1, offset);
  _writeBuf[offset++] = FORMAT_VERSION;

  // Fixed strings
  offset = writeStr(datom.tripleId, offset);
  offset = writeStr(datom.entity, offset);
  offset = writeStr(datom.attribute, offset);

  // Value
  const v = datom.value;
  ensureCapacity(1, offset);
  switch (v.type) {
    case "string":
      _writeBuf[offset++] = VT_STRING;
      offset = writeStr(v.value, offset);
      break;
    case "number":
      _writeBuf[offset++] = VT_NUMBER;
      ensureCapacity(8, offset);
      _writeDV.setFloat64(offset, v.value, false);
      offset += 8;
      break;
    case "boolean":
      _writeBuf[offset++] = VT_BOOLEAN;
      ensureCapacity(1, offset);
      _writeBuf[offset++] = v.value ? 1 : 0;
      break;
    case "datetime":
      _writeBuf[offset++] = VT_DATETIME;
      ensureCapacity(8, offset);
      _writeDV.setFloat64(offset, v.value, false);
      offset += 8;
      break;
    case "ref":
      _writeBuf[offset++] = VT_REF;
      offset = writeStr(v.value, offset);
      break;
    case "json": {
      _writeBuf[offset++] = VT_JSON;
      const jsonStr = JSON.stringify(v.value);
      const jsonBytes = textEncoder.encode(jsonStr);
      ensureCapacity(4 + jsonBytes.length, offset);
      _writeDV.setUint32(offset, jsonBytes.length, false);
      offset += 4;
      _writeBuf.set(jsonBytes, offset);
      offset += jsonBytes.length;
      break;
    }
    case "blob": {
      _writeBuf[offset++] = VT_BLOB;
      offset = writeStr(v.value, offset); // hash
      offset = writeStr(v.mimeType, offset);
      ensureCapacity(8, offset);
      _writeDV.setFloat64(offset, v.size, false);
      offset += 8;
      if (v.filename !== undefined) {
        ensureCapacity(1, offset);
        _writeBuf[offset++] = 1;
        offset = writeStr(v.filename, offset);
      } else {
        ensureCapacity(1, offset);
        _writeBuf[offset++] = 0;
      }
      break;
    }
  }

  // txId
  offset = writeStr(datom.txId, offset);

  // recordedAt
  ensureCapacity(8, offset);
  _writeDV.setFloat64(offset, datom.recordedAt, false);
  offset += 8;

  // Flags
  const flags =
    (datom.createdBy !== null ? 0x01 : 0) |
    (datom.retractedAt !== null ? 0x02 : 0) |
    (datom.retractTxId !== null ? 0x04 : 0) |
    (datom.entityType !== null ? 0x08 : 0);
  ensureCapacity(1, offset);
  _writeBuf[offset++] = flags;

  // Conditional fields
  offset = writeNullableStr(datom.createdBy, offset);
  if (datom.retractedAt !== null) {
    ensureCapacity(8, offset);
    _writeDV.setFloat64(offset, datom.retractedAt, false);
    offset += 8;
  }
  offset = writeNullableStr(datom.retractTxId, offset);
  offset = writeNullableStr(datom.entityType, offset);

  // Business-time interval.
  ensureCapacity(9, offset);
  _writeDV.setFloat64(offset, datom.validFrom, false);
  offset += 8;
  const temporalFlags = datom.validTo !== null ? 0x01 : 0;
  _writeBuf[offset++] = temporalFlags;
  if (datom.validTo !== null) {
    ensureCapacity(8, offset);
    _writeDV.setFloat64(offset, datom.validTo, false);
    offset += 8;
  }
  // Exact transaction-position cut for snapshot-stable pagination.
  ensureCapacity(9, offset);
  _writeDV.setFloat64(offset, datom.recordedPosition, false);
  offset += 8;
  _writeBuf[offset++] = datom.retractedPosition === null ? 0 : 1;
  if (datom.retractedPosition !== null) {
    ensureCapacity(8, offset);
    _writeDV.setFloat64(offset, datom.retractedPosition, false);
    offset += 8;
  }

  // Copy out the result (cannot share the reusable buffer)
  const result = new Uint8Array(offset);
  result.set(_writeBuf.subarray(0, offset));
  return result;
};

/** Read a length-prefixed string. Returns [string, newOffset]. */
const readStr = (buf: Uint8Array, offset: number): [string, number] => {
  const len =
    buf[offset]! * 0x1000000 +
    buf[offset + 1]! * 0x10000 +
    buf[offset + 2]! * 0x100 +
    buf[offset + 3]!;
  offset += 4;
  // Fast path: ASCII
  let isAscii = true;
  for (let i = 0; i < len; i++) {
    if (buf[offset + i]! >= 0x80) {
      isAscii = false;
      break;
    }
  }
  if (isAscii) {
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(buf[offset + i]!);
    return [s, offset + len];
  }
  return [textDecoder.decode(buf.subarray(offset, offset + len)), offset + len];
};

/**
 * Deserialize a Datom from META storage bytes.
 * Decode the current Triplex datom format.
 */
const deserializeDatom = (bytes: Uint8Array): Datom => {
  const version = bytes[0];
  if (version !== FORMAT_VERSION) throw new Error(`Unsupported datom format: ${String(version)}`);

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 1; // skip version byte

  let tripleId: string;
  [tripleId, offset] = readStr(bytes, offset);

  let entity: string;
  [entity, offset] = readStr(bytes, offset);

  let attribute: string;
  [attribute, offset] = readStr(bytes, offset);

  // Value
  const valueTag = bytes[offset++]!;
  let value: TripleValue;
  switch (valueTag) {
    case VT_STRING: {
      let sv: string;
      [sv, offset] = readStr(bytes, offset);
      value = { type: "string", value: sv };
      break;
    }
    case VT_NUMBER:
      value = { type: "number", value: dv.getFloat64(offset, false) };
      offset += 8;
      break;
    case VT_BOOLEAN:
      value = { type: "boolean", value: bytes[offset++]! !== 0 };
      break;
    case VT_DATETIME:
      value = { type: "datetime", value: dv.getFloat64(offset, false) };
      offset += 8;
      break;
    case VT_REF: {
      let rv: string;
      [rv, offset] = readStr(bytes, offset);
      value = { type: "ref", value: unsafe.entityId(rv) };
      break;
    }
    case VT_JSON: {
      const jsonLen = dv.getUint32(offset, false);
      offset += 4;
      const jsonStr = textDecoder.decode(bytes.subarray(offset, offset + jsonLen));
      value = { type: "json", value: JSON.parse(jsonStr) as unknown };
      offset += jsonLen;
      break;
    }
    case VT_BLOB: {
      let bv: string, mimeType: string;
      [bv, offset] = readStr(bytes, offset);
      [mimeType, offset] = readStr(bytes, offset);
      const size = dv.getFloat64(offset, false);
      offset += 8;
      const hasFilename = bytes[offset++]! !== 0;
      let filename: string | undefined;
      if (hasFilename) {
        [filename, offset] = readStr(bytes, offset);
      }
      value = {
        type: "blob",
        value: bv,
        mimeType,
        size,
        ...(filename !== undefined ? { filename } : {}),
      };
      break;
    }
    default:
      throw new Error(`Unknown value type tag: ${valueTag}`);
  }

  let txId: string;
  [txId, offset] = readStr(bytes, offset);

  const recordedAt = dv.getFloat64(offset, false);
  offset += 8;

  const flags = bytes[offset++]!;
  const hasCreatedBy = (flags & 0x01) !== 0;
  const hasRetractedAt = (flags & 0x02) !== 0;
  const hasRetractTxId = (flags & 0x04) !== 0;
  const hasEntityType = (flags & 0x08) !== 0;

  let createdBy: string | null = null;
  if (hasCreatedBy) {
    [createdBy, offset] = readStr(bytes, offset);
  }

  let retractedAt: number | null = null;
  if (hasRetractedAt) {
    retractedAt = dv.getFloat64(offset, false);
    offset += 8;
  }

  let retractTxId: string | null = null;
  if (hasRetractTxId) {
    [retractTxId, offset] = readStr(bytes, offset);
  }

  let entityType: string | null = null;
  if (hasEntityType) {
    [entityType, offset] = readStr(bytes, offset);
  }

  const validFrom = dv.getFloat64(offset, false);
  offset += 8;
  let validTo: number | null = null;
  const temporalFlags = bytes[offset++]!;
  if ((temporalFlags & 0x01) !== 0) {
    validTo = dv.getFloat64(offset, false);
    offset += 8;
  }

  const recordedPosition = dv.getFloat64(offset, false);
  offset += 8;
  let retractedPosition: number | null = null;
  if (bytes[offset++]! !== 0) {
    retractedPosition = dv.getFloat64(offset, false);
  }

  return {
    tripleId,
    entity,
    attribute,
    value,
    txId,
    recordedAt,
    recordedPosition,
    validFrom,
    validTo,
    createdBy,
    retractedAt,
    retractedPosition,
    retractTxId,
    entityType,
  };
};

// ─── KvTripleStore ─────────────────────────────────────────────────────────

/**
 * Hexastore triple store backed by an ordered KV backend.
 *
 * Stores datoms across 4 index orderings (EAVT, AEVT, AVET, VAET) plus
 * a META index for full datom data. Index entries store the tripleId as
 * their value, enabling efficient META lookups during scans.
 */
export class KvTripleStore {
  /**
   * Datom cache: tripleId → Datom.
   * Populated on assert/assertBatch and on first scan-hit.
   * Avoids repeated JSON.parse of META records.
   * Entries are invalidated on retract (retractedAt changes).
   */
  private readonly datomCache = new Map<string, Datom>();

  constructor(private readonly kv: KvBackendService) {}

  /** Drop decoded datoms after an external/backend transaction commits. */
  clearCache(): void {
    this.datomCache.clear();
    this.attachmentsCache = null;
    this.overlayCache.clear();
  }

  // ─── Attached segments ──────────────────────────────────────────────────
  //
  // Every read merges the facts of attached segments with the indexed ones.
  // A backend without a segment store can't have attachments, so it pays
  // nothing for this.

  private attachmentsCache: Attachment[] | null = null;
  /** Retracted segment facts (their META records), per attachment position. */
  private readonly overlayCache = new Map<number, Map<string, Datom>>();

  private attachmentsSync(): Attachment[] | null {
    if (this.attachmentsCache !== null) return this.attachmentsCache;
    if (this.kv.segments === undefined) return (this.attachmentsCache = []);
    if (!this.kv.getRangeSync) return null;
    return (this.attachmentsCache = this.kv
      .getRangeSync(ATTACHMENT_RANGE)
      .map(([key, value]) => decodeAttachment(key, value, this.kv.segments)));
  }

  /** Attached segments, in position order. */
  attachments(): Effect.Effect<Attachment[]> {
    const sync = this.attachmentsSync();
    if (sync !== null) return Effect.succeed(sync);
    return Stream.runCollect(this.kv.getRange(ATTACHMENT_RANGE)).pipe(
      Effect.map(
        (entries) =>
          (this.attachmentsCache = Array.from(entries, ([key, value]) =>
            decodeAttachment(key, value, this.kv.segments),
          )),
      ),
    );
  }

  private overlayRange(attachment: Attachment) {
    const start = concat(
      META_PREFIX,
      new Uint8Array([TAG_STRING]),
      asciiToBytes(attachment.idPrefix),
    );
    return { start, end: concat(start, new Uint8Array([0xff])) };
  }

  private overlaysSync(attachment: Attachment): Map<string, Datom> | null {
    const cached = this.overlayCache.get(attachment.position);
    if (cached !== undefined) return cached;
    if (!this.kv.getRangeSync) return null;
    const overlay = new Map<string, Datom>();
    for (const [, value] of this.kv.getRangeSync(this.overlayRange(attachment))) {
      const datom = deserializeDatom(value);
      overlay.set(datom.tripleId, datom);
    }
    this.overlayCache.set(attachment.position, overlay);
    return overlay;
  }

  private overlays(attachment: Attachment): Effect.Effect<Map<string, Datom>> {
    const sync = this.overlaysSync(attachment);
    if (sync !== null) return Effect.succeed(sync);
    return Stream.runCollect(this.kv.getRange(this.overlayRange(attachment))).pipe(
      Effect.map((entries) => {
        const overlay = new Map<string, Datom>();
        for (const [, value] of entries) {
          const datom = deserializeDatom(value);
          overlay.set(datom.tripleId, datom);
        }
        this.overlayCache.set(attachment.position, overlay);
        return overlay;
      }),
    );
  }

  /**
   * Segment facts matching `pattern`. With a basis, skip attachments recorded
   * after it and facts not valid at it before decoding them; callers still
   * apply the full visibility check.
   */
  private collectSegments(
    attachments: readonly Attachment[],
    overlays: ReadonlyMap<number, ReadonlyMap<string, Datom>>,
    pattern: ScanPattern & { readonly entityType?: string },
    includeRetracted: boolean,
    basis?: ResolvedTemporalBasis,
  ): Datom[] {
    const results: Datom[] = [];
    for (const attachment of attachments) {
      if (basis !== undefined && !attachmentVisible(attachment, basis)) continue;
      const overlay = overlays.get(attachment.position)!;
      const ordinals = Segment.lookup(attachment.segment, pattern);
      for (let k = 0; k < ordinals.length; k++) {
        const ordinal = ordinals[k]!;
        if (basis !== undefined && !segmentValidAt(attachment, ordinal, basis.validAt)) continue;
        const datom =
          (overlay.size === 0 ? undefined : overlay.get(segmentTripleId(attachment, ordinal))) ??
          datomAt(attachment, ordinal);
        if (!includeRetracted && datom.retractedAt !== null) continue;
        if (!matchesPattern(datom, pattern)) continue;
        if (pattern.entityType !== undefined && datom.entityType !== pattern.entityType) continue;
        results.push(datom);
      }
    }
    return results;
  }

  private segmentsSync(
    pattern: ScanPattern & { readonly entityType?: string },
    includeRetracted: boolean,
    basis?: ResolvedTemporalBasis,
  ): Datom[] | null {
    const attachments = this.attachmentsSync();
    if (attachments === null) return null;
    if (attachments.length === 0) return [];
    const overlays = new Map<number, Map<string, Datom>>();
    for (const attachment of attachments) {
      const overlay = this.overlaysSync(attachment);
      if (overlay === null) return null;
      overlays.set(attachment.position, overlay);
    }
    return this.collectSegments(attachments, overlays, pattern, includeRetracted, basis);
  }

  private segmentsAsync(
    pattern: ScanPattern & { readonly entityType?: string },
    includeRetracted: boolean,
    basis?: ResolvedTemporalBasis,
  ): Effect.Effect<Datom[]> {
    const sync = this.segmentsSync(pattern, includeRetracted, basis);
    if (sync !== null) return Effect.succeed(sync);
    return Effect.gen({ self: this }, function* () {
      const attachments = yield* this.attachments();
      const overlays = new Map<number, Map<string, Datom>>();
      for (const attachment of attachments) {
        overlays.set(attachment.position, yield* this.overlays(attachment));
      }
      return this.collectSegments(attachments, overlays, pattern, includeRetracted, basis);
    });
  }

  /** The unretracted segment datom for a segment triple ID; undefined if it isn't one. */
  private segmentDatom(tripleId: string): Effect.Effect<Datom | null | undefined> {
    const location = parseTripleId(tripleId);
    if (location === undefined || this.kv.segments === undefined) return Effect.succeed(undefined);
    return this.attachments().pipe(
      Effect.map((attachments) => {
        const attachment = attachments.find((a) => a.position === location.position);
        return attachment === undefined || location.ordinal >= attachment.segment.count
          ? null
          : datomAt(attachment, location.ordinal);
      }),
    );
  }

  private segmentDatomSync(tripleId: string): Datom | null | undefined {
    const location = parseTripleId(tripleId);
    if (location === undefined) return undefined;
    const attachments = this.attachmentsSync();
    const attachment = attachments?.find((a) => a.position === location.position);
    return attachment === undefined || location.ordinal >= attachment.segment.count
      ? null
      : datomAt(attachment, location.ordinal);
  }

  /**
   * Assert a new datom into the store.
   * Writes to all indexes + META, storing tripleId as the index entry value.
   */
  assert(datom: Datom): Effect.Effect<void> {
    const entityPart = tString(datom.entity);
    const attrPart = tString(datom.attribute);
    const valuePart = valueToTuplePart(datom.value);
    const txPart = tString(datom.txId);
    const idPart = tString(datom.tripleId);
    const tripleIdValue = textEncoder.encode(datom.tripleId);

    const entries: Array<readonly [Uint8Array, Uint8Array]> = [
      [eavtKey(entityPart, attrPart, valuePart, txPart, idPart), tripleIdValue],
      [aevtKey(attrPart, entityPart, valuePart, txPart, idPart), tripleIdValue],
      [avetKey(attrPart, valuePart, entityPart, txPart, idPart), tripleIdValue],
    ];

    if (datom.value.type === "ref") {
      entries.push([vaetKey(valuePart, attrPart, entityPart, txPart, idPart), tripleIdValue]);
    }

    entries.push([metaKey(datom.tripleId), serializeDatom(datom)]);

    // TYPE index for entityType queries
    if (datom.entityType !== null) {
      entries.push([typeKey(datom.entityType, datom.tripleId), tripleIdValue]);
    }

    // Populate datom cache
    this.datomCache.set(datom.tripleId, datom);

    return this.kv.setAll(entries);
  }

  /**
   * Assert multiple datoms in a single operation.
   * Builds all KV entries synchronously, then writes them via setAll.
   *
   * Uses a latin1 string fast path when the backend supports setAllStr
   * (InMemoryKvBackend). This bypasses ~90 Uint8Array allocations per triple
   * by encoding index keys directly as latin1 strings.
   */
  assertBatch(datoms: readonly Datom[]): Effect.Effect<void> {
    // String fast path: build latin1 string keys directly (zero Uint8Array allocs for keys)
    if (this.kv.setAllStr) {
      return this.assertBatchStr(datoms);
    }

    // Standard path: Uint8Array keys for non-InMemory backends
    const entries: Array<readonly [Uint8Array, Uint8Array]> = [];
    for (const datom of datoms) {
      const entityPart = tString(datom.entity);
      const attrPart = tString(datom.attribute);
      const valuePart = valueToTuplePart(datom.value);
      const txPart = tString(datom.txId);
      const idPart = tString(datom.tripleId);
      const tripleIdValue = textEncoder.encode(datom.tripleId);

      entries.push([eavtKey(entityPart, attrPart, valuePart, txPart, idPart), tripleIdValue]);
      entries.push([aevtKey(attrPart, entityPart, valuePart, txPart, idPart), tripleIdValue]);
      entries.push([avetKey(attrPart, valuePart, entityPart, txPart, idPart), tripleIdValue]);

      if (datom.value.type === "ref") {
        entries.push([vaetKey(valuePart, attrPart, entityPart, txPart, idPart), tripleIdValue]);
      }

      entries.push([metaKey(datom.tripleId), serializeDatom(datom)]);

      if (datom.entityType !== null) {
        entries.push([typeKey(datom.entityType, datom.tripleId), tripleIdValue]);
      }

      this.datomCache.set(datom.tripleId, datom);
    }

    return this.kv.setAll(entries);
  }

  /**
   * Latin1 string fast path for assertBatch.
   * Encodes each tuple part once and reuses across index keys.
   * Uses direct encoders (encodeStringStr) to skip TuplePart object allocation.
   * Values are still Uint8Array (META serialization).
   */
  private assertBatchStr(datoms: readonly Datom[]): Effect.Effect<void> {
    const entries: Array<readonly [string, Uint8Array]> = [];

    for (const datom of datoms) {
      // Encode each part once — reused across EAVT, AEVT, AVET, VAET keys
      // Uses encodeStringStr directly (no intermediate TuplePart objects)
      const eStr = encodeStringStr(datom.entity);
      const aStr = encodeStringStr(datom.attribute);
      const vStr = valueToPartStr(datom.value);
      const txStr = encodeStringStr(datom.txId);
      const tripleIdValue = asciiToBytes(datom.tripleId);
      const tripleIdStr = encodeStringStr(datom.tripleId);

      entries.push(
        [eavtKeyStr(eStr, aStr, vStr, txStr, tripleIdStr), tripleIdValue],
        [aevtKeyStr(aStr, eStr, vStr, txStr, tripleIdStr), tripleIdValue],
        [avetKeyStr(aStr, vStr, eStr, txStr, tripleIdStr), tripleIdValue],
      );

      if (datom.value.type === "ref") {
        entries.push([vaetKeyStr(vStr, aStr, eStr, txStr, tripleIdStr), tripleIdValue]);
      }

      entries.push([metaKeyStr(tripleIdStr), serializeDatom(datom)]);

      if (datom.entityType !== null) {
        const etStr = encodeStringStr(datom.entityType);
        entries.push([typeKeyStr(etStr, tripleIdStr), tripleIdValue]);
      }

      this.datomCache.set(datom.tripleId, datom);
    }

    this.kv.setAllStr!(entries);
    return Effect.void;
  }

  /**
   * Retract a triple by ID.
   * Updates the META record with retractedAt -- does NOT remove index keys.
   */
  retract(
    tripleId: string,
    retractedAt: number,
    retractTxId: string,
    retractedPosition: number,
  ): Effect.Effect<boolean> {
    const key = metaKey(tripleId);
    return Effect.gen({ self: this }, function* () {
      // Try cache first
      let datom = this.datomCache.get(tripleId);
      if (!datom) {
        const existing = yield* this.kv.get(key);
        if (existing === null) {
          // A segment fact: its retraction becomes a META record overriding the segment.
          const fromSegment = yield* this.segmentDatom(tripleId);
          if (!fromSegment) return false;
          datom = fromSegment;
        } else {
          datom = deserializeDatom(existing);
        }
      }
      if (datom.retractedAt !== null) return false; // Already retracted

      const updated: Datom = {
        ...datom,
        retractedAt,
        retractedPosition,
        retractTxId,
      };

      yield* this.kv.set(key, serializeDatom(updated));
      // Update cache
      this.datomCache.set(tripleId, updated);
      return true;
    });
  }

  /**
   * Get a datom by triple ID from the META index.
   */
  getById(tripleId: string): Effect.Effect<Datom | null> {
    // Fast path: check cache first
    const cached = this.datomCache.get(tripleId);
    if (cached) return Effect.succeed(cached);

    return Effect.gen({ self: this }, function* () {
      const bytes = yield* this.kv.get(metaKey(tripleId));
      if (bytes === null) return (yield* this.segmentDatom(tripleId)) ?? null;
      const datom = deserializeDatom(bytes);
      this.datomCache.set(tripleId, datom);
      return datom;
    });
  }

  /**
   * Get a datom by triple ID synchronously (cache or sync KV lookup).
   * Returns null if not found.
   */
  getByIdSync(tripleId: string): Datom | null {
    const cached = this.datomCache.get(tripleId);
    if (cached) return cached;

    if (this.kv.getSync) {
      const bytes = this.kv.getSync(metaKey(tripleId));
      if (bytes === null) return this.segmentDatomSync(tripleId) ?? null;
      const datom = deserializeDatom(bytes);
      this.datomCache.set(tripleId, datom);
      return datom;
    }

    return null;
  }

  /**
   * Scan for datoms matching a pattern.
   * Resolves full datoms via META lookups using tripleId stored in index values.
   * Filters out retracted triples by default.
   */
  scan(pattern: ScanPattern, options?: { includeRetracted?: boolean }): Stream.Stream<Datom> {
    const { start, end } = patternToScan(pattern);
    const includeRetracted = options?.includeRetracted ?? false;

    return this.kv.getRange({ start, end }).pipe(
      // The value of each index entry is the tripleId (UTF-8)
      Stream.mapEffect(([_key, value]) => {
        const tripleId = textDecoder.decode(value);
        return this.getById(tripleId);
      }),
      // Filter nulls (shouldn't happen but be safe)
      Stream.filter((datom): datom is Datom => datom !== null),
      // Filter retracted
      Stream.filter((datom) => includeRetracted || datom.retractedAt === null),
      // Verify pattern match (for components not covered by the index prefix)
      Stream.filter((datom) => matchesPattern(datom, pattern)),
      Stream.concat(Stream.fromIterableEffect(this.segmentsAsync(pattern, includeRetracted))),
    );
  }

  /**
   * Synchronous scan that returns Datom[] directly.
   * Bypasses Effect/Stream overhead entirely — critical for Datalog join performance.
   * Only works when the KV backend supports synchronous operations (InMemoryKvBackend).
   * Falls back to null if sync is not available.
   */
  scanCollect(
    pattern: ScanPattern,
    options?: { includeRetracted?: boolean; basis?: ResolvedTemporalBasis },
  ): Datom[] | null {
    if (!this.kv.getRangeSync) return null;

    const { start, end } = patternToScan(pattern);
    const includeRetracted = options?.includeRetracted ?? false;
    const entries = this.kv.getRangeSync({ start, end });
    const results: Datom[] = [];

    for (let i = 0; i < entries.length; i++) {
      const tripleId = textDecoder.decode(entries[i]![1]);
      const datom = this.getByIdSync(tripleId);
      if (datom === null) continue;
      if (!includeRetracted && datom.retractedAt !== null) continue;
      if (!matchesPattern(datom, pattern)) continue;
      results.push(datom);
    }

    const segments = this.segmentsSync(pattern, includeRetracted, options?.basis);
    if (segments === null) return null;
    for (const datom of segments) results.push(datom);
    return results;
  }

  /**
   * Look up all active datoms with a given entityType.
   * Scans the TYPE index in the KV backend for O(k) performance.
   * Returns empty array if no entries exist for the type.
   * Returns null if sync KV operations are not available (caller should fall back).
   */
  getByEntityType(entityType: string): Datom[] | null {
    return this.getByEntityTypeWhere(entityType, (datom) => datom.retractedAt === null);
  }

  /**
   * Datoms of one entity type visible at a bitemporal basis, read from the TYPE
   * index. Retraction only rewrites META, so the index still names every datom
   * ever asserted with this type and the basis decides which are visible.
   */
  getByEntityTypeTemporal(entityType: string, basis: ResolvedTemporalBasis): Datom[] | null {
    return this.getByEntityTypeWhere(entityType, (datom) => visibleAt(datom, basis));
  }

  private getByEntityTypeWhere(
    entityType: string,
    keep: (datom: Datom) => boolean,
  ): Datom[] | null {
    if (!this.kv.getRangeSync) return null;

    const { start, end } = typePrefixRange(entityType);
    const entries = this.kv.getRangeSync({ start, end });
    const results: Datom[] = [];

    for (let i = 0; i < entries.length; i++) {
      const tripleId = textDecoder.decode(entries[i]![1]);
      const datom = this.getByIdSync(tripleId);
      if (datom === null || !keep(datom)) continue;
      results.push(datom);
    }
    const segments = this.segmentsSync({ entityType }, false);
    if (segments === null) return null;
    for (const datom of segments) results.push(datom);
    return results;
  }

  // ─── Batched async methods (eliminates N+1 for FDB) ─────────────────────

  /**
   * Batch-fetch META records for a list of tripleIds.
   * Uses the datomCache for hits, then fetches all cache misses in a
   * single `getMany` call (1 network round trip for FDB).
   * Populates the cache for future lookups.
   */
  private batchFetchMeta(tripleIds: readonly string[]): Effect.Effect<(Datom | null)[]> {
    // Partition into cached hits and uncached misses
    const results = Array.from({ length: tripleIds.length }, () => null as Datom | null);
    const uncachedIndices: number[] = [];
    const uncachedKeys: Uint8Array[] = [];

    for (let i = 0; i < tripleIds.length; i++) {
      const cached = this.datomCache.get(tripleIds[i]!);
      if (cached) {
        results[i] = cached;
      } else {
        uncachedIndices.push(i);
        uncachedKeys.push(metaKey(tripleIds[i]!));
      }
    }

    if (uncachedIndices.length === 0) {
      return Effect.succeed(results);
    }

    return Effect.gen({ self: this }, function* () {
      const fetched = yield* this.kv.getMany(uncachedKeys);
      for (let j = 0; j < uncachedIndices.length; j++) {
        const idx = uncachedIndices[j]!;
        const [, value] = fetched[j]!;
        if (value !== null) {
          const datom = deserializeDatom(value);
          this.datomCache.set(tripleIds[idx]!, datom);
          results[idx] = datom;
        } else {
          results[idx] = (yield* this.segmentDatom(tripleIds[idx]!)) ?? null;
        }
      }
      return results;
    });
  }

  /**
   * Async scan that collects all results eagerly with batched META fetches.
   * Uses 1 getRange call + 1 getMany call = 2 network round trips total,
   * instead of 1 + N for the streaming scan path.
   */
  scanCollectAsync(
    pattern: ScanPattern,
    options?: { includeRetracted?: boolean; basis?: ResolvedTemporalBasis },
  ): Effect.Effect<Datom[]> {
    const { start, end } = patternToScan(pattern);
    const includeRetracted = options?.includeRetracted ?? false;

    return Effect.gen({ self: this }, function* () {
      // 1. Range scan to collect all tripleIds
      const entries = yield* Stream.runCollect(this.kv.getRange({ start, end }));
      const tripleIds: string[] = [];
      for (const [, value] of entries) {
        tripleIds.push(textDecoder.decode(value));
      }

      // 2. Batch fetch all META records
      const datoms = tripleIds.length === 0 ? [] : yield* this.batchFetchMeta(tripleIds);

      // 3. Filter and return
      const results: Datom[] = [];
      for (const datom of datoms) {
        if (datom === null) continue;
        if (!includeRetracted && datom.retractedAt !== null) continue;
        if (!matchesPattern(datom, pattern)) continue;
        results.push(datom);
      }
      for (const datom of yield* this.segmentsAsync(pattern, includeRetracted, options?.basis)) {
        results.push(datom);
      }
      return results;
    });
  }

  /** Synchronous bitemporal scan, when the backend supports it. */
  scanCollectTemporal(pattern: ScanPattern, basis: ResolvedTemporalBasis): Datom[] | null {
    const datoms = this.scanCollect(pattern, { includeRetracted: true, basis });
    return datoms === null ? null : datoms.filter((datom) => visibleAt(datom, basis));
  }

  /** Batched asynchronous bitemporal scan. */
  scanCollectTemporalAsync(
    pattern: ScanPattern,
    basis: ResolvedTemporalBasis,
  ): Effect.Effect<Datom[]> {
    return this.scanCollectAsync(pattern, { includeRetracted: true, basis }).pipe(
      Effect.map((datoms) => datoms.filter((datom) => visibleAt(datom, basis))),
    );
  }

  /**
   * Async version of getByEntityType using batched META fetches.
   * Scans the TYPE index, then batch-fetches all META records in one call.
   */
  getByEntityTypeAsync(entityType: string): Effect.Effect<Datom[]> {
    return this.getByEntityTypeWhereAsync(entityType, (datom) => datom.retractedAt === null);
  }

  /** Async version of getByEntityTypeTemporal using batched META fetches. */
  getByEntityTypeTemporalAsync(
    entityType: string,
    basis: ResolvedTemporalBasis,
  ): Effect.Effect<Datom[]> {
    return this.getByEntityTypeWhereAsync(entityType, (datom) => visibleAt(datom, basis));
  }

  private getByEntityTypeWhereAsync(
    entityType: string,
    keep: (datom: Datom) => boolean,
  ): Effect.Effect<Datom[]> {
    const { start, end } = typePrefixRange(entityType);

    return Effect.gen({ self: this }, function* () {
      const entries = yield* Stream.runCollect(this.kv.getRange({ start, end }));
      const tripleIds: string[] = [];
      for (const [, value] of entries) {
        tripleIds.push(textDecoder.decode(value));
      }

      const datoms = tripleIds.length === 0 ? [] : yield* this.batchFetchMeta(tripleIds);

      const results: Datom[] = [];
      for (const datom of datoms) {
        if (datom === null || !keep(datom)) continue;
        results.push(datom);
      }
      for (const datom of yield* this.segmentsAsync({ entityType }, false)) results.push(datom);
      return results;
    });
  }

  /** Stream facts visible at one bitemporal basis. */
  scanTemporal(pattern: ScanPattern, basis: ResolvedTemporalBasis): Stream.Stream<Datom> {
    return this.kv.getRange({ ...patternToScan(pattern) }).pipe(
      Stream.mapEffect(([_key, value]) => {
        const tripleId = textDecoder.decode(value);
        return this.getById(tripleId);
      }),
      Stream.filter((datom): datom is Datom => datom !== null),
      Stream.filter((datom) => visibleAt(datom, basis)),
      Stream.filter((datom) => matchesPattern(datom, pattern)),
      Stream.concat(
        Stream.fromIterableEffect(
          this.segmentsAsync(pattern, true, basis).pipe(
            Effect.map((datoms) => datoms.filter((datom) => visibleAt(datom, basis))),
          ),
        ),
      ),
    );
  }

  /**
   * Get all active datoms for an entity.
   */
  getEntity(entityId: string): Stream.Stream<Datom> {
    return this.scan({ entity: entityId });
  }

  /**
   * Get full history of an entity (including retracted).
   */
  entityHistory(entityId: string): Stream.Stream<Datom> {
    return this.scan({ entity: entityId }, { includeRetracted: true });
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Check if a datom matches a scan pattern.
 * This is used for post-filtering when the index prefix doesn't cover all pattern components.
 */
const matchesPattern = (datom: Datom, pattern: ScanPattern): boolean => {
  if (pattern.entity !== undefined && datom.entity !== pattern.entity) return false;
  if (pattern.attribute !== undefined && datom.attribute !== pattern.attribute) return false;
  if (pattern.value !== undefined && !valuesEqual(datom.value, pattern.value)) return false;
  return true;
};

const visibleAt = (datom: Datom, basis: ResolvedTemporalBasis): boolean => {
  const recordedVisible =
    basis.recordedPosition !== undefined
      ? datom.recordedPosition <= basis.recordedPosition &&
        (basis.recordedAt === undefined || datom.recordedAt <= basis.recordedAt) &&
        (datom.retractedAt === null ||
          (basis.recordedAt !== undefined && datom.retractedAt > basis.recordedAt) ||
          (datom.retractedPosition !== null && datom.retractedPosition > basis.recordedPosition))
      : basis.recordedAt === undefined
        ? datom.retractedAt === null
        : datom.recordedAt <= basis.recordedAt &&
          (datom.retractedAt === null || datom.retractedAt > basis.recordedAt);
  return (
    recordedVisible &&
    datom.validFrom <= basis.validAt &&
    (datom.validTo === null || datom.validTo > basis.validAt)
  );
};

/**
 * Compare two TripleValues for equality.
 */
const valuesEqual = (a: TripleValue, b: TripleValue): boolean => {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "string":
    case "ref":
    case "blob":
      return a.value === (b as typeof a).value;
    case "number":
    case "datetime":
      return a.value === (b as typeof a).value;
    case "boolean":
      return a.value === (b as typeof a).value;
    case "json":
      return JSON.stringify(a.value) === JSON.stringify((b as typeof a).value);
  }
};

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Create a KvTripleStore instance.
 */
export const createKvTripleStore = (kv: KvBackendService): KvTripleStore => {
  return new KvTripleStore(kv);
};
