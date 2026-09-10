# @triplex-build/triplex

An Effect-native fact database with Datalog and typed, content-addressed configuration.

The platform-neutral core includes temporal triples, an in-memory ordered-KV hexastore,
Datalog querying, subscriptions, entity snapshots, configuration releases,
and Effect services.

## Install

```bash
npm install effect@4.0.0-rc.112 @triplex-build/triplex@next
```

Pre-1.0 canaries are published under the `next` tag. Use an exact canary version in lockstep
deployments; the unqualified install currently resolves the bootstrap snapshot until reviewed
stable `0.1.0` replaces it.

## In-memory store

```ts check
import { Effect } from "effect";
import { EntityId, KvTriples, Triples, string } from "@triplex-build/triplex";

const program = Effect.gen(function* () {
  const triples = yield* Triples;
  const alice = EntityId.make("person:alice");

  yield* triples.assert({
    entityId: alice,
    attribute: ":person/name",
    value: string("Alice"),
  });

  return yield* triples.query({
    find: ["?name"],
    where: [["?person", ":person/name", "?name"]],
  });
});

Effect.runPromise(program.pipe(Effect.provide(KvTriples.layer)));
```

SQL implementations live in `@triplex-build/triplex-sql` and the backend-specific packages.

## Typed configuration

```ts
import { Triples } from "@triplex-build/triplex";
import {
  ConfigRuntime,
  ConfigStore,
  EntityValidation,
  Evaluate,
  TypeExpr,
} from "@triplex-build/triplex/config";
```

`ConfigStore.layer` stores typed configuration graphs, immutable `ConfigSnapshot`
releases, revisions, dependency closures, and movable refs through the `Triples`
transaction boundary. `InMemoryConfigStore` is the immutable semantic reference.
`Evaluate` creates content-addressed decision proofs and verifies their internal
tamper-evidence given a trusted decision root.

`Attribute` and `EntityType` provide the ontology DSL. Attribute definitions own stable
lowercase keyword identities and value types; `Attribute.use` adds requiredness and
cardinality only where an entity type uses that attribute. `EntityType.make("Employer", …)`
compiles ergonomic property handles such as `Employer.attributes.name` into independently addressed
attribute nodes plus an `entity-schema` node consumed by `EntityValidation`.

`ConfigRuntime.evaluate` joins the two storage-independent models: it resolves a deployed
configuration ref, derives its rule catalog, reads the current or historical Triple facts
that rule can observe, and returns an evaluation proof whose decision ID binds the release
root, subject, and nested evaluation.

`EntityValidation.define` deploys a `TypeExpr` for an ordinary Triple entity type.
`EntityValidation.layer` explicitly revalidates live entities after a config or fact
change. Results and individual error messages are immutable, content-addressed facts;
the entity body is represented by a state content ID rather than duplicated. Per-ref
checkpoints make `currentInvalid("live")` report current, stale, or unvalidated state,
while `everInvalid()` retains historical subjects, and
the exported Datalog query builders can be composed with application queries.

`EntitySnapshot` is a temporal materialization of one triple entity. `ConfigSnapshot`
is a complete immutable configuration release; they have separate APIs and identities.

## Portable derivations

`@triplex-build/triplex/derivation` evaluates content-addressed structural Datalog definitions
at a pinned bitemporal basis. It deduplicates results by an explicit logical identity,
merges source triple and transaction provenance from every matching graph path, discovers
attribute dependencies, and returns candidates suitable for application-owned reconciliation.
`Derivation.reconcile` reports added, removed, changed, and unchanged candidates; it does not
create tasks or other domain objects. Evaluations also report the earliest future temporal edge
across dependency attributes, including future-effective and expiring facts in negated clauses.

`Derivation.Materialization.materialize` persists an immutable candidate set, bitemporal basis,
configuration pin, and relevant transaction position in one Triples transaction.
`Materialization.current` returns `current`, `stale`, or `unmaterialized` without discarding the
last durable candidates. Immutable runs remain queryable with `Materialization.runsQuery` and
stored candidate bodies are content-verified when loaded. Runs persist and content-bind
`nextTemporalBoundary` even when no candidates exist, allowing a host scheduler to wake the
materializer when expiring evidence may reopen work.

`Derivation.Overlay.evaluateOverlay` previews temporary assertions and retractions at a pinned
bitemporal basis in a fresh private KV index. It returns the normal candidate shape with
content-addressed hypothetical sources while leaving the source facts and journal unchanged.
Fixed-attribute structural definitions are supported; dynamic attributes and transaction-binding
clauses are rejected with typed errors.

## Content addressing

`@triplex-build/triplex/content` exports deterministic canonical encoding and browser-safe,
domain-separated SHA-256 `ContentId` values. IDs use the format
`sha256-<64 lowercase hex characters>`.

The pre-1.0 entity-snapshot hash changed from `fnv1a:<8 hex characters>`. The unpublished
SQL schema now has one canonical baseline; databases from earlier development builds must
be recreated or have their derived snapshots rebuilt from temporal triples.

See the repository [current-state document](../../docs/current-state.md) for backend maturity,
known limitations, and first-release gates.

MIT © 2026 Ben Jacobson.
