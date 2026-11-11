# Core concepts

Triplex stores facts, not mutable rows. It keeps when each assertion was recorded, when it was valid
in the domain, which configuration release governed a write, and which facts supported derived
results. This guide uses one safety-training example to connect those ideas.

## Facts and relationships

Suppose worker Maria is placed at the Harbor site and has a safety certificate. Triplex represents
that state as small typed facts:

| Entity              | Attribute             | Value               |
| ------------------- | --------------------- | ------------------- |
| `worker:maria`      | `:worker/name`        | `"Maria"`           |
| `placement:harbor`  | `:placement/worker`   | `ref(worker:maria)` |
| `placement:harbor`  | `:placement/site`     | `ref(site:harbor)`  |
| `certificate:maria` | `:certificate/worker` | `ref(worker:maria)` |
| `certificate:maria` | `:certificate/site`   | `ref(site:harbor)`  |

An entity ID groups facts for convenient entity reads. A reference value creates a relationship to
another entity. There is no separate relationship table or hidden object graph: queries join facts
by their values.

Entity type names such as `Worker` and global attribute names such as `:worker/name` are different
identities. Configuration can say how an entity type uses an attribute—required, single-valued,
unique, or reference-constrained—but those rules are not automatically enforced on every write.

## Assertions, retractions, and correction

An assertion says that a typed fact holds over a valid-time interval. A retraction closes that
assertion's **recorded** visibility; it does not erase the original fact or rewrite its history.
Corrections therefore append evidence:

1. retract the assertion that is no longer part of the current recorded view;
2. assert the corrected interval or value; and
3. do both in one attributed `Triples.transact` call.

`history(entityId)` includes retracted assertions. Current `entity` and `match` reads show only
facts visible at their requested bitemporal basis.

### End a fact at a time

A retraction removes an assertion from the current recorded view for its **whole** valid interval,
including its past. To end a value from time `T` on while keeping what was true before `T`, retract
the open assertion and re-assert the same value with `validTo: T`, in one transaction. Assert the
replacement value from `T` in the same transaction when there is one:

```ts check
import { Effect, Option } from "effect";
import { EntityId, KvTriples, Triples, string } from "@triplex-build/triplex";

const vendor = EntityId.make("vendor:acme");
const KNOWN = Date.UTC(2026, 0, 1);
const ACTIVATED = Date.UTC(2026, 2, 15);

const program = Effect.gen(function* () {
  const triples = yield* Triples;
  const created = yield* triples.transact(
    [
      {
        op: "assert",
        entityId: vendor,
        entityType: "Vendor",
        attribute: ":vendor/status",
        value: string("prospect"),
        validFrom: KNOWN,
      },
    ],
    { actor: "user:pat", commandId: "vendor:acme:create" },
  );
  const prospect = created.triples[0]!;

  // Prospect until March 15, active from then on: one command, one transaction.
  yield* triples.transact(
    [
      { op: "retract", id: prospect.id },
      {
        op: "assert",
        entityId: vendor,
        entityType: "Vendor",
        attribute: ":vendor/status",
        value: string("prospect"),
        validFrom: KNOWN,
        validTo: ACTIVATED,
      },
      {
        op: "assert",
        entityId: vendor,
        entityType: "Vendor",
        attribute: ":vendor/status",
        value: string("active"),
        validFrom: ACTIVATED,
      },
    ],
    {
      actor: "user:pat",
      commandId: "vendor:acme:activate",
      preconditions: [{ _tag: "TripleLive", id: prospect.id }],
    },
  );

  const before = yield* triples.match(
    { entityId: vendor, attribute: ":vendor/status" },
    { validAt: Date.UTC(2026, 1, 1) },
  );
  // Triple.validFrom is a number; Triple.validTo is an Option (None when open-ended).
  return before.map((fact) => ({
    value: fact.value,
    validFrom: new Date(fact.validFrom).toISOString(),
    validTo: Option.match(fact.validTo, {
      onNone: () => "open",
      onSome: (end) => new Date(end).toISOString(),
    }),
  }));
});

console.log(await Effect.runPromise(program.pipe(Effect.provide(KvTriples.layer))));
// [{ value: { type: "string", value: "prospect" }, validFrom: "2026-01-01T00:00:00.000Z",
//    validTo: "2026-03-15T00:00:00.000Z" }]
```

Operations are `{ op: "assert", entityId, attribute, value, entityType?, validFrom?, validTo? }`,
`{ op: "retract", id }` for one assertion by its `TripleId`, and
`{ op: "retract-pattern", pattern }` for every live assertion matching an entity, attribute, type,
or value pattern. Retract by `id` when you mean one assertion; the ID comes from
`TransactionResult.triples`, `match`, `entity`, or `history`. A stored `Triple` carries
`validFrom` as epoch milliseconds and `validTo`, `retractedAt`, `entityType`, and `txId` as Effect
`Option`s. Its `value` is a tagged union: `string`, `number`, `boolean`, `datetime`, `ref`, `json`,
`blob`, or `sealed` for a [sensitive value](/sensitive-values).

The same rule applies with constraint enforcement: retracting the open assertion alone leaves the
entity's past without the attribute, which a `required` rule rejects. Under enforcement, add a
`TripleLive` precondition (as above) or an
[`EntityState` precondition](/operational-primitives#entity-state-preconditions) so a concurrent
change fails instead of being overwritten.

## Recorded time and valid time

The two clocks answer different questions:

- **Recorded time:** what the database knew at an instant.
- **Valid time:** when the fact was true in the domain.

Imagine this certificate history:

- On January 5, the host records that Maria's certificate is valid from January 1 through December 31.
- On March 1, the host learns it was actually revoked effective February 1. In one correction
  transaction it retracts the original assertion and records the corrected January interval.

The same `validAt` date can produce a different answer as knowledge changes:

| Read basis                    | Certificate visible? | Why                                          |
| ----------------------------- | -------------------- | -------------------------------------------- |
| recorded Feb 15, valid Feb 15 | Yes                  | The revocation was not known yet.            |
| recorded Mar 2, valid Feb 15  | No                   | The corrected interval ended on Feb 1.       |
| recorded Mar 2, valid Jan 15  | Yes                  | The corrected assertion still covers Jan 15. |

Public reads accept one `{ recordedAt?, recordedPosition?, validAt? }` basis for the complete read, including every
clause of a Datalog query. Times are non-negative epoch milliseconds and interval ends are
exclusive. Supply either `recordedAt` or `recordedPosition`; giving both is rejected.
A position is a non-negative safe integer, with zero selecting the empty cut.
Position cuts distinguish commits even when their recorded timestamps are identical.
If both recorded fields are omitted, Triplex uses the latest recorded state; if `validAt` is
omitted, it uses the runtime's current time. Setting only one axis does not freeze the other.

Recorded time is the commit clock. The Triplex transaction boundary assigns it, and there is no
option to supply or backdate it, so a historical import records everything at the import's commit
time. Put the domain dates in valid time; if you also need "when did we learn this", model it as an
ordinary attribute (for example `:review/received-at`) on the entity. Tests of recorded-time travel
must capture instants from real commits, such as a receipt's `instant`, rather than inventing them.
Use the journal's ordered commit positions when exact ordering matters; timestamps alone may not
distinguish commits in the same millisecond.

### Read an assertion's interval

Datalog patterns bind entity, attribute, value, and optionally the asserting transaction. They
cannot bind an assertion's `validFrom` or `validTo`. Questions such as "which exceptions expire
within 30 days" have two workarounds:

- **Two bases.** Query the same thing at `validAt: t` and at `validAt: t + 30 days`; the bindings
  present in the first result and absent from the second end inside that window.
- **Direct reads.** Use `match` or `entity` for the candidate entities and read each `Triple`'s
  `validTo` (an `Option`).

Store a date as an ordinary `instant` attribute only when it is domain data in its own right, not to
duplicate the assertion's interval.

## Datalog asks across relationships

A structural query can identify placed workers who lack a certificate for the same site:

```ts
const openTraining = {
  find: ["?worker", "?site"],
  where: [
    ["?placement", ":placement/worker", "?worker"],
    ["?placement", ":placement/site", "?site"],
    [
      "not",
      ["?certificate", ":certificate/worker", "?worker"],
      ["?certificate", ":certificate/site", "?site"],
    ],
  ],
} as const;
```

Variables beginning with `?` join clauses. The `not` clause is safe because `?worker` and `?site`
are already bound by the placement clauses. Before the corrected February basis the placement does
not match; afterward it does. See [Datalog](/datalog) for predicates, disjunction, aggregation,
recursion, and snapshot-stable pagination.

## Configuration releases and refs

Triplex configuration is a separate typed graph for schemas, forms, policies, routines, and other
application-defined objects. A commit records the **complete** graph as an immutable release:

- a `ConfigNode` has a stable logical `(kind, key)` and a content ID;
- a revision records a version of one logical object and its dependency closure;
- a `ConfigSnapshot` pins the full release and its revision set; and
- a movable ref such as `test` or `live` points to one existing snapshot.

Promoting or rolling back configuration means moving a ref. It does not copy nodes, mutate an old
release, reverse operational facts, or run a data migration. Operational transactions should store
the actual snapshot ID returned by `commit`/`resolveRef` in `meta.configSnapshot`, rather than only
the movable ref name. Follow the [complete versioning walkthrough](/configuration-versioning).

## Entity snapshots are not configuration snapshots

Both use content identity, but they answer different questions:

| Identity         | Represents                                             | Changes when                                      |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------- |
| `EntitySnapshot` | one fact entity materialized at a transaction or basis | that entity's visible facts change                |
| `ConfigSnapshot` | one immutable release of a configuration graph         | a new complete configuration release is committed |

Neither replaces the transaction journal. Entity snapshots are projections whose source position
must be checked for freshness; configuration snapshots are immutable release roots addressed by
configuration APIs.

## Derived work and provenance

A derivation pins a Datalog query, candidate identity, configuration snapshot, and dependency set.
For the query above, a candidate might mean “Maria needs Harbor training.” Triplex can retain the
source triple IDs and assertion transactions that explain the candidate, compare one evaluation
with another, and report `added`, `removed`, `changed`, and `unchanged` candidates.

The host decides what those changes mean. Triplex does not automatically create or cancel a task,
send a notification, retry a delivery, or assign an owner. Materialized derivations are projections
and report `current`, `stale`, or `unmaterialized`; a stale result is last-known data, not current
truth. The host owns catch-up and timer delivery, including waking at a derivation's next valid-time
boundary.

Exact derivation provenance currently covers patterns, predicates, and negation. Derivations reject
recursive rules, disjunction, aggregation, pagination, dynamic attributes, and transaction-binding
clauses where Triplex cannot preserve a complete explanation. Raw Datalog supports more of those
features when provenance is not requested.

## Constraints and responsibility boundaries

The ontology DSL produces requiredness, cardinality, uniqueness, and reference-target constraints.
They become atomic write guards only when a host passes the rules in `meta.enforce`, normally from
the same snapshot pinned in `meta.configSnapshot`. Observation-only validation remains useful for
migrations and audits. Direct adapter writes and unconstrained commands are outside enforcement.

Triplex owns facts, temporal reads, atomic transactions, the causal journal, configuration identity,
and derivation mechanics. The host still owns authentication, authorization, database/tenant
selection, domain commands, higher-order business invariants, durable workflow lifecycle, external
delivery, retries, migrations, monitoring, retention, backup, and recovery. See [Host
integration](/host-integration) for the operational boundary.

## Where Triplex fits

Triplex is designed for domains where history and rules are part of the answer: compliance,
onboarding, eligibility, entitlements, governed back-office work, and agent-driven systems that
need a durable causal record. It is usually a poor fit for high-volume telemetry, blob storage,
queue-only workloads, or simple state that never needs temporal or provenance questions.
