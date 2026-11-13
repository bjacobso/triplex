/**
 * Shared conformance for erasure (crypto-shredding with a blind-token scrub).
 *
 * Runs against `erasureConformanceLayer(raw, keys)`: a backend's raw `Triples`
 * decorated with the fixture policy and the reference AES-GCM codec, plus a
 * key provider with custody. Pins the contract `Sensitive.erase` promises:
 * destroyed keys, no equality on any erased fact (current or retracted),
 * presence kept, other subjects and key classes untouched, refused new seals,
 * a journaled erasure record and idempotent resumption.
 */

import { Effect, Exit, Layer } from "effect";
import {
  ConstraintViolationError,
  EntityId,
  Triples,
  type SealedValue,
  type Triple,
} from "@triplex-internal/core";
import { Attribute, EntityType, GraphConstraint } from "@triplex-internal/core/config";
import { KeyProvider, Sensitive, Sensitivity, ValueCodec } from "@triplex-internal/core/sensitive";

class ErasureConformanceError extends Error {
  override readonly name = "ErasureConformanceError";
}

const check = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new ErasureConformanceError(message));

export const ERASURE_CONFORMANCE_DATABASE = "triplex-conformance/erasure";

export const ErasureFixture = (() => {
  const ssn = Attribute.sensitive(Attribute.text(":er-person/ssn"));
  const passport = Attribute.sensitive(Attribute.text(":er-person/passport"), {
    keyClass: "retention-1y",
  });
  const name = Attribute.text(":er-person/name");
  const person = EntityType.make("ErPerson", { ssn, passport, name });
  return { ssn, passport, name, person } as const;
})();

/** Decorate raw `Triples` with the erasure fixture policy and the given keys. */
export const erasureConformanceLayer = <E, R, E2 = never, R2 = never>(
  raw: Layer.Layer<Triples, E, R>,
  keys: Layer.Layer<KeyProvider.KeyProvider | KeyProvider.KeyCustody, E2, R2> = KeyProvider.test({
    seed: "triplex-erasure-conformance",
  }) as never,
): Layer.Layer<Triples | Sensitivity | KeyProvider.KeyCustody, E | E2, R | R2> =>
  Sensitive.layer({
    database: ERASURE_CONFORMANCE_DATABASE,
    attributes: [ErasureFixture.person],
  }).pipe(Layer.provide(ValueCodec.aesGcm), Layer.provideMerge(keys), Layer.provide(raw));

export interface ErasureCase {
  readonly name: string;
  readonly run: Effect.Effect<void, unknown, Triples | Sensitivity | KeyProvider.KeyCustody>;
}

const eid = EntityId.make;
const text = (value: string) => ({ type: "string" as const, value });

const matching = (attribute: string, value: string) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    return (yield* triples.match({ attribute, value: text(value) })).map((t) => t.entityId);
  });

const reasonOf = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isSuccess(exit) ? "ok" : JSON.stringify(exit.cause);

export const erasureCases: readonly ErasureCase[] = [
  {
    name: "erases a subject: no equality on current or past facts, presence and history kept",
    run: Effect.gen(function* () {
      const triples = yield* Triples;
      const ada = eid("er:ada");
      const bob = eid("er:bob");
      const { triples: written } = yield* triples.transact([
        { op: "assert", entityId: ada, attribute: ":er-person/ssn", value: text("111-11-1111") },
        { op: "assert", entityId: ada, attribute: ":er-person/passport", value: text("P-ADA") },
        { op: "assert", entityId: ada, attribute: ":er-person/name", value: text("Ada") },
        { op: "assert", entityId: bob, attribute: ":er-person/ssn", value: text("222-22-2222") },
      ]);
      // A corrected SSN leaves the old value in history.
      yield* triples.transact([
        { op: "retract", id: written[0]!.id },
        { op: "assert", entityId: ada, attribute: ":er-person/ssn", value: text("333-33-3333") },
      ]);
      yield* check(
        (yield* matching(":er-person/ssn", "333-33-3333")).join() === ada,
        "equality matches before erasure",
      );
      const historyBefore = yield* triples.history(ada);

      const receipt = yield* Sensitive.erase({
        subject: ada,
        actor: "dpo@example.test",
        commandId: "erase-ada",
      });
      yield* check(receipt.keyIds.length >= 2, "both key classes' keys are destroyed");
      yield* check(receipt.scrubbed >= 3, `every sealed fact lost its token (${receipt.scrubbed})`);
      yield* check(receipt.keyClass === "*", "a whole-subject erasure records every key class");

      const history = yield* triples.history(ada);
      yield* check(history.length === historyBefore.length, "history keeps every fact");
      for (const fact of history) {
        if (fact.value.type !== "sealed") continue;
        yield* check(
          (fact.value as SealedValue).blind === undefined,
          `${fact.attribute} (${fact.id}) keeps no blind token`,
        );
      }
      yield* check(
        (yield* matching(":er-person/ssn", "333-33-3333")).length === 0 &&
          (yield* matching(":er-person/ssn", "111-11-1111")).length === 0 &&
          (yield* matching(":er-person/passport", "P-ADA")).length === 0,
        "no erased value, current or past, can be confirmed by equality",
      );
      const presence = (yield* triples.queryAll({
        find: ["?e"],
        where: [["?e", ":er-person/ssn", "?any"]],
      })).results.map((row) => row["?e"]);
      yield* check(
        presence.includes(ada) && presence.includes(bob),
        "presence still matches erased facts",
      );
      const live = yield* triples.entity(ada);
      const opened = yield* Effect.exit(Sensitive.open(live));
      yield* check(reasonOf(opened).includes("key-destroyed"), "opening fails with key-destroyed");
      const kept = yield* Sensitive.open(live, { erased: "keep-sealed" });
      yield* check(
        kept.find((t: Triple) => t.attribute === ":er-person/name")?.value.type === "string" &&
          kept.find((t: Triple) => t.attribute === ":er-person/ssn")?.value.type === "sealed",
        "keep-sealed leaves erased values sealed and plain values readable",
      );
      const refused = yield* Effect.exit(
        triples.assert({ entityId: ada, attribute: ":er-person/ssn", value: text("444-44-4444") }),
      );
      yield* check(reasonOf(refused).includes("key-destroyed"), "new seals for the subject fail");

      yield* check(
        (yield* matching(":er-person/ssn", "222-22-2222")).join() === bob,
        "another subject still matches",
      );
      const bobOpened = yield* Sensitive.open(yield* triples.entity(bob));
      yield* check(
        JSON.stringify(bobOpened).includes("222-22-2222"),
        "another subject still opens",
      );

      const record = receipt.transaction;
      yield* check(record.actor === "dpo@example.test", "the erasure records its actor");
      yield* check(record.commandId === "erase-ada", "the erasure records its command");
      const recorded = JSON.stringify(record);
      yield* check(
        recorded.includes(":triplex/erasure-subject") &&
          !recorded.includes(":er-person/") &&
          !recorded.includes("333-33-3333"),
        "the erasure record names the subject and no attribute or value",
      );

      const again = yield* Sensitive.erase({
        subject: ada,
        actor: "dpo@example.test",
        commandId: "erase-ada",
      });
      yield* check(
        again.transaction.txId === record.txId && again.scrubbed === 0,
        "repeating the command resumes without recording twice",
      );
    }),
  },
  {
    name: "erases one key class of a subject and keeps its others",
    run: Effect.gen(function* () {
      const triples = yield* Triples;
      const cy = eid("er:cy");
      yield* triples.transact([
        { op: "assert", entityId: cy, attribute: ":er-person/ssn", value: text("555-55-5555") },
        { op: "assert", entityId: cy, attribute: ":er-person/passport", value: text("P-CY") },
      ]);
      const receipt = yield* Sensitive.erase({
        subject: cy,
        keyClass: "retention-1y",
        actor: "retention-job",
        commandId: "erase-cy-passports",
      });
      yield* check(receipt.keyClass === "retention-1y", "the record names the key class");
      yield* check(
        receipt.scrubbed === 1,
        `only the passport lost its token (${receipt.scrubbed})`,
      );
      yield* check(
        (yield* matching(":er-person/passport", "P-CY")).length === 0,
        "the erased class no longer matches",
      );
      yield* check(
        (yield* matching(":er-person/ssn", "555-55-5555")).join() === cy,
        "the kept class still matches",
      );
      const opened = yield* Sensitive.open(yield* triples.entity(cy), { erased: "keep-sealed" });
      yield* check(
        opened.find((t: Triple) => t.attribute === ":er-person/ssn")?.value.type === "string" &&
          opened.find((t: Triple) => t.attribute === ":er-person/passport")?.value.type ===
            "sealed",
        "the kept class opens and the erased class stays sealed",
      );
    }),
  },
  {
    name: "makes an erased holder's unique value reusable",
    run: Effect.gen(function* () {
      const triples = yield* Triples;
      const constraints = [GraphConstraint.unique("ErPerson", ":er-person/ssn").rule];
      const assertSsn = (entity: string) =>
        triples.transact(
          [
            {
              op: "assert",
              entityId: eid(entity),
              attribute: ":er-person/ssn",
              value: text("777-77-7777"),
              entityType: "ErPerson",
            },
          ],
          { enforce: { constraints } },
        );
      yield* assertSsn("er:dee");
      const duplicate = yield* assertSsn("er:eve").pipe(Effect.flip);
      yield* check(
        duplicate instanceof ConstraintViolationError,
        "a second holder violates uniqueness before erasure",
      );
      yield* Sensitive.erase({ subject: "er:dee", actor: "dpo", commandId: "erase-dee" });
      yield* assertSsn("er:eve");
    }),
  },
];

/** Run every erasure case against one store. */
export const makeErasureSuite = (): Effect.Effect<
  void,
  unknown,
  Triples | Sensitivity | KeyProvider.KeyCustody
> => Effect.forEach(erasureCases, (c) => c.run, { discard: true });
