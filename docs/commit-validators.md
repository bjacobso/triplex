# Commit validators

Status: implemented and covered by shared conformance on KV, SQLite, PostgreSQL, and the
experimental Cloudflare backend. FoundationDB uses the same KV code path, but its native suite
remains opt-in. Pre-1.0: the contract may still change before a stable release.

A commit validator is host code that runs **inside** a Triplex transaction. It runs after the
transaction's operations and journal envelope are applied and before the commit. It reads the
database exactly as it will look if the transaction commits, and it can reject the whole
transaction with typed, structured findings.

## Problem

`Triples.transact` already protects two kinds of invariant atomically:

- **Concurrency.** Compare-and-retract and entity-state preconditions check that the facts a
  command read are still the live facts.
- **Structure.** `enforce` rejects new or worsened required, cardinality, uniqueness, and
  reference-target violations.

Everything else was "host-owned", but hosts had no in-transaction seam. Examples:

- "Only the employee may assert their own Section 1 facts."
- "A signature may not cover a document that expired before the signing instant."
- "A payroll import may not run before Section 2 is complete."

Without a seam, a host checks these before `transact` and races concurrent writers. It cannot
see the facts that its own command is about to write, so some rules can't be checked at all.

## API

```ts
import { Effect } from "effect";
import { CommitValidation } from "@triplex-build/triplex";

const sectionOneOwner = CommitValidation.make("i9.section1-owner", (commit) =>
  Effect.gen(function* () {
    // commit.transaction: attempted txId, instant, actor, commandId, correlationId, ...
    // commit.changes:     resolved assert/retract changes, exactly as they would be journaled
    // commit.before:      read view at the last committed position
    // commit.after:       read view including this transaction's writes
    return [{ code: "not_asserter", message: "...", entityId, attribute }];
  }),
);
```

### The validator contract

`CommitValidation.make(name, validate)` returns a `CommitValidation.Validator<R>`. The `validate`
function receives a `CommitValidation.CommitContext`:

| Field         | Contents                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `transaction` | The attempted `txId`, `instant`, `basisPosition`, `actor`, `commandId`, `correlationId`, `causationId`, `configSnapshot`                                                             |
| `changes`     | The resolved `TransactionChange` list (asserts and retracts with triple ID, entity, attribute, typed value, entity type, valid interval). This is the same list the journal records. |
| `before`      | A read view at `basisPosition`, the last committed position                                                                                                                          |
| `after`       | A read view at the attempted position, which includes this transaction's facts and its `_Transaction` envelope                                                                       |

Each view has `entity`, `entities`, `match`, and complete Datalog `query`. All of them accept
`{ validAt }`, which defaults to the transaction instant. The recorded axis is fixed by the view.

`validate` returns rejections, or nothing to accept the transaction. It may fail with `ReadError`
or a Datalog query error. A rejection has this shape:

```ts
interface Rejection {
  readonly code: string; // stable machine code, e.g. "not_asserter"
  readonly message: string; // human-readable explanation
  readonly entityId?: EntityId; // subject of the finding
  readonly attribute?: string;
  readonly path?: readonly (string | number)[]; // e.g. a form field path
  readonly details?: { readonly [key: string]: unknown }; // JSON evidence
  readonly suggestion?: string; // what the caller could do instead
}
```

If any validator returns a rejection, `transact` fails with `CommitRejectedError`. The error
carries:

- `rejections`: every finding, each stamped with its `validator` name;
- `validators`: the names of the validators that ran;
- `attempt`: the attempted envelope; and
- `changes`: the attempted changes.

The facts, journal envelope, command receipt, and commit position all roll back.

### Two ways to install validators

1. **Per call:** `transact(ops, { validate: [v1, v2] })`. This is the in-transaction mechanism
   that every backend implements, alongside `enforce` and `preconditions`. It suits
   command-specific guards such as "this import requires Section 2 to be complete".
2. **Runtime-wide:**
   `CommitValidation.layer({ validators }).pipe(Layer.provide(backendLayer))`. This decorates any
   `Layer<Triples>` so that every application transaction runs the validators. That includes
   `assert`, `assertBatch`, `retract`, `retractByPattern`, and writes made by the HTTP package or
   other `Triples` consumers. The decorator also owns rejection auditing.

Why both? An authorization rule that you opt into per call is easy to forget on one write path,
so authorization belongs in the runtime-wide layer. A command-specific guard is part of that
command, so it belongs on the call. Both use the same contract and run in the same place.

The layer captures its validators' requirements `R` once, at layer construction. A validator can
depend on host services (a policy table, for example) without changing the `R = never`
signature of `transact`. Services in the calling fiber take precedence over captured ones, so
transaction-local state such as Effect SQL's transaction connection is never replaced. Per-call
validators must already be closed, with `R = never`.

Compose the layer with `Layer.provide(backend)`. Use `Layer.provideMerge(backend)` when the host
also needs the backend's `SqlClient`; the decorated `Triples` is the one exposed either way.

Why not a backend constructor option? A decorator works with every shipped and custom
`Layer<Triples>`, including the ambient PostgreSQL client, `Runtime.define`, and Cloudflare. It
needs no change to each backend's layer signatures. The in-transaction part is plain
`TransactionMeta` that every implementation honors.

## Semantics

### Ordering

Inside the backend's serialized transaction boundary:

1. Reserved-namespace and precondition shape checks.
2. Command-ID claim and commit-position allocation. This is the serialization point.
3. `EntityState` preconditions.
4. `enforce` graph constraints, evaluated on the projected post-state.
5. Apply operations. `TripleLive` preconditions are checked as each retraction runs.
6. Write the `_Transaction` journal envelope.
7. **Commit validators**: runtime-wide validators first, then per-call validators, each in
   declaration order.
8. Commit.

Preconditions run first, so a stale command fails as a retryable `TransactionConflictError`, not
as a business rejection made against data that has since changed. Structural constraints run
next because they are cheap and declarative, so validators can assume a structurally valid
post-state. Validators run last so that `after` is exactly the state that would commit, journal
envelope included.

### Composition and determinism

- Validators run sequentially in a fixed order. Every validator runs even after an earlier one
  rejects, so the error and the audit record contain all the evidence. Rejections keep validator
  order, then the order each validator returned them.
- If a validator **fails** (a `ReadError`, a Datalog error, or a malformed rejection), the
  remaining validators are skipped. The transaction fails with a `WriteError` that names the
  validator. A validator that can't decide never accepts the transaction (fail closed).
- Validators should be deterministic functions of their `CommitContext`. Use
  `transaction.instant` for "today", not a wall clock. A host retry after a conflict runs them
  again against the new state.
- Validators run under the backend's commit serialization, the same contention point that makes
  `enforce` safe. A validator's reads therefore can't race another Triplex writer.

### What validators may not do

Validators are **read-only**. Each view exposes only reads, and there is no "also assert"
channel, for these reasons:

- The journal's `changes` must be the complete, final description of the transaction. Writes
  from a validator would need their own journal entries, `enforce` pass, and validation, which
  makes a fixpoint.
- If one validator could write, the next validator's input would depend on validator order.
- Anything a validator would derive can be computed by the command before `transact`, where it
  becomes part of the ops, the journal, and the validated state.

On SQL backends a validator could still reach the ambient `SqlClient` and write host rows. That
is outside the contract. Put host writes around `transact` (see
[atomic host writes](#atomic-host-writes)).

### System writes

The runtime-wide layer doesn't run validators on Triplex's own reserved-namespace writes:
`ConfigStore`, `EntityValidation`, derivation materialization, consumer checkpoints, and
rejection records. Triplex owns those invariants, and they never write application facts. To
govern who may publish a release, check that at the host call site.

### Authorization

`transaction.actor` is a string the caller supplies. A validator's authorization decision is only
as trustworthy as the host's authentication of that actor. Set it from an authenticated
principal.

Triplex **doesn't** ship a declarative asserter rule in configuration. Real asserter rules are
relational. "The actor is the entity's employee" or "the actor holds an HR role in this
employer" need reads against the database, not a static grant list. The roadmap also keeps
authorization above `Triples` until there is a complete threat model and a portable write-policy
contract. The [authorization example](#example-per-attribute-asserter-rules) shows that an
asserter policy is a short validator. It evaluates relationships in `before`, so a transaction
can't grant itself permission in the same commit.

## Rejection audit

A rejection rolls back the transaction's facts, but auditors still need "we refused this, and
here's why". There are two ways to keep a record, and both run **after the rollback**:

- **Built-in record:**
  `CommitValidation.layer({ validators, recordRejections: true })`. This writes one reserved
  `triplex.commit-rejection` entity under `_triplex/commit-rejection/…`. The entity holds the
  attempted envelope, validator names, findings, and attempted changes as JSON values. The error
  returned to the caller carries `recorded: { entityId, txId }`. Read a record back with
  `CommitValidation.readRejection` or with Datalog over the reserved attributes.
- **Host callback:** `onRejected: (error) => Effect<void>` writes to a host table or metrics.

Both cover every rejection on a transaction that goes through the layer, from runtime-wide and
per-call validators alike. Without the layer, or when the host rolls back an enclosing
transaction (see below), call `CommitValidation.recordRejection(triples, error)` yourself after
the rollback. Recording is idempotent per attempted transaction.

A record can't be mistaken for committed facts:

- It lives in the reserved namespace, which ordinary writes can't target.
- The attempted changes are stored only as JSON payloads on the record entity, never as facts on
  the target entities.
- The attempted `txId` never becomes a `_Transaction`, so `Triples.transaction(attemptTxId)`
  returns `null`.
- The record's own journal envelope names only the record entity as changed.

The record is written by its own system transaction. It appears in the ordered feed as a system
change to `_triplex/commit-rejection/…` and does not reuse the rejected command ID, so the
command can be retried.

**Ambient SQL caveat.** If a host calls `transact` inside its own `sql.withTransaction`, the
rejected Triplex transaction is a savepoint. A built-in record written after the savepoint
rollback still belongs to the host's outer transaction, and the host's rollback discards it.
Such hosts should leave `recordRejections` off. Instead, they catch `CommitRejectedError` after
their outer rollback and call `recordRejection`, or write their own table.

## Atomic host writes

PostgreSQL (`PgTriples.layerFromSqlClient`) and SQLite (`SqliteTriples.layer*`) share Effect SQL's
fiber-local transaction with the host. Host rows written inside `sql.withTransaction` around
`Triples.transact` (outbox, timers, process events) commit or roll back with the facts. That
includes a validator rejection: the rejection fails the inner effect, and the outer transaction
rolls back the host rows. Tests for both backends cover this. KV backends have no host tables.

## Backends

| Backend      | Validator semantics                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| In-memory KV | Same as all backends. Views read the transaction's buffered writes through the hexastore indexes.                                                      |
| SQLite       | Same. Views and Datalog run on the transaction connection with an exact commit-position cut.                                                           |
| PostgreSQL   | Same, including the ambient-client and database-scoped layers.                                                                                         |
| Cloudflare   | Same (experimental). Validators **must be synchronous**: the Durable Object `transactionSync` boundary runs the transaction with `Effect.runSyncExit`. |
| FoundationDB | Same code path as KV (experimental). Validator reads add read-conflict ranges, and their time counts toward FoundationDB's 5-second transaction limit. |

The shared `@triplex-build/triplex-testkit` conformance cases cover validators. They run on KV,
SQLite, PostgreSQL, and both Cloudflare harnesses.

### Performance

Views never materialize a snapshot. Reads use the same indexed paths as ordinary reads, at an
exact commit cut: entity lookups, the KV type index, and SQL `recorded_position` predicates.
Datalog compiles to SQL or runs on the KV executor in the transaction, at that same cut.
Validators run while the transaction holds the commit serialization point, so their latency
adds directly to write latency and limits write throughput. Keep them to indexed point reads
and narrow Datalog.

## Interaction with other features

- **Datalog.** `view.query` is complete (not paged) Datalog at one commit cut. `after` includes
  the attempted `_Transaction` envelope, so rules can join `:_tx/actor` for this transaction.
- **Derivations.** Not run automatically. A validator can run a derivation's query through
  `view.query`.
- **History and the journal.** Rejected transactions leave no facts, envelope, position, or
  command receipt. Committed history is unchanged.
- **Subscriptions.** Rejected transactions emit nothing.
- **`enforce`.** Unchanged, and it runs before validators.

## Out of scope

- Validator writes, or an "also assert" channel (see above).
- Records of the checks that passed on committed transactions. A host that needs them can add
  check facts to its ops.
- A declarative asserter grammar in configuration.
- Async validators on Cloudflare.
- Crash-injection hooks such as `beforeCommit`. Hosts can inject faults by failing a validator in
  tests.

## Example: per-attribute asserter rules

This policy says who may assert each governed attribute. The employee named on an I-9 may sign
Section 1, and an actor with the `hr` role may complete Section 2. Relationships are read from
`before`, so a transaction that sets `:i9/employee` to its own actor cannot also sign in the same
commit. The layer installs the policy for every write path and records each refusal durably.

```ts check
import { Effect, Layer } from "effect";
import {
  CommitRejectedError,
  CommitValidation,
  EntityId,
  KvTriples,
  Triples,
  ref,
  string,
} from "@triplex-build/triplex";

type Grant =
  | { readonly kind: "subject"; readonly via: string }
  | { readonly kind: "role"; readonly role: string };

const grants: Readonly<Record<string, Grant>> = {
  ":i9/section1-signature": { kind: "subject", via: ":i9/employee" },
  ":i9/section2-signature": { kind: "role", role: "hr" },
};

const asserters = CommitValidation.make("i9.asserters", (commit) =>
  Effect.gen(function* () {
    const actor = commit.transaction.actor;
    const rejections: CommitValidation.Rejection[] = [];
    for (const change of commit.changes) {
      const grant = grants[change.attribute];
      if (change.op !== "assert" || grant === undefined) continue;
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
          entityId: EntityId.make(actor),
          attribute: ":person/role",
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
        });
      }
    }
    return rejections;
  }),
);

const Database = CommitValidation.layer({
  validators: [asserters],
  recordRejections: true,
}).pipe(Layer.provide(KvTriples.layer));

const i9 = EntityId.make("i9:alice");
const sign = (attribute: string, actor: string) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    return yield* triples.transact(
      [{ op: "assert", entityId: i9, entityType: "I9", attribute, value: string(actor) }],
      { actor, commandId: `${attribute}:${actor}` },
    );
  });

const program = Effect.gen(function* () {
  const triples = yield* Triples;
  yield* triples.transact([
    {
      op: "assert",
      entityId: EntityId.make("person:hank"),
      attribute: ":person/role",
      value: string("hr"),
    },
    {
      op: "assert",
      entityId: i9,
      entityType: "I9",
      attribute: ":i9/employee",
      value: ref(EntityId.make("person:alice")),
    },
  ]);

  yield* sign(":i9/section1-signature", "person:alice");
  yield* sign(":i9/section2-signature", "person:hank");

  const refused = yield* sign(":i9/section1-signature", "person:hank").pipe(Effect.flip);
  if (refused instanceof CommitRejectedError && refused.recorded !== undefined) {
    const audit = yield* CommitValidation.readRejection(triples, refused.recorded.entityId);
    yield* Effect.log(audit?.rejections[0]?.code); // "not_asserter"
  }
});

Effect.runPromise(program.pipe(Effect.provide(Database)));
```

## Example: a command-specific guard

Per-call validators suit rules that belong to one command. This import refuses to run until
Section 2 is complete, checked against the state that would commit. A later write cannot slip in
between the check and the commit.

```ts check
import { Effect } from "effect";
import { CommitValidation, EntityId, Triples, number } from "@triplex-build/triplex";

const sectionTwoComplete = (i9: EntityId) =>
  CommitValidation.make("payroll.requires-section2", (commit) =>
    Effect.gen(function* () {
      const facts = yield* commit.after.match({
        entityId: i9,
        attribute: ":i9/section2-signature",
      });
      return facts.length > 0
        ? []
        : [
            {
              code: "section2_incomplete",
              message: "Payroll import requires a completed Section 2",
              entityId: i9,
              suggestion: "Complete Section 2, then retry the import",
            },
          ];
    }),
  );

export const importPayroll = (employee: EntityId, i9: EntityId, rate: number) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    return yield* triples.transact(
      [{ op: "assert", entityId: employee, attribute: ":payroll/rate", value: number(rate) }],
      { actor: "service:payroll-import", validate: [sectionTwoComplete(i9)] },
    );
  });
```

## Example: host rows in the same SQL transaction

On PostgreSQL (`PgTriples.layerFromSqlClient`) and SQLite, host rows and Triplex facts share one
Effect SQL transaction. If a validator rejects, the outbox row rolls back with the facts. Because
this host rolls back its own enclosing transaction, it records the rejection afterwards rather
than enabling `recordRejections`.

```ts
const command = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const triples = yield* Triples;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const tx = yield* triples.transact(ops, { actor, commandId });
        yield* sql`INSERT INTO host_outbox (id, body) VALUES (${tx.txId}, 'notify')`;
        return tx;
      }),
    )
    .pipe(
      Effect.tapError((error) =>
        error instanceof CommitRejectedError
          ? CommitValidation.recordRejection(triples, error)
          : Effect.void,
      ),
    );
});
```

Rejection records are ordinary reserved facts, so Datalog can list them:

```ts
const refusals = Effect.gen(function* () {
  const triples = yield* Triples;
  return yield* triples.queryAll({
    find: ["?record", "?actor", "?finding"],
    where: [
      ["?record", ":triplex/commit-rejection-actor", "?actor"],
      ["?record", ":triplex/commit-rejection-finding", "?finding"],
    ],
  });
});
```
