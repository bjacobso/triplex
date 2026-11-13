/**
 * The root key that wraps stored data keys (envelope encryption).
 *
 * A key store that keeps data keys in the database stores them only wrapped
 * under a root key. The host supplies the root key; it is never written to the
 * database. Wrapping protects a database or backup that leaks without the root
 * key, and protects nothing if the root key is stored beside the database.
 */

import { Context, Effect, Layer, Redacted } from "effect";

import { KeyError } from "./KeyProvider.js";
import { bufferSource, fromBase64Url, toBase64Url, utf8 } from "./encoding.js";

export interface Wrapped {
  /** The root key that wrapped the key. Not secret. */
  readonly rootKeyId: string;
  /** base64url envelope: version byte, nonce, ciphertext and tag. */
  readonly wrapped: string;
}

export interface RootKeyService {
  /** The root key new keys are wrapped under. */
  readonly currentId: string;
  /**
   * Wrap raw key bytes. `label` names the stored key (such as its key ID) and
   * is authenticated, so a wrapped key cannot be moved to another row.
   */
  readonly wrap: (raw: Uint8Array, label: string) => Effect.Effect<Wrapped, KeyError>;
  /** Unwrap key bytes wrapped by `wrap` under the current or a previous root key. */
  readonly unwrap: (wrapped: Wrapped, label: string) => Effect.Effect<Uint8Array, KeyError>;
}

export class RootKey extends Context.Service<RootKey, RootKeyService>()(
  "triplex/sensitive/RootKey",
) {}

export interface RootKeyMaterial {
  /** A stable, non-secret name for this root key, such as `root-2026-11`. */
  readonly id: string;
  /** 32 random bytes. Keep them outside the database. */
  readonly key: Redacted.Redacted<Uint8Array>;
}

export interface FromBytesOptions {
  /** New keys are wrapped under this root key. */
  readonly current: RootKeyMaterial;
  /**
   * Earlier root keys that may still unwrap stored keys until they are
   * rewrapped under `current`. Remove one once nothing is wrapped under it.
   */
  readonly previous?: ReadonlyArray<RootKeyMaterial>;
}

const VERSION = 1;
const NONCE_BYTES = 12;
const ROOT_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

const unavailable = (message: string, cause?: unknown) =>
  new KeyError({ reason: "unavailable", message, ...(cause === undefined ? {} : { cause }) });

const additionalData = (rootKeyId: string, label: string): Uint8Array<ArrayBuffer> =>
  bufferSource(utf8(JSON.stringify(["triplex-wrapped-key-v1", rootKeyId, label])));

const importRoot = (material: RootKeyMaterial): Effect.Effect<CryptoKey, KeyError> => {
  if (!ROOT_KEY_ID.test(material.id)) {
    return Effect.fail(unavailable(`Root key ID ${material.id} is not a short plain name`));
  }
  const raw = Redacted.value(material.key);
  if (raw.length !== 32) {
    return Effect.fail(unavailable(`Root key ${material.id} must be 32 bytes`));
  }
  return Effect.tryPromise({
    try: () =>
      globalThis.crypto.subtle.importKey("raw", bufferSource(raw), "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]),
    catch: (cause) => unavailable(`Root key ${material.id} could not be imported`, cause),
  });
};

/**
 * A root key held in process memory as raw bytes, for example read from a
 * secret manager at startup. Wraps with AES-256-GCM. To rotate, pass the new
 * key as `current` and the old one in `previous`, then rewrap the stored keys.
 */
export const fromBytes = (options: FromBytesOptions): Layer.Layer<RootKey, KeyError> =>
  Layer.effect(
    RootKey,
    Effect.gen(function* () {
      const materials = [options.current, ...(options.previous ?? [])];
      const ids = new Set(materials.map((material) => material.id));
      if (ids.size !== materials.length) {
        return yield* unavailable("Root key IDs must be distinct");
      }
      const keys = new Map<string, CryptoKey>();
      for (const material of materials) keys.set(material.id, yield* importRoot(material));
      const currentId = options.current.id;
      const current = keys.get(currentId)!;

      return {
        currentId,
        wrap: (raw, label) =>
          Effect.gen(function* () {
            const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
            const encrypted = yield* Effect.tryPromise({
              try: () =>
                globalThis.crypto.subtle.encrypt(
                  { name: "AES-GCM", iv: nonce, additionalData: additionalData(currentId, label) },
                  current,
                  bufferSource(raw),
                ),
              catch: (cause) => unavailable("Wrapping a key failed", cause),
            });
            const envelope = new Uint8Array(1 + NONCE_BYTES + encrypted.byteLength);
            envelope[0] = VERSION;
            envelope.set(nonce, 1);
            envelope.set(new Uint8Array(encrypted), 1 + NONCE_BYTES);
            return { rootKeyId: currentId, wrapped: toBase64Url(envelope) };
          }),
        unwrap: ({ rootKeyId, wrapped }, label) =>
          Effect.gen(function* () {
            const root = keys.get(rootKeyId);
            if (root === undefined) {
              return yield* unavailable(`Root key ${rootKeyId} is not configured`);
            }
            const envelope = yield* Effect.try({
              try: () => fromBase64Url(wrapped),
              catch: (cause) => unavailable("Wrapped key is not base64url", cause),
            });
            if (envelope[0] !== VERSION || envelope.length <= 1 + NONCE_BYTES) {
              return yield* unavailable("Unsupported or truncated wrapped key");
            }
            const raw = yield* Effect.tryPromise({
              try: () =>
                globalThis.crypto.subtle.decrypt(
                  {
                    name: "AES-GCM",
                    iv: bufferSource(envelope.subarray(1, 1 + NONCE_BYTES)),
                    additionalData: additionalData(rootKeyId, label),
                  },
                  root,
                  bufferSource(envelope.subarray(1 + NONCE_BYTES)),
                ),
              catch: (cause) =>
                unavailable("Unwrapping failed; the wrapped key was altered or moved", cause),
            });
            return new Uint8Array(raw);
          }),
      };
    }),
  );

/** 32 random bytes for a new root key. Store them outside the database. */
export const generate = (): Redacted.Redacted<Uint8Array> =>
  Redacted.make(globalThis.crypto.getRandomValues(new Uint8Array(32)));
