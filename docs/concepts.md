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

Public reads accept one `{ recordedAt?, validAt? }` basis for the complete read, including every
clause of a Datalog query. Times are non-negative epoch milliseconds and interval ends are
exclusive. If `recordedAt` is omitted, Triplex uses the latest recorded state; if `validAt` is
omitted, it uses the runtime's current time. Setting only one axis does not freeze the other.

Recorded time is assigned by the Triplex transaction boundary, not supplied as application data.
Use the journal's ordered commit positions when exact ordering matters; timestamps alone may not
distinguish commits in the same millisecond.

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
