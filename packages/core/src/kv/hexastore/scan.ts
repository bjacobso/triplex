/**
 * Pattern-to-scan conversion for the hexastore.
 *
 * Converts domain-level triple patterns into KV range scan parameters
 * by selecting the optimal index and computing prefix bounds.
 */

import type { SealedValue, TripleValue } from "../../Value.js";
import type { TuplePart } from "./tuple.js";
import {
  tString,
  tNumber,
  tBoolean,
  tDatetime,
  tRef,
  tJson,
  tBlob,
  tSealed,
  encodePartStr,
  encodeSealedStr,
  encodeStringStr,
  encodeNumberStr,
  encodeBooleanStr,
  encodeDatetimeStr,
  encodeRefStr,
  encodeBlobStr,
} from "./tuple.js";
import {
  selectIndex,
  prefixRange,
  intervalRange,
  type IntervalRange,
  type IndexChoice,
} from "./indexes.js";

/**
 * A scan pattern with optional bound components.
 * undefined means "any" (variable/wildcard).
 */
export interface ScanPattern {
  readonly intervalRange?: IntervalRange;
  readonly entity?: string;
  readonly attribute?: string;
  readonly value?: TripleValue;
}

/**
 * Index token for a sealed value: its blind token, or a per-value opaque token
 * (which no equality lookup can produce) when the codec has no blind index.
 */
export const sealedIndexToken = (value: SealedValue): string =>
  value.blind === undefined ? `opaque:${value.ciphertext}` : `blind:${value.blind}`;

/**
 * Convert a TripleValue to a TuplePart for index key encoding.
 */
export const valueToTuplePart = (value: TripleValue): TuplePart => {
  switch (value.type) {
    case "string":
      return tString(value.value);
    case "number":
      return tNumber(value.value);
    case "boolean":
      return tBoolean(value.value);
    case "datetime":
      return tDatetime(value.value);
    case "ref":
      return tRef(value.value);
    case "json":
      return tJson(value.value);
    case "blob":
      return tBlob(value.value);
    case "sealed":
      return tSealed(sealedIndexToken(value));
  }
};

/**
 * Convert a TripleValue to a latin1-encoded string for the string fast path.
 * Uses direct encoders to skip TuplePart object allocation.
 */
export const valueToPartStr = (value: TripleValue): string => {
  switch (value.type) {
    case "string":
      return encodeStringStr(value.value);
    case "number":
      return encodeNumberStr(value.value);
    case "boolean":
      return encodeBooleanStr(value.value);
    case "datetime":
      return encodeDatetimeStr(value.value);
    case "ref":
      return encodeRefStr(value.value);
    case "json":
      return encodePartStr(tJson(value.value));
    case "blob":
      return encodeBlobStr(value.value);
    case "sealed":
      return encodeSealedStr(sealedIndexToken(value));
  }
};

/**
 * Convert a scan pattern to index selection + range bounds.
 */
export const patternToScan = (
  pattern: ScanPattern,
): {
  choice: IndexChoice;
  start: Uint8Array;
  end: Uint8Array;
} => {
  const entityPart = pattern.entity !== undefined ? tString(pattern.entity) : undefined;
  const attributePart = pattern.attribute !== undefined ? tString(pattern.attribute) : undefined;
  const valuePart = pattern.value !== undefined ? valueToTuplePart(pattern.value) : undefined;
  const isRef = pattern.value?.type === "ref";

  const choice = selectIndex(
    {
      entity: pattern.entity !== undefined,
      attribute: pattern.attribute !== undefined,
      value: pattern.value !== undefined,
    },
    entityPart,
    attributePart,
    valuePart,
    isRef,
  );

  const { start, end } =
    pattern.attribute !== undefined && pattern.intervalRange !== undefined
      ? intervalRange(pattern.attribute, pattern.intervalRange)
      : prefixRange(choice.index, choice.prefixParts);

  return { choice, start, end };
};
