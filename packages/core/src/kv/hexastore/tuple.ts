/**
 * Tuple encoding for lexicographically sortable KV keys.
 *
 * Encodes typed values into byte arrays that sort correctly when compared
 * byte-by-byte. This is the core encoding used by the hexastore indexes.
 *
 * Encoding scheme follows FoundationDB's tuple layer conventions:
 * - Type tag (1 byte) determines the encoding
 * - Values are encoded to preserve lexicographic sort order
 * - Null-byte escaping allows variable-length strings without length prefixes
 */

import { concat } from "../kv/encoding.js";

// ─── Type Tags ─────────────────────────────────────────────────────────────
// Ordered so that types sort in this order: null < boolean < number < string < ref < datetime < json < blob

/** Null sentinel -- sorts before all real values. */
export const TAG_NULL = 0x00;

/** Boolean values: false sorts before true. */
export const TAG_BOOLEAN = 0x01;

/** IEEE 754 double with sign-flip for correct sort order. */
export const TAG_NUMBER = 0x02;

/** UTF-8 string with null-byte escaping. */
export const TAG_STRING = 0x03;

/** Reference (entity ID) -- same encoding as string but distinct type. */
export const TAG_REF = 0x04;

/** Epoch milliseconds as int64 big-endian. */
export const TAG_DATETIME = 0x05;

/** JSON -- length-prefixed, not sortable by content. */
export const TAG_JSON = 0x06;

/** Blob hash -- SHA-256 bytes. */
export const TAG_BLOB = 0x07;

/** Max sentinel -- sorts after all real values. Used as upper bound. */
export const TAG_MAX = 0xff;

// ─── Part types ────────────────────────────────────────────────────────────

export type TuplePart =
  | { readonly type: "null" }
  | { readonly type: "boolean"; readonly value: boolean }
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "ref"; readonly value: string }
  | { readonly type: "datetime"; readonly value: number }
  | { readonly type: "json"; readonly value: unknown }
  | { readonly type: "blob"; readonly value: string }
  | { readonly type: "max" };

// Convenience constructors
export const tNull = (): TuplePart => ({ type: "null" });
export const tBoolean = (value: boolean): TuplePart => ({ type: "boolean", value });
export const tNumber = (value: number): TuplePart => ({ type: "number", value });
export const tString = (value: string): TuplePart => ({ type: "string", value });
export const tRef = (value: string): TuplePart => ({ type: "ref", value });
export const tDatetime = (value: number): TuplePart => ({ type: "datetime", value });
export const tJson = (value: unknown): TuplePart => ({ type: "json", value });
export const tBlob = (value: string): TuplePart => ({ type: "blob", value });
export const tMax = (): TuplePart => ({ type: "max" });

// ─── Encoding ──────────────────────────────────────────────────────────────

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encode a string with null-byte escaping.
 *
 * 0x00 in the input is escaped to [0x00, 0xFF].
 * The string is terminated with [0x00, 0x00].
 * This allows correct lexicographic ordering and unambiguous boundaries.
 */
const encodeString = (s: string): Uint8Array => {
  const bytes = textEncoder.encode(s);
  // Count null bytes for allocation
  let nullCount = 0;
  for (const b of bytes) {
    if (b === 0x00) nullCount++;
  }
  // Allocate: original bytes + escape bytes + 2-byte terminator
  const result = new Uint8Array(bytes.length + nullCount + 2);
  let j = 0;
  for (const b of bytes) {
    if (b === 0x00) {
      result[j++] = 0x00;
      result[j++] = 0xff;
    } else {
      result[j++] = b;
    }
  }
  // Null terminator
  result[j++] = 0x00;
  result[j] = 0x00;
  return result;
};

/**
 * Decode a null-byte-escaped string from a buffer at a given offset.
 * Returns [decoded string, bytes consumed (including terminator)].
 */
const decodeString = (bytes: Uint8Array, offset: number): [string, number] => {
  const parts: number[] = [];
  let i = offset;
  while (i < bytes.length) {
    if (bytes[i] === 0x00) {
      if (i + 1 < bytes.length && bytes[i + 1] === 0xff) {
        // Escaped null byte
        parts.push(0x00);
        i += 2;
      } else {
        // Terminator [0x00, 0x00]
        i += 2;
        break;
      }
    } else {
      parts.push(bytes[i]!);
      i += 1;
    }
  }
  return [textDecoder.decode(new Uint8Array(parts)), i - offset];
};

/**
 * Encode a float64 for lexicographic sort order.
 *
 * IEEE 754 doubles: positive values sort correctly in big-endian.
 * For negative values, flip ALL bits. For positive, flip only the sign bit.
 * This gives correct total ordering: -Inf < ... < -0 < +0 < ... < +Inf.
 */
const encodeNumber = (n: number): Uint8Array => {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, n, false); // big-endian
  const bytes = new Uint8Array(buf);
  if (n < 0 || Object.is(n, -0)) {
    // Negative: flip all bits
    for (let i = 0; i < 8; i++) bytes[i] = ~bytes[i]! & 0xff;
  } else {
    // Positive (including +0, NaN, +Inf): flip sign bit
    bytes[0] = bytes[0]! ^ 0x80;
  }
  return bytes;
};

/**
 * Decode a float64 from sign-flip encoding.
 */
const decodeNumber = (bytes: Uint8Array, offset: number): number => {
  const buf = new Uint8Array(8);
  buf.set(bytes.slice(offset, offset + 8));
  // Check if originally negative (sign bit was flipped)
  if ((buf[0]! & 0x80) === 0) {
    // Was negative: flip all bits back
    for (let i = 0; i < 8; i++) buf[i] = ~buf[i]! & 0xff;
  } else {
    // Was positive: flip sign bit back
    buf[0] = buf[0]! ^ 0x80;
  }
  return new DataView(buf.buffer).getFloat64(0, false);
};

/**
 * Encode a single tuple part to bytes.
 */
const encodePart = (part: TuplePart): Uint8Array => {
  switch (part.type) {
    case "null":
      return new Uint8Array([TAG_NULL]);

    case "boolean":
      return new Uint8Array([TAG_BOOLEAN, part.value ? 0x01 : 0x00]);

    case "number":
      return concat(new Uint8Array([TAG_NUMBER]), encodeNumber(part.value));

    case "string":
      return concat(new Uint8Array([TAG_STRING]), encodeString(part.value));

    case "ref":
      return concat(new Uint8Array([TAG_REF]), encodeString(part.value));

    case "datetime": {
      // Encode as int64 big-endian (epoch millis)
      const buf = new ArrayBuffer(8);
      new DataView(buf).setBigInt64(0, BigInt(Math.floor(part.value)), false);
      return concat(new Uint8Array([TAG_DATETIME]), new Uint8Array(buf));
    }

    case "json": {
      const str = JSON.stringify(part.value);
      const strBytes = textEncoder.encode(str);
      // Length-prefixed: 4 bytes big-endian length + content
      const lenBuf = new ArrayBuffer(4);
      new DataView(lenBuf).setUint32(0, strBytes.length, false);
      return concat(new Uint8Array([TAG_JSON]), new Uint8Array(lenBuf), strBytes);
    }

    case "blob":
      // Store the hex hash as raw bytes (hash is a fixed string)
      return concat(new Uint8Array([TAG_BLOB]), encodeString(part.value));

    case "max":
      return new Uint8Array([TAG_MAX]);
  }
};

/**
 * Decode a single tuple part from bytes at the given offset.
 * Returns [decoded part, bytes consumed].
 */
const decodePart = (bytes: Uint8Array, offset: number): [TuplePart, number] => {
  const tag = bytes[offset]!;

  switch (tag) {
    case TAG_NULL:
      return [{ type: "null" }, 1];

    case TAG_BOOLEAN:
      return [{ type: "boolean", value: bytes[offset + 1]! !== 0 }, 2];

    case TAG_NUMBER:
      return [{ type: "number", value: decodeNumber(bytes, offset + 1) }, 9];

    case TAG_STRING: {
      const [str, consumed] = decodeString(bytes, offset + 1);
      return [{ type: "string", value: str }, 1 + consumed];
    }

    case TAG_REF: {
      const [str, consumed] = decodeString(bytes, offset + 1);
      return [{ type: "ref", value: str }, 1 + consumed];
    }

    case TAG_DATETIME: {
      const val = Number(
        new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 8).getBigInt64(0, false),
      );
      return [{ type: "datetime", value: val }, 9];
    }

    case TAG_JSON: {
      const len = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, false);
      const str = textDecoder.decode(bytes.slice(offset + 5, offset + 5 + len));
      return [{ type: "json", value: JSON.parse(str) as unknown }, 5 + len];
    }

    case TAG_BLOB: {
      const [str, consumed] = decodeString(bytes, offset + 1);
      return [{ type: "blob", value: str }, 1 + consumed];
    }

    case TAG_MAX:
      return [{ type: "max" }, 1];

    default:
      throw new Error(`Unknown tuple tag: 0x${tag.toString(16)}`);
  }
};

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Encode a tuple of parts into a single byte array.
 * The resulting bytes sort lexicographically according to the tuple's element order.
 */
export const encodeTuple = (...parts: readonly TuplePart[]): Uint8Array => {
  const encoded = parts.map(encodePart);
  return concat(...encoded);
};

/**
 * Decode a byte array back into a tuple of parts.
 */
export const decodeTuple = (bytes: Uint8Array): TuplePart[] => {
  const parts: TuplePart[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const [part, consumed] = decodePart(bytes, offset);
    parts.push(part);
    offset += consumed;
  }
  return parts;
};

// ─── Latin1 String Fast Path ───────────────────────────────────────────────
//
// The InMemoryKvBackend stores keys as latin1 strings (each byte maps 1:1 to
// a char code). These functions produce latin1 strings directly, completely
// bypassing Uint8Array allocation. This eliminates ~90 short-lived objects
// per triple during bulk insertion.
//
// IMPORTANT: These strings are NOT human-readable. They contain arbitrary
// byte values encoded as char codes. They are only meaningful as Map keys
// in the InMemoryKvBackend.

/**
 * Encode a string value with null-byte escaping, returning a latin1 string.
 * Mirror of `encodeString` but produces a string instead of Uint8Array.
 */
const encodeStringToStr = (s: string): string => {
  // Entity IDs, attributes and triple IDs are almost always ASCII without NUL,
  // which encode as themselves: check once, then append the terminator.
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0 || code >= 0x80) return encodeStringToStrSlow(s);
  }
  // Null terminator [0x00, 0x00]
  return s + "\x00\x00";
};

/**
 * Slow path for non-ASCII strings: use TextEncoder for UTF-8, then convert.
 */
const encodeStringToStrSlow = (s: string): string => {
  const bytes = textEncoder.encode(s);
  let result = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x00) {
      result += "\x00\xff";
    } else {
      result += String.fromCharCode(b);
    }
  }
  return result + "\x00\x00";
};

/**
 * Encode a single tuple part to a latin1 string.
 * Mirror of `encodePart` but produces a string directly.
 */
export const encodePartStr = (part: TuplePart): string => {
  switch (part.type) {
    case "null":
      return String.fromCharCode(TAG_NULL);

    case "boolean":
      return String.fromCharCode(TAG_BOOLEAN) + String.fromCharCode(part.value ? 0x01 : 0x00);

    case "number":
      return encodeNumberStr(part.value);

    case "string":
      return encodeStringStr(part.value);

    case "ref":
      return encodeRefStr(part.value);

    case "datetime":
      return encodeDatetimeStr(part.value);

    case "json": {
      const str = JSON.stringify(part.value);
      const strBytes = textEncoder.encode(str);
      const lenBuf = new ArrayBuffer(4);
      new DataView(lenBuf).setUint32(0, strBytes.length, false);
      const lenBytes = new Uint8Array(lenBuf);
      let s = String.fromCharCode(TAG_JSON);
      for (let i = 0; i < 4; i++) s += String.fromCharCode(lenBytes[i]!);
      for (let i = 0; i < strBytes.length; i++) s += String.fromCharCode(strBytes[i]!);
      return s;
    }

    case "blob":
      return String.fromCharCode(TAG_BLOB) + encodeStringToStr(part.value);

    case "max":
      return String.fromCharCode(TAG_MAX);
  }
};

// ─── Direct String Encoders (skip TuplePart allocation) ───────────────────
//
// These encode directly from a JS value to a latin1 string, bypassing the
// intermediate TuplePart object. In assertBatchStr, this eliminates ~4-7
// object allocations per triple (one per tString/tRef/tNumber call).

/** TAG_STRING char, pre-computed. */
const TAG_STRING_CHR = String.fromCharCode(TAG_STRING);
/** TAG_REF char, pre-computed. */
const TAG_REF_CHR = String.fromCharCode(TAG_REF);
/** TAG_NUMBER char, pre-computed. */
const TAG_NUMBER_CHR = String.fromCharCode(TAG_NUMBER);
/** TAG_DATETIME char, pre-computed. */
const TAG_DATETIME_CHR = String.fromCharCode(TAG_DATETIME);
/** TAG_BOOLEAN char, pre-computed. */
const TAG_BOOLEAN_CHR = String.fromCharCode(TAG_BOOLEAN);
/** TAG_BLOB char, pre-computed. */
const TAG_BLOB_CHR = String.fromCharCode(TAG_BLOB);

/**
 * Encode a string value directly to latin1 (TAG_STRING + null-escaped content).
 * Equivalent to `encodePartStr(tString(s))` but allocates zero intermediate objects.
 */
export const encodeStringStr = (s: string): string => TAG_STRING_CHR + encodeStringToStr(s);

/**
 * Encode a ref value directly to latin1 (TAG_REF + null-escaped content).
 * Equivalent to `encodePartStr(tRef(s))` but allocates zero intermediate objects.
 */
export const encodeRefStr = (s: string): string => TAG_REF_CHR + encodeStringToStr(s);

// Reusable ArrayBuffer + DataView for number/datetime encoding (avoids per-call allocation)
const _numBuf = new ArrayBuffer(8);
const _numDV = new DataView(_numBuf);
const _numBytes = new Uint8Array(_numBuf);

/**
 * Encode a number value directly to latin1 (TAG_NUMBER + sign-flipped IEEE 754).
 * Equivalent to `encodePartStr(tNumber(n))` but allocates zero intermediate objects.
 */
export const encodeNumberStr = (n: number): string => {
  _numDV.setFloat64(0, n, false); // big-endian
  if (n < 0 || Object.is(n, -0)) {
    // Negative: flip all bits
    for (let i = 0; i < 8; i++) _numBytes[i] = ~_numBytes[i]! & 0xff;
  } else {
    // Positive (including +0, NaN, +Inf): flip sign bit
    _numBytes[0] = _numBytes[0]! ^ 0x80;
  }
  return (
    TAG_NUMBER_CHR +
    String.fromCharCode(
      _numBytes[0]!,
      _numBytes[1]!,
      _numBytes[2]!,
      _numBytes[3]!,
      _numBytes[4]!,
      _numBytes[5]!,
      _numBytes[6]!,
      _numBytes[7]!,
    )
  );
};

/**
 * Encode a datetime value directly to latin1 (TAG_DATETIME + int64 big-endian).
 * Equivalent to `encodePartStr(tDatetime(n))` but allocates zero intermediate objects.
 */
export const encodeDatetimeStr = (n: number): string => {
  _numDV.setBigInt64(0, BigInt(Math.floor(n)), false);
  return (
    TAG_DATETIME_CHR +
    String.fromCharCode(
      _numBytes[0]!,
      _numBytes[1]!,
      _numBytes[2]!,
      _numBytes[3]!,
      _numBytes[4]!,
      _numBytes[5]!,
      _numBytes[6]!,
      _numBytes[7]!,
    )
  );
};

/**
 * Encode a boolean value directly to latin1 (TAG_BOOLEAN + 0x00/0x01).
 * Equivalent to `encodePartStr(tBoolean(b))` but allocates zero intermediate objects.
 */
export const encodeBooleanStr = (b: boolean): string =>
  TAG_BOOLEAN_CHR + String.fromCharCode(b ? 0x01 : 0x00);

/**
 * Encode a blob value directly to latin1 (TAG_BLOB + null-escaped content).
 * Equivalent to `encodePartStr(tBlob(s))` but allocates zero intermediate objects.
 */
export const encodeBlobStr = (s: string): string => TAG_BLOB_CHR + encodeStringToStr(s);
