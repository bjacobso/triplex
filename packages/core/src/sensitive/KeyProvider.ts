/**
 * Key material for the reference AES-GCM codec.
 *
 * Triplex never persists keys. A host implements `KeyProvider` over its KMS;
 * `testKeys` is a deterministic in-memory provider for tests only.
 */

import { Context, Data, Effect, Layer } from "effect";

import * as Sha256 from "../content/Sha256.js";
import { bufferSource, fromHex } from "./encoding.js";

/** The subject owns a data key; destroying it crypto-shreds the subject's values. */
export interface KeyContext {
  readonly database: string;
  readonly subject: string;
}

export interface DataKey {
  /** Stored with every ciphertext. Must not contain sensitive data. */
  readonly keyId: string;
  /** An AES-GCM key (data keys) or an HMAC-SHA-256 key (blind keys). */
  readonly key: CryptoKey;
}

export class KeyError extends Data.TaggedError("SensitiveKeyError")<{
  readonly reason: "unavailable" | "destroyed";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface KeyProviderService {
  /** The current data key used to seal new values for a subject. */
  readonly sealingKey: (context: KeyContext) => Effect.Effect<DataKey, KeyError>;
  /** The data key named by a stored ciphertext's key ID. */
  readonly openingKey: (context: KeyContext, keyId: string) => Effect.Effect<CryptoKey, KeyError>;
  /** The database-wide HMAC key for blind-index tokens. */
  readonly blindKey: (database: string) => Effect.Effect<DataKey, KeyError>;
}

export class KeyProvider extends Context.Service<KeyProvider, KeyProviderService>()(
  "triplex/sensitive/KeyProvider",
) {}

export interface TestKeysOptions {
  /** Deterministic seed. Test keys are derived from it and are not secret. */
  readonly seed: string;
}

/** A deterministic, in-memory key provider with erasure and rotation controls. */
export interface TestKeys {
  readonly provider: KeyProviderService;
  readonly layer: Layer.Layer<KeyProvider>;
  /** Destroy a subject's data keys (crypto-shredding). Its values can no longer be opened. */
  readonly destroy: (context: KeyContext) => void;
  /** Seal new values under a new data-key version; older versions still open. */
  readonly rotate: () => void;
  /** Current data-key version. */
  readonly version: () => number;
}

const subjectKey = (context: KeyContext): string => `${context.database}\u0000${context.subject}`;

const derive = (seed: string, ...parts: readonly string[]): Uint8Array =>
  fromHex(Sha256.hex(["triplex-test-key-v1", seed, ...parts].join("\u0000")));

const importKey = (raw: Uint8Array, usage: "aes" | "hmac"): Effect.Effect<CryptoKey, KeyError> =>
  Effect.tryPromise({
    try: () =>
      usage === "aes"
        ? globalThis.crypto.subtle.importKey("raw", bufferSource(raw), "AES-GCM", false, [
            "encrypt",
            "decrypt",
          ])
        : globalThis.crypto.subtle.importKey(
            "raw",
            bufferSource(raw),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
          ),
    catch: (cause) =>
      new KeyError({ reason: "unavailable", message: "Test key import failed", cause }),
  });

const TEST_KEY_ID = /^test:v([1-9][0-9]*)$/;

/**
 * Test keys only. Data keys are derived per (database, subject, version) and
 * the blind key per database from a public seed, so anyone with the seed can
 * open every value. Never use this provider for real data.
 */
export const testKeys = (options: TestKeysOptions): TestKeys => {
  let current = 1;
  const destroyed = new Set<string>();
  const cache = new Map<string, CryptoKey>();

  const cached = (
    id: string,
    raw: () => Uint8Array,
    usage: "aes" | "hmac",
  ): Effect.Effect<CryptoKey, KeyError> =>
    Effect.suspend(() => {
      const hit = cache.get(id);
      return hit
        ? Effect.succeed(hit)
        : importKey(raw(), usage).pipe(Effect.tap((key) => Effect.sync(() => cache.set(id, key))));
    });

  const dataKey = (context: KeyContext, version: number): Effect.Effect<CryptoKey, KeyError> =>
    destroyed.has(subjectKey(context))
      ? Effect.fail(
          new KeyError({ reason: "destroyed", message: "The subject's data key was destroyed" }),
        )
      : cached(
          `data\u0000${subjectKey(context)}\u0000${version}`,
          () => derive(options.seed, "data", context.database, context.subject, String(version)),
          "aes",
        );

  const provider: KeyProviderService = {
    sealingKey: (context) =>
      Effect.suspend(() => {
        const version = current;
        return dataKey(context, version).pipe(
          Effect.map((key) => ({ keyId: `test:v${version}`, key })),
        );
      }),
    openingKey: (context, keyId) => {
      const match = TEST_KEY_ID.exec(keyId);
      return match
        ? dataKey(context, Number(match[1]))
        : Effect.fail(new KeyError({ reason: "unavailable", message: "Unknown test key ID" }));
    },
    blindKey: (database) =>
      cached(`blind\u0000${database}`, () => derive(options.seed, "blind", database), "hmac").pipe(
        Effect.map((key) => ({ keyId: "test-blind:v1", key })),
      ),
  };

  return {
    provider,
    layer: Layer.succeed(KeyProvider, provider),
    destroy: (context) => {
      destroyed.add(subjectKey(context));
    },
    rotate: () => {
      current += 1;
    },
    version: () => current,
  };
};

/** A test-only key provider layer. See `testKeys`. */
export const test = (options: TestKeysOptions): Layer.Layer<KeyProvider> => testKeys(options).layer;
