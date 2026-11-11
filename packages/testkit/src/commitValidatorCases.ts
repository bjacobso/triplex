/**
 * Commit-validator conformance: every `Triples` backend must run validators
 * inside its transaction with identical semantics. Validators here are
 * synchronous so the cases also run inside Cloudflare's `transactionSync`.
 */

import { Effect, Layer } from "effect";
import {
  CommitRejectedError,
  CommitValidation,
  ConstraintViolationError,
  EntityId,
  ReadError,
  TransactionConflictError,
  Triples,
  WriteError,
  ref as makeRef,
  string,
  type TriplesService,
} from "@triplex-build/triplex";
import { GraphConstraint } from "@triplex-build/triplex/config";
import { ConsumerCheckpoint, Inbox, Outbox } from "@triplex-build/triplex/operational";

const eid = EntityId.make;
const ref = (value: string) => makeRef(eid(value));

class ConformanceError extends Error {
  override readonly name = "ConformanceError";
}

const check = (condition: boolean, message: string): Effect.Effect<void, ConformanceError> =>
  condition ? Effect.void : Effect.fail(new ConformanceError(message));

const sameRows = (
  actual: readonly Record<string, unknown>[],
  expected: readonly Record<string, unknown>[],
): boolean => {
  const key = (row: Record<string, unknown>) =>
    JSON.stringify(
      Object.keys(row)
        .sort()
        .map((name) => [name, row[name]]),
    );
  const left = actual.map(key).sort();
  const right = expected.map(key).sort();
  return left.length === right.length && left.every((row, index) => row === right[index]);
};

/** Install runtime-wide validators over an existing service, as a host would. */
const decorate = <R>(
  triples: TriplesService,
  options: CommitValidation.LayerOptions<R>,
): Effect.Effect<TriplesService, never, R> =>
  Effect.gen(function* () {
    return yield* Triples;
  }).pipe(
    Effect.provide(
      CommitValidation.layer(options).pipe(Layer.provide(Layer.succeed(Triples, triples))),
    ),
  );

// ─── Per-attribute asserter rules: the documented authorization example ────

type Grant =
  | { readonly kind: "subject"; readonly via: string }
  | { readonly kind: "role"; readonly role: string };

const grants: Readonly<Record<string, Grant>> = {
  ":conf/cv-section1": { kind: "subject", via: ":conf/cv-employee" },
  ":conf/cv-section2": { kind: "role", role: "hr" },
};

/**
 * Who may assert each governed attribute. Relationships are read from
 * `before`, so a transaction cannot grant itself permission.
 */
const asserters = CommitValidation.make("conf.asserters", (commit) =>
  Effect.gen(function* () {
    const actor = commit.transaction.actor;
    const rejections: CommitValidation.Rejection[] = [];
    for (const change of commit.changes) {
      if (change.op !== "assert") continue;
      const grant = grants[change.attribute];
      if (grant === undefined) continue;
      let allowed = false;
      if (actor === undefined) {
        allowed = false;
      } else if (grant.kind === "subject") {
        const subjects = yield* commit.before.match({
          entityId: change.entityId,
          attribute: grant.via,
        });
        allowed = subjects.some((fact) => fact.value.type === "ref" && fact.value.value === actor);
      } else {
        const roles = yield* commit.before.match({
          entityId: eid(actor),
          attribute: ":conf/cv-role",
        });
        allowed = roles.some(
          (fact) => fact.value.type === "string" && fact.value.value === grant.role,
        );
      }
      if (!allowed) {
        rejections.push({
          code: "not_asserter",
          message: `${actor ?? "An anonymous actor"} may not assert ${change.attribute}`,
          entityId: change.entityId,
          attribute: change.attribute,
          details: { actor: actor ?? null, grant },
          suggestion:
            grant.kind === "subject"
              ? `Ask the entity's ${grant.via} to submit this fact`
              : `Ask a holder of role ${grant.role} to submit this fact`,
        });
      }
    }
    return rejections;
  }),
);

export const commitValidatorConformanceCases = [
  {
    name: "commit validators see operational append and acknowledgement views and roll them back",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const scope = eid("conf:cv:entries");
      const seeded = Inbox.append({ scope, idempotencyKey: "incoming", payload: { task: "send" } });
      yield* t.transact([seeded]);
      const incoming = (yield* t.pendingOperationalEntries("inbox", { scope })).entries[0]!;
      const outgoing = Outbox.append({
        scope,
        idempotencyKey: "outgoing",
        payload: { forbidden: true },
      });
      const appendedInbox = Inbox.append({
        scope,
        idempotencyKey: "next",
        payload: { task: "next" },
      });
      const inspect = CommitValidation.make("conf.entries", (commit) =>
        Effect.gen(function* () {
          const before = yield* commit.before.operationalEntry(incoming.id);
          const after = yield* commit.after.operationalEntry(incoming.id);
          yield* check(
            before?.acknowledgedPosition === undefined &&
              after?.acknowledgedPosition === commit.after.position,
            "acknowledgement must appear only in after",
          );
          const pendingBefore = yield* commit.before.pendingOperationalEntries("inbox", {
            scope,
            limit: 1,
          });
          const pendingAfter = yield* commit.after.pendingOperationalEntries("inbox", {
            scope,
            limit: 1,
          });
          yield* check(
            pendingBefore.entries[0]?.id === incoming.id &&
              pendingAfter.entries.length === 1 &&
              pendingAfter.entries[0]?.id === Inbox.id(scope, "next"),
            "pending cuts must retain the old inbox entry before and show the new one after",
          );
          const beforeOut = yield* commit.before.pendingOperationalEntries("outbox", { scope });
          const afterOut = yield* commit.after.pendingOperationalEntries("outbox", { scope });
          yield* check(
            beforeOut.entries.length === 0 && afterOut.entries.length === 1,
            "outgoing intent must appear only in after",
          );
          const entry = afterOut.entries[0]!;
          yield* check(
            (yield* commit.before.operationalEntry(entry.id)) === null,
            "point read must hide a new outgoing intent in before",
          );
          yield* check(
            (yield* commit.after.operationalEntry(entry.id))?.txId === commit.transaction.txId,
            "after point read must include the outgoing intent",
          );
          return [{ code: "forbidden_outgoing", message: "Outgoing intent refused" }];
        }).pipe(Effect.mapError((cause) => new ReadError({ message: cause.message, cause }))),
      );
      const error = yield* t
        .transact([Inbox.acknowledge(incoming.id), outgoing, appendedInbox], {
          validate: [inspect],
        })
        .pipe(Effect.flip);
      yield* check(
        error instanceof CommitRejectedError,
        "outgoing intent must reject the transaction",
      );
      yield* check(
        (yield* t.pendingOperationalEntries("outbox", { scope })).entries.length === 0,
        "rejection must leave no outgoing entry",
      );
      yield* check(
        (yield* t.operationalEntry(incoming.id))?.acknowledgedPosition === undefined,
        "rejection must roll back acknowledgement",
      );
      yield* check(
        (yield* t.operationalEntry(Outbox.id(scope, "outgoing"))) === null,
        "rejection must remove the entry record, not just its pending index",
      );
      yield* check(
        (yield* t.operationalEntry(Inbox.id(scope, "next"))) === null,
        "rejection must remove appended inbox entries",
      );
      const accepted = yield* t.transact(
        [Inbox.acknowledge(incoming.id), outgoing, appendedInbox],
        {
          validate: [
            CommitValidation.make("conf.entries.accept", (commit) =>
              inspect.validate(commit).pipe(Effect.asVoid),
            ),
          ],
        },
      );
      yield* check(
        (yield* t.operationalEntry(incoming.id))?.acknowledgedPosition === accepted.position,
        "accepted acknowledgement must match the after-view",
      );
      yield* check(
        (yield* t.operationalEntry(Outbox.id(scope, "outgoing")))?.txId === accepted.txId,
        "accepted outgoing entry must match the after-view",
      );
      // The full conformance suite also checks global pending counts.
      yield* t.transact([
        Outbox.acknowledge(Outbox.id(scope, "outgoing")),
        Inbox.acknowledge(Inbox.id(scope, "next")),
      ]);
    }),
  },
  {
    name: "commit validators read db-before, db-after, and Datalog inside the transaction",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const doc = eid("conf:cv:view-doc");
      const added = eid("conf:cv:view-added");
      const seeded = yield* t.transact([
        {
          op: "assert",
          entityId: doc,
          entityType: "ConfCvViewDoc",
          attribute: ":conf/cv-view-status",
          value: string("draft"),
        },
      ]);
      const draftId = seeded.triples[0]!.id;
      const future = seeded.instant + 10_000_000;
      const statusQuery = {
        find: ["?doc", "?status"],
        where: [["?doc", ":conf/cv-view-status", "?status"]],
      } as const;

      const observed: Record<string, unknown> = {};
      const inspect = CommitValidation.make("conf.inspect", (commit) =>
        Effect.gen(function* () {
          const values = (
            facts: readonly { readonly attribute: string; readonly value: unknown }[],
          ) =>
            facts
              .map(
                (fact) =>
                  `${fact.attribute}=${JSON.stringify((fact.value as { value: unknown }).value)}`,
              )
              .sort();
          observed["transaction"] = commit.transaction;
          observed["changes"] = commit.changes;
          observed["positions"] = [commit.before.position, commit.after.position];
          observed["beforeDoc"] = values(yield* commit.before.entity(doc));
          observed["afterDoc"] = values(yield* commit.after.entity(doc));
          observed["afterFuture"] = values(yield* commit.after.entity(doc, { validAt: future }));
          observed["entities"] = [
            (yield* commit.before.entities([added, doc])).map((facts) => facts.length),
            (yield* commit.after.entities([added, doc])).map((facts) => facts.length),
          ];
          observed["typedBefore"] = values(
            yield* commit.before.match({ entityType: "ConfCvViewDoc" }),
          );
          observed["typedAfter"] = values(
            yield* commit.after.match({ entityType: "ConfCvViewDoc" }),
          );
          observed["datalogBefore"] = yield* commit.before.query(statusQuery);
          observed["datalogAfter"] = yield* commit.after.query(statusQuery);
          observed["envelope"] = yield* commit.after.query({
            find: ["?actor"],
            where: [[commit.transaction.txId, ":_tx/actor", "?actor"]],
          });
          observed["invalidBasis"] = yield* commit.after
            .entity(doc, { validAt: Number.NaN })
            .pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "succeeded" }));
        }),
      );

      const result = yield* t.transact(
        [
          { op: "retract", id: draftId },
          {
            op: "assert",
            entityId: doc,
            entityType: "ConfCvViewDoc",
            attribute: ":conf/cv-view-status",
            value: string("signed"),
          },
          {
            op: "assert",
            entityId: doc,
            entityType: "ConfCvViewDoc",
            attribute: ":conf/cv-view-archive",
            value: string("scheduled"),
            validFrom: future,
          },
          {
            op: "assert",
            entityId: added,
            entityType: "ConfCvViewDoc",
            attribute: ":conf/cv-view-status",
            value: string("draft"),
          },
        ],
        {
          actor: "conf:cv:alice",
          commandId: "conf:cv:view",
          correlationId: "conf:cv:correlation",
          causationId: "conf:cv:causation",
          configSnapshot: "sha256:conf-cv",
          validate: [inspect],
        },
      );

      const transaction = observed["transaction"] as CommitValidation.Attempt;
      yield* check(
        transaction.txId === result.txId &&
          transaction.instant === result.instant &&
          transaction.basisPosition === result.position - 1 &&
          transaction.actor === "conf:cv:alice" &&
          transaction.commandId === "conf:cv:view" &&
          transaction.correlationId === "conf:cv:correlation" &&
          transaction.causationId === "conf:cv:causation" &&
          transaction.configSnapshot === "sha256:conf-cv",
        "validators should receive the complete attempted envelope",
      );
      const changes = observed["changes"] as readonly {
        readonly op: string;
        readonly entityType?: string;
        readonly value?: { readonly value: unknown };
      }[];
      yield* check(
        changes.length === 4 &&
          changes.filter((change) => change.op === "assert").length === 3 &&
          changes.some(
            (change) =>
              change.op === "retract" &&
              change.entityType === "ConfCvViewDoc" &&
              change.value?.value === "draft",
          ),
        "validators should receive resolved assertions and retractions with typed values",
      );
      yield* check(
        JSON.stringify(observed["positions"]) ===
          JSON.stringify([result.position - 1, result.position]),
        "views should read at the basis and attempted commit positions",
      );
      yield* check(
        JSON.stringify(observed["beforeDoc"]) ===
          JSON.stringify([':conf/cv-view-status="draft"']) &&
          JSON.stringify(observed["afterDoc"]) ===
            JSON.stringify([':conf/cv-view-status="signed"']),
        "before should exclude and after should include this transaction's writes",
      );
      yield* check(
        JSON.stringify(observed["afterFuture"]) ===
          JSON.stringify([':conf/cv-view-archive="scheduled"', ':conf/cv-view-status="signed"']),
        "views should accept a business-time instant",
      );
      yield* check(
        JSON.stringify(observed["entities"]) ===
          JSON.stringify([
            [0, 1],
            [1, 1],
          ]),
        "batched entity reads should preserve order and the commit cut",
      );
      yield* check(
        JSON.stringify(observed["typedBefore"]) ===
          JSON.stringify([':conf/cv-view-status="draft"']) &&
          JSON.stringify(observed["typedAfter"]) ===
            JSON.stringify([':conf/cv-view-status="draft"', ':conf/cv-view-status="signed"']),
        "entity-type matches should honor the commit cut",
      );
      yield* check(
        sameRows(observed["datalogBefore"] as Record<string, unknown>[], [
          { "?doc": doc, "?status": "draft" },
        ]) &&
          sameRows(observed["datalogAfter"] as Record<string, unknown>[], [
            { "?doc": doc, "?status": "signed" },
            { "?doc": added, "?status": "draft" },
          ]),
        "Datalog should run over db-before and db-after",
      );
      yield* check(
        sameRows(observed["envelope"] as Record<string, unknown>[], [
          { "?actor": "conf:cv:alice" },
        ]),
        "db-after should include the attempted transaction envelope",
      );
      yield* check(
        observed["invalidBasis"] === "ReadError",
        "an invalid view basis should fail in the typed error channel",
      );
    }),
  },
  {
    name: "commit validators reject atomically, compose in order, and fail closed",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const subject = eid("conf:cv:reject");
      const assertStatus = (value: string) =>
        ({
          op: "assert",
          entityId: subject,
          entityType: "ConfCvReject",
          attribute: ":conf/cv-reject-status",
          value: string(value),
        }) as const;
      let ran: string[] = [];
      const trace = (name: string, findings: readonly CommitValidation.Rejection[] = []) =>
        CommitValidation.make(name, () =>
          Effect.sync(() => {
            ran.push(name);
            return findings;
          }),
        );

      const position = yield* t.currentPosition();
      const rejected = yield* t
        .transact([assertStatus("refused")], {
          actor: "conf:cv:bob",
          commandId: "conf:cv:reject:command",
          correlationId: "conf:cv:reject:correlation",
          validate: [
            trace("conf.first", [
              {
                code: "expired_document",
                message: "Document expired before the signing instant",
                entityId: subject,
                attribute: ":conf/cv-reject-status",
                path: ["section2", "documents", 0],
                details: { expiredAt: 100, nested: { ok: true } },
                suggestion: "Provide an unexpired document",
              },
              { code: "second", message: "A second finding" },
            ]),
            trace("conf.accepts"),
            trace("conf.last", [{ code: "third", message: "A finding from another validator" }]),
          ],
        })
        .pipe(Effect.flip);
      yield* check(
        rejected instanceof CommitRejectedError,
        "a rejection should fail with CommitRejectedError",
      );
      const error = rejected as CommitRejectedError;
      yield* check(
        JSON.stringify(ran) === JSON.stringify(["conf.first", "conf.accepts", "conf.last"]) &&
          JSON.stringify(error.validators) === JSON.stringify(ran),
        "every validator should run in declaration order after a rejection",
      );
      yield* check(
        JSON.stringify(error.rejections.map((finding) => [finding.validator, finding.code])) ===
          JSON.stringify([
            ["conf.first", "expired_document"],
            ["conf.first", "second"],
            ["conf.last", "third"],
          ]),
        "findings should keep validator order and be stamped with the validator name",
      );
      const first = error.rejections[0]!;
      yield* check(
        first.entityId === subject &&
          first.attribute === ":conf/cv-reject-status" &&
          JSON.stringify(first.path) === JSON.stringify(["section2", "documents", 0]) &&
          JSON.stringify(first.details) ===
            JSON.stringify({ expiredAt: 100, nested: { ok: true } }) &&
          first.suggestion === "Provide an unexpired document",
        "findings should preserve the complete rejection shape",
      );
      yield* check(
        error.attempt.actor === "conf:cv:bob" &&
          error.attempt.commandId === "conf:cv:reject:command" &&
          error.attempt.correlationId === "conf:cv:reject:correlation" &&
          error.attempt.basisPosition === position &&
          error.changes.length === 1 &&
          error.changes[0]?.attribute === ":conf/cv-reject-status" &&
          error.recorded === undefined,
        "the rejection should carry the attempted envelope and changes",
      );
      yield* check(
        (yield* t.currentPosition()) === position &&
          (yield* t.match({ entityId: subject })).length === 0 &&
          (yield* t.transaction(error.attempt.txId)) === null &&
          (yield* t.transactionByCommand("conf:cv:reject:command")) === null,
        "a rejection must roll back facts, journal, command receipt, and commit position",
      );
      const retried = yield* t.transact([assertStatus("accepted")], {
        actor: "conf:cv:bob",
        commandId: "conf:cv:reject:command",
        validate: [trace("conf.retry")],
      });
      yield* check(
        (yield* t.transactionByCommand("conf:cv:reject:command"))?.txId === retried.txId,
        "a rejected command ID should remain available for retry",
      );

      ran = [];
      const failed = yield* t
        .transact([assertStatus("failed")], {
          validate: [
            trace("conf.before-failure"),
            CommitValidation.make("conf.broken", () =>
              Effect.fail(new ReadError({ message: "policy table unavailable" })),
            ),
            trace("conf.after-failure", [{ code: "never", message: "never reported" }]),
          ],
        })
        .pipe(Effect.flip);
      yield* check(
        failed instanceof WriteError &&
          failed.message.includes("conf.broken") &&
          JSON.stringify(ran) === JSON.stringify(["conf.before-failure"]),
        "a failing validator should abort with a WriteError naming it and skip later validators",
      );

      const datalogFailure = yield* t
        .transact([assertStatus("bad-query")], {
          validate: [
            CommitValidation.make("conf.bad-query", (commit) =>
              commit.after
                .query({ find: ["?missing"], where: [["?e", ":conf/cv-x", "?v"]] })
                .pipe(Effect.asVoid),
            ),
          ],
        })
        .pipe(Effect.flip);
      yield* check(
        datalogFailure instanceof WriteError && datalogFailure.message.includes("conf.bad-query"),
        "an invalid Datalog read should fail closed",
      );

      for (const [label, findings] of [
        ["empty code", [{ code: "", message: "missing code" }]],
        ["non-JSON details", [{ code: "nan", message: "bad", details: { value: Number.NaN } }]],
        ["non-object", ["not a rejection"]],
      ] as const) {
        const invalid = yield* t
          .transact([assertStatus(label)], {
            validate: [
              CommitValidation.make("conf.invalid", () =>
                Effect.succeed(findings as unknown as readonly CommitValidation.Rejection[]),
              ),
            ],
          })
          .pipe(Effect.flip);
        yield* check(
          invalid instanceof WriteError && invalid.message.includes("invalid rejection"),
          `a malformed rejection (${label}) should fail closed`,
        );
      }
      const duplicate = yield* t
        .transact([assertStatus("duplicate")], {
          validate: [trace("conf.same"), trace("conf.same")],
        })
        .pipe(Effect.flip);
      yield* check(
        duplicate instanceof WriteError && duplicate.message.includes("Duplicate"),
        "duplicate validator names should be rejected",
      );

      // Preconditions and graph constraints run before validators.
      ran = [];
      const stale = yield* t.assert({
        entityId: eid("conf:cv:stale"),
        attribute: ":conf/cv-stale",
        value: string("old"),
      });
      yield* t.retract(stale.id);
      const settled = yield* t.currentPosition();
      const conflict = yield* t
        .transact([{ op: "retract", id: stale.id }], {
          preconditions: [{ _tag: "TripleLive", id: stale.id }],
          validate: [trace("conf.after-precondition", [{ code: "late", message: "too late" }])],
        })
        .pipe(Effect.flip);
      const priority = yield* t
        .transact(
          [
            { ...assertStatus("unnamed"), entityId: eid("conf:cv:priority") },
            { op: "retract", id: stale.id },
          ],
          {
            preconditions: [{ _tag: "TripleLive", id: stale.id }],
            enforce: GraphConstraint.enforcement([
              GraphConstraint.required("ConfCvReject", ":conf/cv-reject-name"),
            ]),
          },
        )
        .pipe(Effect.flip);
      yield* check(
        priority instanceof TransactionConflictError,
        "TripleLive must precede enforcement and all operations",
      );
      const violation = yield* t
        .transact([{ ...assertStatus("unnamed"), entityId: eid("conf:cv:reject-unnamed") }], {
          enforce: GraphConstraint.enforcement([
            GraphConstraint.required("ConfCvReject", ":conf/cv-reject-name"),
          ]),
          validate: [trace("conf.after-constraint", [{ code: "late", message: "too late" }])],
        })
        .pipe(Effect.flip);
      yield* check(
        conflict instanceof TransactionConflictError &&
          violation instanceof ConstraintViolationError &&
          ran.length === 0,
        "preconditions and graph constraints should fail before validators run",
      );
      yield* check(
        (yield* t.currentPosition()) === settled,
        "failed validator transactions must not allocate commit positions",
      );
    }),
  },
  {
    name: "runtime-wide commit validators authorize asserters on every write path and audit rejections",
    run: Effect.gen(function* () {
      const t = yield* Triples;
      const alice = "conf:cv:alice";
      const hank = "conf:cv:hank";
      const i9 = eid("conf:cv:i9");
      yield* t.transact(
        [
          {
            op: "assert",
            entityId: eid(hank),
            entityType: "ConfCvPerson",
            attribute: ":conf/cv-role",
            value: string("hr"),
          },
          {
            op: "assert",
            entityId: i9,
            entityType: "ConfCvI9",
            attribute: ":conf/cv-employee",
            value: ref(alice),
          },
        ],
        { actor: "conf:cv:system" },
      );

      const hooked: CommitRejectedError[] = [];
      const guarded = yield* decorate(t, {
        validators: [asserters],
        recordRejections: true,
        onRejected: (error) => Effect.sync(() => hooked.push(error)),
      });
      const section = (attribute: string, value: string, entityId = i9) =>
        ({
          op: "assert",
          entityId,
          entityType: "ConfCvI9",
          attribute,
          value: string(value),
        }) as const;

      const signed = yield* guarded.transact([section(":conf/cv-section1", "alice-signature")], {
        actor: alice,
      });
      const reviewed = yield* guarded.transact([section(":conf/cv-section2", "hank-review")], {
        actor: hank,
      });
      yield* check(
        signed.triples.length === 1 && reviewed.triples.length === 1,
        "granted actors should be able to assert governed attributes",
      );

      const refused = yield* guarded
        .transact([section(":conf/cv-section1", "hank-forgery")], {
          actor: hank,
          commandId: "conf:cv:forgery",
          correlationId: "conf:cv:forgery:correlation",
        })
        .pipe(Effect.flip);
      yield* check(
        refused instanceof CommitRejectedError &&
          refused.rejections.length === 1 &&
          refused.rejections[0]?.code === "not_asserter" &&
          refused.rejections[0]?.validator === "conf.asserters" &&
          refused.rejections[0]?.entityId === i9 &&
          refused.recorded !== undefined,
        "an actor outside the grant should be rejected with an audited finding",
      );
      const error = refused as CommitRejectedError;
      yield* check(
        hooked.length === 1 && hooked[0]?.recorded?.entityId === error.recorded?.entityId,
        "the rejection hook should run once after recording",
      );

      // Every convenience write path is governed, not only transact.
      const viaAssert = yield* guarded
        .assert({
          entityId: i9,
          entityType: "ConfCvI9",
          attribute: ":conf/cv-section2",
          value: string("anonymous-review"),
        })
        .pipe(Effect.flip);
      const viaBatch = yield* guarded
        .assertBatch([
          {
            entityId: i9,
            entityType: "ConfCvI9",
            attribute: ":conf/cv-section1",
            value: string("batched"),
          },
        ])
        .pipe(Effect.flip);
      yield* check(
        viaAssert.cause instanceof CommitRejectedError &&
          viaBatch.cause instanceof CommitRejectedError &&
          hooked.length === 3,
        "assert and assertBatch should run runtime-wide validators",
      );

      // Relationships are read from db-before: a transaction cannot grant itself access.
      const selfGranted = eid("conf:cv:i9-mallory");
      const escalation = yield* guarded
        .transact(
          [
            {
              op: "assert",
              entityId: selfGranted,
              entityType: "ConfCvI9",
              attribute: ":conf/cv-employee",
              value: ref("conf:cv:mallory"),
            },
            section(":conf/cv-section1", "mallory-signature", selfGranted),
          ],
          { actor: "conf:cv:mallory" },
        )
        .pipe(Effect.flip);
      yield* check(
        escalation instanceof CommitRejectedError &&
          (yield* t.match({ entityId: selfGranted })).length === 0,
        "same-transaction relationship grants should not authorize an assertion",
      );

      // Runtime-wide validators run before per-call validators.
      const order: string[] = [];
      const ordered = yield* decorate(t, {
        validators: [
          CommitValidation.make("conf.runtime", () =>
            Effect.sync(() => void order.push("runtime")),
          ),
        ],
      });
      yield* ordered.transact([section(":conf/cv-note", "ordered")], {
        validate: [
          CommitValidation.make("conf.call", () => Effect.sync(() => void order.push("call"))),
        ],
      });
      yield* check(
        JSON.stringify(order) === JSON.stringify(["runtime", "call"]),
        "runtime-wide validators should run before per-call validators",
      );

      // The durable record cannot be mistaken for committed facts.
      const recorded = error.recorded!;
      const record = yield* CommitValidation.readRejection(t, recorded.entityId);
      yield* check(
        record !== null &&
          record.attempt.txId === error.attempt.txId &&
          record.attempt.actor === hank &&
          record.attempt.commandId === "conf:cv:forgery" &&
          record.attempt.correlationId === "conf:cv:forgery:correlation" &&
          JSON.stringify(record.validators) === JSON.stringify(["conf.asserters"]) &&
          JSON.stringify(record.rejections) === JSON.stringify(error.rejections) &&
          record.changes.length === 1 &&
          record.changes[0]?.attribute === ":conf/cv-section1",
        "the rejection record should round-trip the attempt, validators, findings, and changes",
      );
      const section1 = yield* t.match({ entityId: i9, attribute: ":conf/cv-section1" });
      const recordTransaction = yield* t.transaction(recorded.txId);
      yield* check(
        section1.length === 1 &&
          section1[0]?.value.type === "string" &&
          section1[0].value.value === "alice-signature" &&
          (yield* t.transaction(error.attempt.txId)) === null &&
          (yield* t.transactionByCommand("conf:cv:forgery")) === null &&
          recordTransaction !== null &&
          recordTransaction.actor === undefined &&
          recordTransaction.changes.length > 0 &&
          recordTransaction.changes.every((change) => change.entityId === recorded.entityId),
        "rejected facts must stay absent; the record is its own system transaction",
      );
      const again = yield* CommitValidation.recordRejection(t, error);
      yield* check(
        again.entityId === recorded.entityId && again.txId === recorded.txId,
        "recording a rejection should be idempotent per attempted transaction",
      );
      const forged = yield* t
        .assert({
          entityId: CommitValidation.rejectionEntityId(error.attempt.txId),
          attribute: ":conf/cv-forged",
          value: string("forged"),
        })
        .pipe(Effect.flip);
      yield* check(
        forged instanceof WriteError && forged.message.includes("reserved"),
        "ordinary writes must not forge rejection records",
      );

      // The layer audits per-call rejections even without runtime-wide validators.
      const auditOnly = yield* decorate<never>(t, { validators: [], recordRejections: true });
      const perCall = yield* auditOnly
        .transact([section(":conf/cv-note", "per-call")], {
          validate: [
            CommitValidation.make("conf.per-call", () =>
              Effect.succeed([{ code: "per_call", message: "Refused by the command" }]),
            ),
          ],
        })
        .pipe(Effect.flip);
      yield* check(
        perCall instanceof CommitRejectedError &&
          perCall.recorded !== undefined &&
          (yield* CommitValidation.readRejection(t, perCall.recorded.entityId))?.rejections[0]
            ?.code === "per_call",
        "the layer should record per-call rejections too",
      );

      // Triplex system writes are not subject to runtime-wide validators.
      const rejectAll = yield* decorate(t, {
        validators: [
          CommitValidation.make("conf.reject-all", () =>
            Effect.succeed([{ code: "closed", message: "Writes are closed" }]),
          ),
        ],
      });
      const checkpoint = yield* ConsumerCheckpoint.advance(rejectAll, {
        consumer: "conf:cv:checkpoint",
        expectedPosition: 0,
        nextPosition: yield* t.currentPosition(),
      });
      const blocked = yield* rejectAll
        .transact([section(":conf/cv-note", "closed")])
        .pipe(Effect.flip);
      yield* check(
        checkpoint.consumer === "conf:cv:checkpoint" && blocked instanceof CommitRejectedError,
        "system writes should bypass runtime-wide validators while application writes do not",
      );
      const reused = yield* guarded.transact([section(":conf/cv-section2", "again")], {
        actor: hank,
        commandId: "conf:cv:forgery",
      });
      yield* check(
        (yield* t.transactionByCommand("conf:cv:forgery"))?.txId === reused.txId,
        "a rejected command ID should not be claimed by the rejection record",
      );
    }),
  },
] as const satisfies readonly {
  readonly name: string;
  readonly run: Effect.Effect<void, unknown, Triples>;
}[];
