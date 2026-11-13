/**
 * Shared conformance for key rotation: data-key rewrap and blind-key rotation.
 *
 * Runs against `erasureConformanceLayer(raw, keys)` (the same fixture policy).
 * Pins what `Sensitive.rewrap` and `Sensitive.rotateBlindKey` promise: every
 * stored value, current or retracted, and its journal copies move to the
 * current key, old key versions can then be retired and everything still
 * opens; equality, joins and uniqueness survive a blind-key rotation; erased
 * values stay erased.
 */

import { Effect } from "effect";
import {
  ConstraintViolationError,
  EntityId,
  Triples,
  type SealedValue,
} from "@triplex-internal/core";
import { GraphConstraint } from "@triplex-internal/core/config";
import { KeyProvider, Sensitive, Sensitivity } from "@triplex-internal/core/sensitive";

import { ERASURE_CONFORMANCE_DATABASE } from "./erasure.js";

class RotationConformanceError extends Error {
  override readonly name = "RotationConformanceError";
}

const check = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new RotationConformanceError(message));

export interface RotationCase {
  readonly name: string;
  readonly run: Effect.Effect<void, unknown, Triples | Sensitivity | KeyProvider.KeyCustody>;
}

const eid = EntityId.make;
const text = (value: string) => ({ type: "string" as const, value });

const sealedOf = (facts: ReadonlyArray<{ readonly value: unknown }>) =>
  facts.map((fact) => fact.value as SealedValue).filter((value) => value.type === "sealed");

export const rotationCases: readonly RotationCase[] = [
  {
    name: "rewraps current and past values and their journal copies, then retires old keys",
    run: Effect.gen(function* () {
      const triples = yield* Triples;
      const custody = yield* KeyProvider.KeyCustody;
      const kim = eid("rt:kim");
      const first = yield* triples.assert({
        entityId: kim,
        attribute: ":er-person/ssn",
        value: text("121-21-2121"),
      });
      const correction = yield* triples.transact([
        { op: "retract", id: first.id },
        { op: "assert", entityId: kim, attribute: ":er-person/ssn", value: text("131-31-3131") },
      ]);
      const oldKeyId = (first.value as SealedValue).keyId;

      yield* custody.rotate({ database: ERASURE_CONFORMANCE_DATABASE, subject: kim });
      const report = yield* Sensitive.rewrap;
      yield* check(
        report.rewrapped >= 2,
        `current and past values rewrapped (${report.rewrapped})`,
      );
      yield* check(report.journalCopies >= 3, `journal copies rewrapped (${report.journalCopies})`);
      yield* check(report.replacedKeyIds.includes(oldKeyId), "the old key is reported replaced");

      const history = yield* triples.history(kim);
      const keyIds = new Set(sealedOf(history).map((value) => value.keyId));
      yield* check(keyIds.size === 1 && !keyIds.has(oldKeyId), "every value uses the new key");

      yield* custody.retire(ERASURE_CONFORMANCE_DATABASE, report.replacedKeyIds);
      const opened = yield* Sensitive.open(history);
      yield* check(
        JSON.stringify(opened).includes("121-21-2121") &&
          JSON.stringify(opened).includes("131-31-3131"),
        "history opens after the old key is retired",
      );
      const record = yield* triples.transaction(correction.txId);
      const journal = yield* Sensitive.open(record!);
      yield* check(
        JSON.stringify(journal).includes("121-21-2121"),
        "the journal's copies open after the old key is retired",
      );
      yield* check(
        (yield* triples.match({ attribute: ":er-person/ssn", value: text("131-31-3131") }))
          .map((fact) => fact.entityId)
          .join() === kim,
        "equality still matches after rewrap",
      );
      const again = yield* Sensitive.rewrap;
      yield* check(again.rewrapped === 0, "rewrapping again finds nothing to do");
    }),
  },
  {
    name: "rotates the blind key and keeps equality, joins and uniqueness",
    run: Effect.gen(function* () {
      const triples = yield* Triples;
      const constraints = [GraphConstraint.unique("ErPerson", ":er-person/ssn").rule];
      const assertSsn = (entity: string, value: string, attribute = ":er-person/ssn") =>
        triples.transact(
          [
            {
              op: "assert",
              entityId: eid(entity),
              attribute,
              value: text(value),
              entityType: "ErPerson",
            },
          ],
          { enforce: { constraints } },
        );
      yield* assertSsn("rt:lou", "141-41-4141");
      yield* assertSsn("rt:lou", "P-SHARED", ":er-person/passport");
      yield* assertSsn("rt:max", "P-SHARED", ":er-person/passport");
      const before = sealedOf(yield* triples.entity(eid("rt:lou")))[0]!.blind!;

      const report = yield* Sensitive.rotateBlindKey;
      yield* check(report.recomputed >= 3, `tokens recomputed (${report.recomputed})`);
      const after = sealedOf(yield* triples.entity(eid("rt:lou")));
      yield* check(
        after.every((value) => value.blind?.startsWith(`${report.keyId}:`) === true),
        "every token uses the new blind key",
      );
      yield* check(after[0]!.blind !== before, "the token changed");
      yield* check(
        (yield* triples.match({ attribute: ":er-person/ssn", value: text("141-41-4141") }))
          .map((fact) => fact.entityId)
          .join() === "rt:lou",
        "equality matches under the new key",
      );
      const joined = (yield* triples.queryAll({
        find: ["?a", "?b"],
        where: [
          ["?a", ":er-person/passport", "?p"],
          ["?b", ":er-person/passport", "?p"],
          ["!=", "?a", "?b"],
        ],
      })).results;
      yield* check(joined.length === 2, `joins still match (${joined.length})`);
      const duplicate = yield* assertSsn("rt:ned", "141-41-4141").pipe(Effect.flip);
      yield* check(
        duplicate instanceof ConstraintViolationError,
        "uniqueness still detects a duplicate",
      );
    }),
  },
  {
    name: "leaves erased values erased",
    run: Effect.gen(function* () {
      const triples = yield* Triples;
      const ola = eid("rt:ola");
      yield* triples.assert({
        entityId: ola,
        attribute: ":er-person/ssn",
        value: text("151-51-5151"),
      });
      yield* Sensitive.erase({ subject: ola, actor: "dpo", commandId: "erase-rt-ola" });
      const rewrapped = yield* Sensitive.rewrap;
      yield* check(rewrapped.skipped >= 1, "rewrap skips erased values");
      yield* Sensitive.rotateBlindKey;
      yield* check(
        sealedOf(yield* triples.history(ola)).every((value) => value.blind === undefined),
        "blind-key rotation gives an erased value no token",
      );
      yield* check(
        (yield* triples.match({ attribute: ":er-person/ssn", value: text("151-51-5151") }))
          .length === 0,
        "an erased value still matches nothing",
      );
    }),
  },
];

/** Run every rotation case against one store. */
export const makeRotationSuite = (): Effect.Effect<
  void,
  unknown,
  Triples | Sensitivity | KeyProvider.KeyCustody
> => Effect.forEach(rotationCases, (c) => c.run, { discard: true });
