/**
 * Shared conformance for key stores: any `KeyProvider` with `KeyCustody`.
 *
 * The cases pin the contract erasure and rotation rely on: one current data
 * key per subject and key class, opening by key ID, destruction that refuses
 * both opening and new seals and reports every destroyed key ID, rotation that
 * keeps older versions openable, and a stable blind key.
 */

import { Effect } from "effect";
import { KeyProvider } from "@triplex-internal/core/sensitive";

class KeyStoreConformanceError extends Error {
  override readonly name = "KeyStoreConformanceError";
}

const check = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new KeyStoreConformanceError(message));

export const KEY_STORE_CONFORMANCE_DATABASE = "triplex-conformance/keys";

export interface KeyStoreCase {
  readonly name: string;
  readonly run: Effect.Effect<void, unknown, KeyProvider.KeyProvider | KeyProvider.KeyCustody>;
}

const context = (subject: string, keyClass = KeyProvider.DEFAULT_KEY_CLASS) => ({
  database: KEY_STORE_CONFORMANCE_DATABASE,
  subject,
  keyClass,
});

const nonce = new Uint8Array(12);
const message = new TextEncoder().encode("triplex key store conformance");

const encrypt = (key: CryptoKey) =>
  Effect.promise(() =>
    globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, message),
  );

const decrypts = (key: CryptoKey, ciphertext: ArrayBuffer) =>
  Effect.promise(() =>
    globalThis.crypto.subtle
      .decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext)
      .then((plain) => new TextDecoder().decode(plain) === "triplex key store conformance")
      .catch(() => false),
  );

const reason = <A>(effect: Effect.Effect<A, KeyProvider.KeyError>) =>
  effect.pipe(
    Effect.match({ onFailure: (error) => error.reason as string, onSuccess: () => "ok" }),
  );

export const keyStoreCases: readonly KeyStoreCase[] = [
  {
    name: "one current data key per subject and key class, opened by its key ID",
    run: Effect.gen(function* () {
      const keys = yield* KeyProvider.KeyProvider;
      const a = yield* keys.sealingKey(context("subject:a"));
      const again = yield* keys.sealingKey(context("subject:a"));
      const b = yield* keys.sealingKey(context("subject:b"));
      const classed = yield* keys.sealingKey(context("subject:a", "retention-1y"));
      yield* check(a.keyId === again.keyId, "a scope's sealing key is stable");
      yield* check(
        new Set([a.keyId, b.keyId, classed.keyId]).size === 3,
        "subjects and key classes have distinct keys",
      );
      yield* check(!a.keyId.includes("subject:a"), "a key ID does not name its subject");
      const sealed = yield* encrypt(a.key);
      const opening = yield* keys.openingKey(context("subject:a"), a.keyId);
      yield* check(
        yield* decrypts(opening, sealed),
        "the opening key decrypts the sealing key's output",
      );
      yield* check(
        !(yield* decrypts(b.key, sealed)) && !(yield* decrypts(classed.key, sealed)),
        "another subject's or key class's key does not decrypt",
      );
      yield* check(
        (yield* reason(keys.openingKey(context("subject:a"), "no-such-key"))) === "unavailable",
        "an unknown key ID is unavailable",
      );
    }),
  },
  {
    name: "rotation makes a new version current and keeps older versions openable",
    run: Effect.gen(function* () {
      const keys = yield* KeyProvider.KeyProvider;
      const custody = yield* KeyProvider.KeyCustody;
      const before = yield* keys.sealingKey(context("subject:rotate"));
      const other = yield* keys.sealingKey(context("subject:rotate-other"));
      const sealed = yield* encrypt(before.key);
      yield* custody.rotate({
        database: KEY_STORE_CONFORMANCE_DATABASE,
        subject: "subject:rotate",
      });
      const after = yield* keys.sealingKey(context("subject:rotate"));
      yield* check(after.keyId !== before.keyId, "a rotated subject seals under a new key");
      yield* check(
        (yield* keys.sealingKey(context("subject:rotate-other"))).keyId === other.keyId,
        "rotating one subject leaves another's key current",
      );
      const old = yield* keys.openingKey(context("subject:rotate"), before.keyId);
      yield* check(yield* decrypts(old, sealed), "the older version still opens");
      yield* custody.rotate({ database: KEY_STORE_CONFORMANCE_DATABASE });
      yield* check(
        (yield* keys.sealingKey(context("subject:rotate-other"))).keyId !== other.keyId,
        "rotating the database rotates every subject",
      );
    }),
  },
  {
    name: "destroying a key class refuses opening and new seals and reports every version",
    run: Effect.gen(function* () {
      const keys = yield* KeyProvider.KeyProvider;
      const custody = yield* KeyProvider.KeyCustody;
      const subject = "subject:erase-class";
      const v1 = yield* keys.sealingKey(context(subject, "retention-1y"));
      yield* custody.rotate({
        database: KEY_STORE_CONFORMANCE_DATABASE,
        subject,
        keyClass: "retention-1y",
      });
      const v2 = yield* keys.sealingKey(context(subject, "retention-1y"));
      const kept = yield* keys.sealingKey(context(subject));
      const keptSealed = yield* encrypt(kept.key);
      const scope = { database: KEY_STORE_CONFORMANCE_DATABASE, subject, keyClass: "retention-1y" };
      const destroyed = yield* custody.destroy(scope);
      yield* check(
        [...destroyed].sort().join() === [v1.keyId, v2.keyId].sort().join(),
        `destroy reports both versions (received ${destroyed.join(", ")})`,
      );
      yield* check(
        (yield* reason(keys.openingKey(context(subject, "retention-1y"), v1.keyId))) ===
          "destroyed" &&
          (yield* reason(keys.openingKey(context(subject, "retention-1y"), v2.keyId))) ===
            "destroyed",
        "destroyed versions do not open",
      );
      yield* check(
        (yield* reason(keys.sealingKey(context(subject, "retention-1y")))) === "destroyed",
        "a destroyed key class seals nothing new",
      );
      const stillKept = yield* keys.openingKey(context(subject), kept.keyId);
      yield* check(
        yield* decrypts(stillKept, keptSealed),
        "the subject's other key class still opens",
      );
      const again = yield* custody.destroy(scope);
      yield* check(
        [...again].sort().join() === [...destroyed].sort().join(),
        "destroying again succeeds and reports the same key IDs",
      );
    }),
  },
  {
    name: "destroying a subject destroys every key class and no other subject",
    run: Effect.gen(function* () {
      const keys = yield* KeyProvider.KeyProvider;
      const custody = yield* KeyProvider.KeyCustody;
      const subject = "subject:erase-all";
      const plain = yield* keys.sealingKey(context(subject));
      const classed = yield* keys.sealingKey(context(subject, "retention-7y"));
      const bystander = yield* keys.sealingKey(context("subject:bystander"));
      const destroyed = yield* custody.destroy({
        database: KEY_STORE_CONFORMANCE_DATABASE,
        subject,
      });
      yield* check(
        [...destroyed].sort().join() === [plain.keyId, classed.keyId].sort().join(),
        `destroy reports every key class (received ${destroyed.join(", ")})`,
      );
      yield* check(
        (yield* reason(keys.sealingKey(context(subject)))) === "destroyed" &&
          (yield* reason(keys.sealingKey(context(subject, "retention-7y")))) === "destroyed",
        "no key class of an erased subject seals anything new",
      );
      yield* check(
        (yield* keys.sealingKey(context("subject:bystander"))).keyId === bystander.keyId,
        "another subject is untouched",
      );
    }),
  },
  {
    name: "retires old versions but never a current key",
    run: Effect.gen(function* () {
      const keys = yield* KeyProvider.KeyProvider;
      const custody = yield* KeyProvider.KeyCustody;
      const subject = "subject:retire";
      const old = yield* keys.sealingKey(context(subject));
      yield* custody.rotate({ database: KEY_STORE_CONFORMANCE_DATABASE, subject });
      const current = yield* keys.sealingKey(context(subject));
      yield* check(
        (yield* reason(custody.retire(KEY_STORE_CONFORMANCE_DATABASE, [current.keyId]))) ===
          "unavailable",
        "a current key cannot be retired",
      );
      yield* custody.retire(KEY_STORE_CONFORMANCE_DATABASE, [old.keyId]);
      yield* check(
        (yield* reason(keys.openingKey(context(subject), old.keyId))) === "destroyed",
        "a retired key no longer opens",
      );
      yield* check(
        (yield* keys.sealingKey(context(subject))).keyId === current.keyId,
        "the scope still seals under its current key",
      );
    }),
  },
  {
    name: "stages a blind key without making it current until activated",
    run: Effect.gen(function* () {
      const keys = yield* KeyProvider.KeyProvider;
      const custody = yield* KeyProvider.KeyCustody;
      const database = KEY_STORE_CONFORMANCE_DATABASE;
      const before = yield* keys.blindKey(database);
      const staged = yield* custody.stageBlindKey(database);
      yield* check(staged.keyId !== before.keyId, "the staged key is new");
      yield* check(
        (yield* custody.stageBlindKey(database)).keyId === staged.keyId,
        "staging again returns the same key",
      );
      yield* check(
        (yield* keys.blindKey(database)).keyId === before.keyId,
        "the staged key is not current",
      );
      yield* check(
        (yield* reason(custody.activateBlindKey(database, before.keyId))) === "unavailable",
        "only the staged key can be activated",
      );
      yield* custody.activateBlindKey(database, staged.keyId);
      yield* check(
        (yield* keys.blindKey(database)).keyId === staged.keyId,
        "the activated key is current",
      );
    }),
  },
  {
    name: "one stable blind key per database",
    run: Effect.gen(function* () {
      const keys = yield* KeyProvider.KeyProvider;
      const first = yield* keys.blindKey(KEY_STORE_CONFORMANCE_DATABASE);
      const second = yield* keys.blindKey(KEY_STORE_CONFORMANCE_DATABASE);
      yield* check(first.keyId === second.keyId, "the blind key is stable");
      yield* check(!first.keyId.includes(":"), "a blind key ID contains no colon");
    }),
  },
];

/** Run every key store case against one provider and custody. */
export const makeKeyStoreSuite = (): Effect.Effect<
  void,
  unknown,
  KeyProvider.KeyProvider | KeyProvider.KeyCustody
> => Effect.forEach(keyStoreCases, (c) => c.run, { discard: true });
