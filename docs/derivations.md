# Derivations

`@triplex-build/triplex/derivation` turns structural Datalog results into content-addressed candidates
with explicit identity, provenance, temporal basis, and configuration identity. It is a derived-fact
engine, not a workflow engine: applications decide whether a candidate opens a task, updates a
projection, triggers an integration, or has no operational consequence.

## Definitions and candidates

```ts
import * as Derivation from "@triplex-build/triplex/derivation";

const program = Effect.gen(function* () {
  const openTraining = yield* Derivation.make({
    name: "task.site-training",
    configSnapshot: deployedSnapshot.id,
    identity: ["?worker", "?site"],
    query: {
      find: ["?worker", "?site"],
      where: [
        ["?placement", ":placement/worker", "?worker"],
        ["?placement", ":placement/site", "?site"],
        ["not", ["?worker", ":training/site", "?site"]],
      ],
    },
  });

  const evaluation = yield* Derivation.evaluate(triples, openTraining, {
    basis: { validAt: Date.now() },
  });

  return { openTraining, evaluation };
});
```

A definition content-binds its name, complete query, optional result `TypeExpr`, declared identity
projection, discovered dependencies, and config snapshot. Results sharing the declared identity
become one candidate; source provenance from every positive graph path is merged.

Candidate identity is stable across definition revisions. Candidate revision changes when the
definition, config pin, result, or explanation changes. Conflicting results for one identity fail
with a typed error rather than being selected arbitrarily.

Each positive source records its triple ID, assertion transaction ID, and transaction position.
The candidate also retains the pinned bitemporal basis and earliest future `validTo` among its
supporting facts when known.

## Provenance contract

The initial exact-provenance language supports patterns, predicates, and negation. Recursive rules,
disjunction, aggregation, pagination, dynamic attributes, and transaction-binding clauses are
rejected when the engine cannot provide a complete and stable source explanation.

Negation explains that the candidate depended on absence but naturally has no positive source fact
for the missing evidence. `nextTemporalBoundary` compensates for temporal negation by considering
recorded future edges across all fixed dependency attributes, including evidence that currently
suppresses every candidate.

## Reconciliation

`Derivation.reconcile(previous, next)` is a pure diff over stable candidate identity. It returns:

- `added` — a logical candidate appeared;
- `removed` — it no longer applies;
- `changed` — it remains but its revision changed; and
- `unchanged` — both identity and revision are unchanged.

The host translates that diff into domain work. A compliance host might create a durable
requirement occurrence for `added`, satisfy or cancel one for `removed`, revise its explanation for
`changed`, and perform no write for `unchanged`. Triplex deliberately does not define those lifecycle
semantics.

## Materialization

```ts
const inspectMaterialization = Effect.gen(function* () {
  const run = yield* Derivation.Materialization.materialize(triples, openTraining, {
    basis: { validAt: now },
  });

  const state = yield* Derivation.Materialization.current(triples, openTraining, {
    basis: { validAt: now },
  });

  return { run, state };
});
```

Materialization persists immutable candidate revisions and a complete evaluation run as reserved
Triplex entities. A run atomically binds:

- definition and configuration IDs;
- the bitemporal basis;
- candidate membership;
- the latest dependency-relevant source position; and
- the next temporal boundary, including for an empty candidate set.

`current` returns `current`, `stale`, or `unmaterialized`. Stale state retains the last durable
candidates and source position. An unrelated transaction does not make a fixed-dependency run stale.
Definition changes, relevant writes, and a different basis do.

There is no mutable first-writer head race. Runs are ordered by dependency source position and then
their materialization commit position. Stored candidate bodies are schema-decoded and their content
IDs are verified on read. `Materialization.runsQuery` exposes immutable historical membership as
ordinary Datalog.

## Dependency state and temporal wakeups

`Triples.dependencyState(attributes, basis)` reads backend indexes rather than replaying the journal.
It returns the latest assertion-or-retraction commit position and the earliest recorded future
`validFrom` or `validTo` for the fixed attribute set.

Every evaluation and materialized run exposes the same conservative `nextTemporalBoundary`. A host
scheduler should wake and rematerialize at that instant:

```ts
if (run.nextTemporalBoundary !== undefined) {
  scheduler.wakeAt(run.nextTemporalBoundary, openTraining.id);
}
```

The schedule is attribute-conservative: an unrelated entity sharing a dependency attribute may
cause an extra wakeup, but recorded future-effective or expiring evidence is not omitted. Dynamic
attribute definitions use an explicit journal fallback and should not be hot-path materializers.
Triplex owns boundary discovery, not timer delivery or retry policy.

## Hypothetical overlays

```ts
const previewChange = Effect.gen(function* () {
  const preview = yield* Derivation.Overlay.evaluateOverlay(triples, openTraining, {
    basis: { validAt: now },
    overlay: {
      assertions: [proposedPlacement, proposedTraining],
      retractions: [supersededFactId],
    },
  });

  return preview;
});
```

Overlay evaluation copies only the definition's fixed dependency attributes at the requested basis
into a private in-memory KV index, applies temporary assertions and visible-fact retractions, and
runs the same structural evaluator. It never mutates the source facts or transaction journal.

Base sources retain their durable IDs. Temporary sources receive deterministic hypothetical content
commitments and are marked `hypothetical: true`, making collect-versus-reuse previews comparable to
committed evaluation without claiming they happened.

An assertion without `validFrom` begins at the overlay's `validAt`. Retractions must identify a fact
visible at that basis. Duplicate, missing, irrelevant, dynamic-attribute, or transaction-binding
operations fail explicitly rather than producing an incomplete preview.

## Host boundary

Triplex provides fact history, Datalog, config identity, candidate provenance, freshness, temporal
wakeups, and pure diffs. The host remains responsible for:

- durable workflow or requirement occurrences;
- assignments, conversations, evidence disposition, and authorization;
- command naming and response caching;
- timer delivery, integrations, retries, inboxes, and outboxes; and
- interpreting candidate addition or removal as product behavior.

The standalone [compliance host demo](https://github.com/bjacobso/triplex/tree/main/examples/compliance-host) composes those responsibilities
end to end over the in-memory backend.
