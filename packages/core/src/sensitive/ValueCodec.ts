/**
 * The pluggable codec that seals, opens and blinds sensitive values.
 *
 * Every sensitive value crosses this service exactly once on its way into
 * storage, and plaintext leaves storage only through `open`. The codec sees
 * the database, entity, attribute, declared value type and key class of every
 * value.
 */

import { Context, Effect, Layer } from "effect";

import * as CanonicalJson from "../content/CanonicalJson.js";
import * as Sha256 from "../content/Sha256.js";
import { SensitiveValueError } from "../errors/index.js";
import type { PlainValue, SealableValueType, SealedValue } from "../Value.js";
import {
  KeyProvider,
  type DataKey,
  type KeyContext,
  type KeyError,
  type KeyProviderService,
} from "./KeyProvider.js";
import { bufferSource, fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./encoding.js";

/** Everything a codec is told about the value it seals or opens. */
export interface SensitiveContext {
  /** Stable logical database identity. Key material and blind tokens never cross it. */
  readonly database: string;
  readonly entityId: string;
  readonly attribute: string;
  readonly valueType: SealableValueType;
  /** The attribute's key class, `KeyProvider.DEFAULT_KEY_CLASS` when it declares none. */
  readonly keyClass: string;
}

/** A codec's output for one value. */
export interface Sealed {
  readonly keyId: string;
  readonly ciphertext: string;
  readonly blind?: string;
}

export interface ValueCodecService {
  /** Diagnostic name. Never stored. */
  readonly name: string;
  /**
   * Which equal plaintexts share a blind token: `database` (any sensitive
   * attribute of one database, so joins across attributes work), `attribute`
   * (only within one attribute), or `none` (no blind index: no equality,
   * joins or uniqueness over sealed values).
   */
  readonly blindScope: "database" | "attribute" | "none";
  readonly seal: (
    context: SensitiveContext,
    value: PlainValue,
  ) => Effect.Effect<Sealed, SensitiveValueError>;
  readonly open: (
    context: SensitiveContext,
    sealed: SealedValue,
  ) => Effect.Effect<PlainValue, SensitiveValueError>;
  /** The keyed equality token for a plaintext, or undefined without a blind index. */
  readonly blind: (
    context: SensitiveContext,
    value: PlainValue,
  ) => Effect.Effect<string | undefined, SensitiveValueError>;
  /**
   * Rotation: reseal a stored value under its scope's current data key, or
   * succeed with `undefined` when it is already sealed under it. Codecs
   * without keys omit it.
   */
  readonly reseal?: (
    context: SensitiveContext,
    sealed: SealedValue,
  ) => Effect.Effect<Sealed | undefined, SensitiveValueError>;
  /**
   * Rotation: the blind token of a plaintext under a given blind key, such as
   * a staged key that is not current yet. Codecs without keys omit it.
   */
  readonly blindWith?: (
    context: SensitiveContext,
    value: PlainValue,
    key: DataKey,
  ) => Effect.Effect<string, SensitiveValueError>;
}

export class ValueCodec extends Context.Service<ValueCodec, ValueCodecService>()(
  "triplex/sensitive/ValueCodec",
) {}

// =============================================================================
// Canonical plaintext
// =============================================================================

const invalid = (context: SensitiveContext, message: string, cause?: unknown) =>
  new SensitiveValueError({
    attribute: context.attribute,
    entityId: context.entityId,
    reason: "invalid-value",
    message: `${context.attribute}: ${message}`,
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * The canonical JSON text of a value's payload. Number and datetime share a
 * representation; the declared type, not the payload, decides how it decodes.
 */
export const canonicalPlaintext = (
  context: SensitiveContext,
  value: PlainValue,
): Effect.Effect<string, SensitiveValueError> => {
  if (value.type !== context.valueType) {
    return Effect.fail(
      invalid(context, `expected a ${context.valueType} value, received ${value.type}`),
    );
  }
  if ((value.type === "number" || value.type === "datetime") && !Number.isFinite(value.value)) {
    return Effect.fail(invalid(context, "sensitive numbers must be finite"));
  }
  return CanonicalJson.encode(value.value as CanonicalJson.CanonicalValue).pipe(
    Effect.mapError((cause) =>
      invalid(context, "the value has no canonical JSON representation", cause),
    ),
  );
};

const decodePlaintext = (
  context: SensitiveContext,
  text: string,
): Effect.Effect<PlainValue, SensitiveValueError> =>
  Effect.try({
    try: (): PlainValue => {
      const parsed = JSON.parse(text) as unknown;
      switch (context.valueType) {
        case "string":
          if (typeof parsed !== "string") throw new TypeError("not a string");
          return { type: "string", value: parsed };
        case "number":
          if (typeof parsed !== "number") throw new TypeError("not a number");
          return { type: "number", value: parsed };
        case "datetime":
          if (typeof parsed !== "number") throw new TypeError("not a datetime");
          return { type: "datetime", value: parsed };
        case "boolean":
          if (typeof parsed !== "boolean") throw new TypeError("not a boolean");
          return { type: "boolean", value: parsed };
        case "json":
          return { type: "json", value: parsed };
      }
    },
    catch: (cause) =>
      new SensitiveValueError({
        attribute: context.attribute,
        entityId: context.entityId,
        reason: "integrity",
        message: `${context.attribute}: opened plaintext does not decode as ${context.valueType}`,
        cause,
      }),
  });

const blindFamily = (valueType: SealableValueType): string =>
  valueType === "datetime" ? "number" : valueType === "string" ? "text" : valueType;

const blindInput = (
  context: SensitiveContext,
  canonical: string,
  scope: "database" | "attribute",
) =>
  [
    "triplex-blind-v1",
    scope === "attribute" ? context.attribute : "",
    blindFamily(context.valueType),
    canonical,
  ].join("\u0000");

// =============================================================================
// Identity codec
// =============================================================================

const IDENTITY_KEY_ID = "identity";

const openIdentity = (context: SensitiveContext, sealed: SealedValue) =>
  Effect.try({
    try: () => fromUtf8(fromBase64Url(sealed.ciphertext)),
    catch: (cause) =>
      new SensitiveValueError({
        attribute: context.attribute,
        entityId: context.entityId,
        reason: "integrity",
        message: `${context.attribute}: identity envelope is malformed`,
        cause,
      }),
  }).pipe(Effect.flatMap((text) => decodePlaintext(context, text)));

/**
 * Development codec: the storage shape and query semantics of encryption,
 * without confidentiality. The "ciphertext" is reversible base64url of the
 * canonical plaintext and the blind token is an unkeyed SHA-256. Switching to
 * `aesGcm` later swaps the codec, not the schema; `aesGcm` can still open
 * identity envelopes until they are rewrapped.
 */
export const identityCodec: ValueCodecService = {
  name: "identity",
  blindScope: "database",
  seal: (context, value) =>
    canonicalPlaintext(context, value).pipe(
      Effect.map((canonical) => ({
        keyId: IDENTITY_KEY_ID,
        ciphertext: toBase64Url(utf8(canonical)),
        blind: `identity:${Sha256.hex(blindInput(context, canonical, "database"))}`,
      })),
    ),
  open: (context, sealed) =>
    sealed.keyId === IDENTITY_KEY_ID
      ? openIdentity(context, sealed)
      : Effect.fail(
          new SensitiveValueError({
            attribute: context.attribute,
            entityId: context.entityId,
            reason: "key-unavailable",
            message: `${context.attribute}: the identity codec cannot open a value sealed with another key`,
          }),
        ),
  blind: (context, value) =>
    canonicalPlaintext(context, value).pipe(
      Effect.map(
        (canonical) => `identity:${Sha256.hex(blindInput(context, canonical, "database"))}`,
      ),
    ),
};

/** Development-only identity codec layer. Not confidential. */
export const identity: Layer.Layer<ValueCodec> = Layer.succeed(ValueCodec, identityCodec);

// =============================================================================
// AES-GCM reference codec
// =============================================================================

const ENVELOPE_VERSION = 2;
const NONCE_BYTES = 12;

export interface AesGcmOptions {
  /**
   * Map a value to the subject that owns its data key. Defaults to the entity
   * ID. Hosts may map related entities (such as a person's documents) to one
   * subject so one erasure shreds them all.
   */
  readonly subjectOf?: (context: SensitiveContext) => string;
  /** Blind tokens shared across attributes (`database`, default) or per attribute. */
  readonly blindScope?: "database" | "attribute";
}

const keyFailure = (context: SensitiveContext, error: KeyError) =>
  new SensitiveValueError({
    attribute: context.attribute,
    entityId: context.entityId,
    reason: error.reason === "destroyed" ? "key-destroyed" : "key-unavailable",
    message:
      error.reason === "destroyed"
        ? `${context.attribute}: the value's data key was destroyed (erased subject)`
        : `${context.attribute}: the value's key is unavailable`,
    cause: error,
  });

const codecFailure = (context: SensitiveContext, message: string, cause: unknown) =>
  new SensitiveValueError({
    attribute: context.attribute,
    entityId: context.entityId,
    reason: "codec",
    message: `${context.attribute}: ${message}`,
    cause,
  });

/**
 * Authenticated data: the value's place (database, entity, attribute, type),
 * its key class and the key ID that sealed it. A ciphertext moved to another
 * fact, or relabelled with another key ID, fails authentication.
 */
const additionalData = (context: SensitiveContext, keyId: string): Uint8Array =>
  utf8(
    JSON.stringify([
      "triplex-sealed-v2",
      context.database,
      context.entityId,
      context.attribute,
      context.valueType,
      context.keyClass,
      keyId,
    ]),
  );

const keyContext = (context: SensitiveContext, subject: string): KeyContext => ({
  database: context.database,
  subject,
  keyClass: context.keyClass,
});

const makeAesGcm = (keys: KeyProviderService, options: AesGcmOptions): ValueCodecService => {
  const subjectOf = options.subjectOf ?? ((context: SensitiveContext) => context.entityId);
  const scope = options.blindScope ?? "database";

  const blindUnder = (context: SensitiveContext, canonical: string, { keyId, key }: DataKey) =>
    Effect.tryPromise({
      try: () =>
        globalThis.crypto.subtle.sign(
          "HMAC",
          key,
          bufferSource(utf8(blindInput(context, canonical, scope))),
        ),
      catch: (cause) => codecFailure(context, "blind-index computation failed", cause),
    }).pipe(Effect.map((mac) => `${keyId}:${toBase64Url(new Uint8Array(mac))}`));

  const blindCanonical = (context: SensitiveContext, canonical: string) =>
    keys.blindKey(context.database).pipe(
      Effect.mapError((error) => keyFailure(context, error)),
      Effect.flatMap((blindKey) => blindUnder(context, canonical, blindKey)),
    );

  const service: ValueCodecService = {
    name: "aes-256-gcm",
    blindScope: scope,
    seal: (context, value) =>
      Effect.gen(function* () {
        const canonical = yield* canonicalPlaintext(context, value);
        const { keyId, key } = yield* keys
          .sealingKey(keyContext(context, subjectOf(context)))
          .pipe(Effect.mapError((error) => keyFailure(context, error)));
        const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
        const encrypted = yield* Effect.tryPromise({
          try: () =>
            globalThis.crypto.subtle.encrypt(
              {
                name: "AES-GCM",
                iv: nonce,
                additionalData: bufferSource(additionalData(context, keyId)),
              },
              key,
              bufferSource(utf8(canonical)),
            ),
          catch: (cause) => codecFailure(context, "encryption failed", cause),
        });
        const envelope = new Uint8Array(1 + NONCE_BYTES + encrypted.byteLength);
        envelope[0] = ENVELOPE_VERSION;
        envelope.set(nonce, 1);
        envelope.set(new Uint8Array(encrypted), 1 + NONCE_BYTES);
        const blind = yield* blindCanonical(context, canonical);
        return { keyId, ciphertext: toBase64Url(envelope), blind };
      }),
    open: (context, sealed) =>
      sealed.keyId === IDENTITY_KEY_ID
        ? openIdentity(context, sealed)
        : Effect.gen(function* () {
            const envelope = yield* Effect.try({
              try: () => fromBase64Url(sealed.ciphertext),
              catch: (cause) => codecFailure(context, "ciphertext is not base64url", cause),
            });
            if (envelope[0] !== ENVELOPE_VERSION || envelope.length <= 1 + NONCE_BYTES) {
              return yield* new SensitiveValueError({
                attribute: context.attribute,
                entityId: context.entityId,
                reason: "integrity",
                message: `${context.attribute}: unsupported or truncated envelope`,
              });
            }
            const key = yield* keys
              .openingKey(keyContext(context, subjectOf(context)), sealed.keyId)
              .pipe(Effect.mapError((error) => keyFailure(context, error)));
            const plaintext = yield* Effect.tryPromise({
              try: () =>
                globalThis.crypto.subtle.decrypt(
                  {
                    name: "AES-GCM",
                    iv: bufferSource(envelope.subarray(1, 1 + NONCE_BYTES)),
                    additionalData: bufferSource(additionalData(context, sealed.keyId)),
                  },
                  key,
                  bufferSource(envelope.subarray(1 + NONCE_BYTES)),
                ),
              catch: (cause) =>
                new SensitiveValueError({
                  attribute: context.attribute,
                  entityId: context.entityId,
                  reason: "integrity",
                  message: `${context.attribute}: authentication failed; the value was altered or moved`,
                  cause,
                }),
            });
            return yield* decodePlaintext(context, fromUtf8(new Uint8Array(plaintext)));
          }),
    blind: (context, value) =>
      canonicalPlaintext(context, value).pipe(
        Effect.flatMap((canonical) => blindCanonical(context, canonical)),
      ),
  };

  return {
    ...service,
    reseal: (context, sealed) =>
      Effect.gen(function* () {
        const { keyId } = yield* keys
          .sealingKey(keyContext(context, subjectOf(context)))
          .pipe(Effect.mapError((error) => keyFailure(context, error)));
        if (keyId === sealed.keyId) return undefined;
        const plain = yield* service.open(context, sealed);
        return yield* service.seal(context, plain);
      }),
    blindWith: (context, value, key) =>
      canonicalPlaintext(context, value).pipe(
        Effect.flatMap((canonical) => blindUnder(context, canonical, key)),
      ),
  };
};

/**
 * Reference AES-256-GCM codec over WebCrypto. Each value gets a fresh 96-bit
 * nonce; the additional authenticated data binds database, entity, attribute,
 * declared type, key class and key ID. Blind tokens are HMAC-SHA-256 under the database blind
 * key. Requires a `KeyProvider`.
 */
export const aesGcmWith = (
  options: AesGcmOptions = {},
): Layer.Layer<ValueCodec, never, KeyProvider> =>
  Layer.effect(
    ValueCodec,
    Effect.gen(function* () {
      return makeAesGcm(yield* KeyProvider, options);
    }),
  );

/** `aesGcmWith()` with per-entity subjects and database-scoped blind tokens. */
export const aesGcm: Layer.Layer<ValueCodec, never, KeyProvider> = aesGcmWith();
