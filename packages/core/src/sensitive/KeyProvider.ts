/**
 * Key material for the reference AES-GCM codec.
 *
 * `KeyProvider` supplies keys to seal, open and blind values. `KeyCustody`
 * changes their lifecycle: destroying a subject's keys (erasure) and making a
 * new key version current (rotation). A host implements both over its key
 * service. `testKeys` is a deterministic in-memory provider for tests only.
 */

import { Context, Data, Effect, Layer } from "effect";

import * as Sha256 from "../content/Sha256.js";
import { bufferSource, fromHex } from "./encoding.js";

/** The key class of sensitive attributes declared without one. */
export const DEFAULT_KEY_CLASS = "default";

/**
 * Which data key seals a value: one per subject and key class. Destroying a
 * subject's keys crypto-shreds its values; destroying one key class leaves the
 * subject's other classes readable.
 */
export interface KeyContext {
  readonly database: string;
  readonly subject: string;
  /** `DEFAULT_KEY_CLASS` for attributes declared without a key class. */
  readonly keyClass: string;
}

export interface DataKey {
  /**
   * Stored with every ciphertext and bound into its authenticated data. It
   * must identify the key on its own, so a value opens under the key that
   * sealed it even if the host later maps values to subjects differently. It
   * must not contain sensitive data.
   */
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
  /**
   * The current data key used to seal new values for a subject and key class.
   * Fails with `destroyed` once that scope was erased.
   */
  readonly sealingKey: (context: KeyContext) => Effect.Effect<DataKey, KeyError>;
  /**
   * The data key named by a stored ciphertext's key ID. The key ID decides the
   * key; `context` describes the value being opened, and a provider may reject
   * a key ID that does not belong to it.
   */
  readonly openingKey: (context: KeyContext, keyId: string) => Effect.Effect<CryptoKey, KeyError>;
  /** The database-wide HMAC key for blind-index tokens. */
  readonly blindKey: (database: string) => Effect.Effect<DataKey, KeyError>;
}

export class KeyProvider extends Context.Service<KeyProvider, KeyProviderService>()(
  "triplex/sensitive/KeyProvider",
) {}

/**
 * The data keys an erasure or rotation applies to: one subject, or every
 * subject of the database for rotation, and one key class or all of them.
 */
export interface KeyScope {
  readonly database: string;
  readonly subject: string;
  /** One key class; omit for every key class of the subject. */
  readonly keyClass?: string;
}

export interface RotationScope {
  readonly database: string;
  /** Omit to rotate every subject of the database. */
  readonly subject?: string;
  /** Omit to rotate every key class. */
  readonly keyClass?: string;
}

export interface KeyCustodyService {
  /**
   * Destroy every version of the scope's data keys. Values sealed under them
   * can no longer be opened, and new seals for the scope fail with
   * `destroyed`. Returns the key IDs destroyed, so the caller can find the
   * values sealed under them. Destroying an already destroyed scope succeeds
   * and returns the same key IDs.
   */
  readonly destroy: (scope: KeyScope) => Effect.Effect<ReadonlyArray<string>, KeyError>;
  /**
   * Make a new data-key version current for new seals in the scope. Values
   * sealed under earlier versions still open.
   */
  readonly rotate: (scope: RotationScope) => Effect.Effect<void, KeyError>;
}

export class KeyCustody extends Context.Service<KeyCustody, KeyCustodyService>()(
  "triplex/sensitive/KeyCustody",
) {}

export interface TestKeysOptions {
  /** Deterministic seed. Test keys are derived from it and are not secret. */
  readonly seed: string;
}

/** A deterministic, in-memory key provider and custody. */
export interface TestKeys {
  readonly provider: KeyProviderService;
  readonly custody: KeyCustodyService;
  /** Provides `KeyProvider` and `KeyCustody`. */
  readonly layer: Layer.Layer<KeyProvider | KeyCustody>;
}

const scopeKey = (context: KeyContext): string =>
  [context.database, context.subject, context.keyClass].join("\u0000");

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

/** `test:<scope digest>:v<version>`: names the key without naming the subject. */
const TEST_KEY_ID = /^test:([0-9a-f]{16}):v([1-9][0-9]*)$/;

const scopeDigest = (context: KeyContext): string =>
  Sha256.hex(["triplex-test-key-scope-v1", scopeKey(context)].join("\u0000")).slice(0, 16);

const destroyedError = () =>
  new KeyError({ reason: "destroyed", message: "The data key was destroyed (erased subject)" });

/**
 * Test keys only. Data keys are derived per (database, subject, key class,
 * version) and the blind key per database from a public seed, so anyone with
 * the seed can open every value. Never use this provider for real data.
 */
export const testKeys = (options: TestKeysOptions): TestKeys => {
  // Rotation epochs: per database, and per scope on top of it.
  const databaseEpoch = new Map<string, number>();
  const scopeEpoch = new Map<string, number>();
  // Every scope that has sealed a value, so whole-subject scopes can be expanded.
  const known = new Map<string, KeyContext>();
  const destroyed = new Set<string>();
  const cache = new Map<string, CryptoKey>();

  const versionOf = (context: KeyContext): number =>
    1 + (databaseEpoch.get(context.database) ?? 0) + (scopeEpoch.get(scopeKey(context)) ?? 0);

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
    destroyed.has(scopeKey(context))
      ? Effect.fail(destroyedError())
      : cached(
          `data\u0000${scopeKey(context)}\u0000${version}`,
          () =>
            derive(
              options.seed,
              "data",
              context.database,
              context.subject,
              context.keyClass,
              String(version),
            ),
          "aes",
        );

  const matching = (scope: KeyScope): ReadonlyArray<KeyContext> =>
    scope.keyClass === undefined
      ? [...known.values()].filter(
          (context) => context.database === scope.database && context.subject === scope.subject,
        )
      : [{ database: scope.database, subject: scope.subject, keyClass: scope.keyClass }];

  const provider: KeyProviderService = {
    sealingKey: (context) =>
      Effect.suspend(() => {
        known.set(scopeKey(context), context);
        const version = versionOf(context);
        return dataKey(context, version).pipe(
          Effect.map((key) => ({ keyId: `test:${scopeDigest(context)}:v${version}`, key })),
        );
      }),
    openingKey: (context, keyId) => {
      const match = TEST_KEY_ID.exec(keyId);
      return match && match[1] === scopeDigest(context)
        ? dataKey(context, Number(match[2]))
        : Effect.fail(
            new KeyError({ reason: "unavailable", message: "Unknown test key ID for this value" }),
          );
    },
    blindKey: (database) =>
      cached(`blind\u0000${database}`, () => derive(options.seed, "blind", database), "hmac").pipe(
        Effect.map((key) => ({ keyId: "test-blind:v1", key })),
      ),
  };

  const custody: KeyCustodyService = {
    destroy: (scope) =>
      Effect.sync(() =>
        matching(scope).flatMap((context) => {
          destroyed.add(scopeKey(context));
          const digest = scopeDigest(context);
          return Array.from(
            { length: versionOf(context) },
            (_, index) => `test:${digest}:v${index + 1}`,
          );
        }),
      ),
    rotate: (scope) =>
      Effect.sync(() => {
        if (scope.subject === undefined) {
          databaseEpoch.set(scope.database, (databaseEpoch.get(scope.database) ?? 0) + 1);
          return;
        }
        const contexts =
          scope.keyClass === undefined
            ? matching({ database: scope.database, subject: scope.subject })
            : [{ database: scope.database, subject: scope.subject, keyClass: scope.keyClass }];
        for (const context of contexts) {
          const key = scopeKey(context);
          scopeEpoch.set(key, (scopeEpoch.get(key) ?? 0) + 1);
        }
      }),
  };

  return {
    provider,
    custody,
    layer: Layer.mergeAll(Layer.succeed(KeyProvider, provider), Layer.succeed(KeyCustody, custody)),
  };
};

/** A test-only key provider and custody layer. See `testKeys`. */
export const test = (options: TestKeysOptions): Layer.Layer<KeyProvider | KeyCustody> =>
  testKeys(options).layer;
