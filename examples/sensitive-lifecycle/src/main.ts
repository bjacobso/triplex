/**
 * The life of a sensitive value on a SQLite file, with the reference key store.
 *
 * Seal a national identifier and a passport number, restart, open them, rotate
 * the data keys, the blind key and the root key, erase the person, restart
 * again, and show that opening fails, equality no longer matches and the
 * journal records the erasure.
 *
 *   pnpm --filter triplex-sensitive-lifecycle start
 *   pnpm --filter triplex-sensitive-lifecycle test   # the same run, with checks
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { EntityId, Triples, type Triple } from "@triplex-build/triplex";
import { Attribute, EntityType } from "@triplex-build/triplex/config";
import { KeyProvider, RootKey, Sensitive, ValueCodec } from "@triplex-build/triplex/sensitive";
import { SqlKeyStore } from "@triplex-build/triplex/sql";
import { SqliteTriples } from "@triplex-build/triplex/sqlite";

const verify = process.argv.includes("--verify");
const expect = (condition: boolean, message: string) => {
  if (verify && !condition) throw new Error(`Check failed: ${message}`);
};
const log = (line: string) => console.log(line);

// The model: a national identifier kept for seven years, a passport number kept for one.
const NationalId = Attribute.sensitive(Attribute.text(":person/national-id"));
const Passport = Attribute.sensitive(Attribute.text(":person/passport"), {
  keyClass: "retention-1y",
});
const Name = Attribute.text(":person/name");
const Person = EntityType.make("Person", {
  nationalId: NationalId,
  passport: Passport,
  name: Name,
});

const DATABASE = "acme/people";
const ada = EntityId.make("person:ada");

// In a real host the root keys come from a secret manager, never from the database.
const rootKey = (id: string) => ({ id, key: RootKey.generate() });
const rootV1 = rootKey("root-v1");
const rootV2 = rootKey("root-v2");

const directory = mkdtempSync(join(tmpdir(), "triplex-sensitive-"));
const filename = join(directory, "people.db");

/** One process lifetime: the decorated store over the file, with stored keys. */
const session = (root: RootKey.FromBytesOptions) => {
  const store = SqliteTriples.layerWithSqlClient({ filename });
  const rootLayer = Layer.orDie(RootKey.fromBytes(root));
  const keys = SqlKeyStore.layer({ database: DATABASE }).pipe(Layer.provide(rootLayer));
  return Sensitive.layer({ database: DATABASE, attributes: [Person] }).pipe(
    Layer.provide(ValueCodec.aesGcm),
    Layer.provideMerge(keys),
    Layer.provideMerge(rootLayer),
    Layer.provideMerge(store),
  );
};

const valueOf = (facts: readonly Triple[], attribute: string) =>
  facts.find((fact) => fact.attribute === attribute)?.value;

const matches = (attribute: string, value: string) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    return (yield* triples.match({ attribute, value: { type: "string", value } })).map(
      (fact) => fact.entityId,
    );
  });

const program = Effect.gen(function* () {
  log(`Database file: ${filename}`);

  // 1. Seal.
  yield* Effect.gen(function* () {
    const triples = yield* Triples;
    yield* triples.transact(
      [
        {
          op: "assert",
          entityId: ada,
          attribute: ":person/name",
          value: { type: "string", value: "Ada" },
        },
        {
          op: "assert",
          entityId: ada,
          attribute: ":person/national-id",
          value: { type: "string", value: "917-55-4321" },
        },
        {
          op: "assert",
          entityId: ada,
          attribute: ":person/passport",
          value: { type: "string", value: "P1234567" },
        },
      ],
      { actor: "onboarding", commandId: "onboard-ada" },
    );
    const stored = yield* triples.entity(ada);
    const sealed = valueOf(stored, ":person/national-id");
    log(`1. Sealed: national ID is stored as ${sealed?.type}`);
    expect(sealed?.type === "sealed", "the national ID is stored sealed");
  }).pipe(Effect.provide(session({ current: rootV1 })));

  // 2. Restart, open, and look up by value.
  yield* Effect.gen(function* () {
    const triples = yield* Triples;
    const opened = yield* Sensitive.open(yield* triples.entity(ada));
    const nationalId = valueOf(opened, ":person/national-id");
    log(`2. After a restart: opened national ID ${JSON.stringify(nationalId)}`);
    expect(
      JSON.stringify(nationalId).includes("917-55-4321"),
      "the national ID opens after a restart",
    );
    const found = yield* matches(":person/national-id", "917-55-4321");
    log(`   Who has 917-55-4321? ${found.join(", ")}`);
    expect(found.join() === ada, "equality finds Ada");
  }).pipe(Effect.provide(session({ current: rootV1 })));

  // 3. Rotate the data keys and the blind key.
  yield* Effect.gen(function* () {
    const custody = yield* KeyProvider.KeyCustody;
    yield* custody.rotate({ database: DATABASE });
    const rewrap = yield* Sensitive.rewrap;
    yield* custody.retire(DATABASE, rewrap.replacedKeyIds);
    log(
      `3. Data keys rotated: ${rewrap.rewrapped} values and ${rewrap.journalCopies} journal copies resealed, ${rewrap.replacedKeyIds.length} old keys retired`,
    );
    expect(rewrap.rewrapped === 2, "both sealed values are resealed");
    const blind = yield* Sensitive.rotateBlindKey;
    log(`   Blind key rotated: ${blind.recomputed} tokens recomputed`);
    expect(blind.recomputed === 2, "both tokens are recomputed");
    expect(
      (yield* matches(":person/national-id", "917-55-4321")).join() === ada,
      "equality still finds Ada",
    );
  }).pipe(Effect.provide(session({ current: rootV1 })));

  // 4. Rotate the root key: add root-v2 as current, keep root-v1 until everything is rewrapped.
  yield* Effect.gen(function* () {
    const report = yield* SqlKeyStore.rewrapRoot;
    log(
      `4. Root key rotated: ${report.dataKeys} data keys and ${report.blindKeys} blind keys rewrapped, ${report.remaining} left under the old root key`,
    );
    expect(report.remaining === 0, "no key is left under the old root key");
  }).pipe(Effect.provide(session({ current: rootV2, previous: [rootV1] })));

  // 5. Erase Ada, with only the new root key configured.
  yield* Effect.gen(function* () {
    const receipt = yield* Sensitive.erase({
      subject: ada,
      actor: "privacy-officer",
      commandId: "erasure-request-42",
    });
    log(
      `5. Erased ${receipt.subject}: ${receipt.keyIds.length} keys destroyed, ${receipt.scrubbed} tokens removed`,
    );
    expect(receipt.scrubbed === 2, "both tokens are removed");
  }).pipe(Effect.provide(session({ current: rootV2 })));

  // 6. Restart and show what is left.
  yield* Effect.gen(function* () {
    const triples = yield* Triples;
    const facts = yield* triples.entity(ada);
    const failed = yield* Effect.flip(Sensitive.open(facts));
    log(`6. After another restart: opening fails with ${failed.reason}`);
    expect(failed.reason === "key-destroyed", "opening fails with key-destroyed");
    const kept = yield* Sensitive.open(facts, { erased: "keep-sealed" });
    log(
      `   Name still reads ${JSON.stringify(valueOf(kept, ":person/name"))}; the national ID stays ${valueOf(kept, ":person/national-id")?.type}`,
    );
    const found = yield* matches(":person/national-id", "917-55-4321");
    log(`   Who has 917-55-4321? ${found.length === 0 ? "nobody can tell" : found.join(", ")}`);
    expect(found.length === 0, "equality no longer matches");
    const record = yield* triples.transactionByCommand("erasure-request-42");
    const subject = record?.changes.find(
      (change) => change.attribute === Sensitive.ErasureAttributes.SUBJECT,
    );
    log(
      `   Journal: ${record?.actor} erased ${JSON.stringify(subject?.value)} at position ${record?.position}`,
    );
    expect(record?.actor === "privacy-officer", "the journal records who erased");
    expect(
      JSON.stringify(subject?.value).includes("person:ada"),
      "the journal records the subject",
    );
    expect(
      !JSON.stringify(record).includes(":person/national-id"),
      "the record names no attribute",
    );
  }).pipe(Effect.provide(session({ current: rootV2 })));
});

Effect.runPromise(Effect.scoped(program))
  .then(() => {
    if (verify) log("All checks passed.");
  })
  .finally(() => rmSync(directory, { recursive: true, force: true }));
