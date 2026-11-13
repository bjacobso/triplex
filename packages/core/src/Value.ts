import { Schema } from "effect";
import { EntityId } from "./Branded.js";

export const ValueType = Schema.Literals([
  "string",
  "number",
  "boolean",
  "datetime",
  "ref",
  "json",
  "blob",
  "sealed",
]);
export type ValueType = typeof ValueType.Type;

/** Plaintext value types that may be declared sensitive and sealed at rest. */
export const SealableValueType = Schema.Literals([
  "string",
  "number",
  "boolean",
  "datetime",
  "json",
]);
export type SealableValueType = typeof SealableValueType.Type;

export const StringValue = Schema.Struct({ type: Schema.Literal("string"), value: Schema.String });
export type StringValue = typeof StringValue.Type;

export const NumberValue = Schema.Struct({ type: Schema.Literal("number"), value: Schema.Number });
export type NumberValue = typeof NumberValue.Type;

export const BooleanValue = Schema.Struct({
  type: Schema.Literal("boolean"),
  value: Schema.Boolean,
});
export type BooleanValue = typeof BooleanValue.Type;

export const DateTimeValue = Schema.Struct({
  type: Schema.Literal("datetime"),
  value: Schema.Number,
});
export type DateTimeValue = typeof DateTimeValue.Type;

export const RefValue = Schema.Struct({ type: Schema.Literal("ref"), value: EntityId });
export type RefValue = typeof RefValue.Type;

export const JsonValue = Schema.Struct({ type: Schema.Literal("json"), value: Schema.Unknown });
export type JsonValue = typeof JsonValue.Type;

export const BlobValue = Schema.Struct({
  type: Schema.Literal("blob"),
  value: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
  filename: Schema.optional(Schema.String),
});
export type BlobValue = typeof BlobValue.Type;

/**
 * A sensitive value sealed by a `ValueCodec` before it reached storage.
 *
 * The plaintext is never stored. `ciphertext` is the codec-owned envelope and
 * `blind` is an optional keyed equality token used by blind-index lookups,
 * joins and uniqueness. Both are base64url text. Open a sealed value only
 * through `Sensitive.open` from `@triplex-build/triplex/sensitive`.
 */
export const SealedValue = Schema.Struct({
  type: Schema.Literal("sealed"),
  valueType: SealableValueType,
  keyId: Schema.String,
  ciphertext: Schema.String,
  blind: Schema.optional(Schema.String),
});
export type SealedValue = typeof SealedValue.Type;

export const TripleValue = Schema.Union([
  StringValue,
  NumberValue,
  BooleanValue,
  DateTimeValue,
  RefValue,
  JsonValue,
  BlobValue,
  SealedValue,
]);
export type TripleValue = typeof TripleValue.Type;

/** A value that is not sealed. */
export type PlainValue = Exclude<TripleValue, SealedValue>;

export const isSealed = (value: TripleValue): value is SealedValue => value.type === "sealed";

/**
 * A value as it may be copied out of the fact it belongs to: a sealed value
 * keeps its envelope but drops its blind token. Blind tokens live only on the
 * fact (and its index), so erasing a subject scrubs them in one place.
 */
export const withoutBlind = <V extends TripleValue>(value: V): V => {
  if (value.type !== "sealed" || value.blind === undefined) return value;
  const { blind: _blind, ...rest } = value;
  return rest as V;
};

export const string = (value: string): StringValue => ({ type: "string", value });
export const number = (value: number): NumberValue => ({ type: "number", value });
export const boolean = (value: boolean): BooleanValue => ({ type: "boolean", value });
export const datetime = (value: number | Date): DateTimeValue => ({
  type: "datetime",
  value: typeof value === "number" ? value : value.getTime(),
});
export const ref = (entityId: EntityId): RefValue => ({ type: "ref", value: entityId });
export const json = (value: unknown): JsonValue => ({ type: "json", value });
export const blob = (
  hash: string,
  mimeType: string,
  size: number,
  filename?: string,
): BlobValue => ({
  type: "blob",
  value: hash,
  mimeType,
  size,
  ...(filename !== undefined && { filename }),
});

/**
 * Storage encoding for the `value_sealed` column (and KV META payloads): the
 * codec envelope and its metadata, without the blind token, which is stored
 * separately so it can be indexed.
 */
export const encodeSealedEnvelope = (value: SealedValue): string =>
  JSON.stringify({ valueType: value.valueType, keyId: value.keyId, ciphertext: value.ciphertext });

/** Decode a `value_sealed` column (and optional `value_blind`) into a sealed value. */
export const decodeSealedEnvelope = (
  envelope: string,
  blind: string | null | undefined,
): SealedValue => {
  const parsed = JSON.parse(envelope) as {
    readonly valueType: SealableValueType;
    readonly keyId: string;
    readonly ciphertext: string;
  };
  return {
    type: "sealed",
    valueType: parsed.valueType,
    keyId: parsed.keyId,
    ciphertext: parsed.ciphertext,
    ...(blind === null || blind === undefined ? {} : { blind }),
  };
};

/**
 * Internal Datalog binding for a sealed value. Engines bind sealed values to
 * this token so equal blind tokens join, while no stored plaintext can equal
 * it (stored strings are UTF-8 and cannot contain a lone surrogate). Engines
 * never project it: a sealed binding projects as `null`.
 */
export const SEALED_BINDING_PREFIX = "\uDFFFsealed:";

/** Datalog binding for a sealed value, or a per-fact opaque token when unblinded. */
export const sealedBinding = (value: SealedValue): string =>
  value.blind === undefined
    ? `${SEALED_BINDING_PREFIX}opaque:${value.ciphertext}`
    : `${SEALED_BINDING_PREFIX}${value.blind}`;

export const isSealedBinding = (value: unknown): boolean =>
  typeof value === "string" && value.startsWith(SEALED_BINDING_PREFIX);
