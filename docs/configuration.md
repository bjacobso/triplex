# Typed configuration

Triplex configuration is immutable, typed, and content-addressed. It is separate from operational
facts even when persisted through the same `Triples` service:

::: tip Looking for the release workflow?
Start with the [complete publish, promote, pin, inspect, and rollback
walkthrough](/configuration-versioning). This page is the detailed configuration contract.
:::

- an `EntitySnapshot` materializes one fact entity at a transaction or time;
- a `ConfigSnapshot` is an immutable release root containing revisions, schema stamps, dependency
  closures, and refs.

Configuration is exported from `@triplex-build/triplex/config` rather than flattened into the package
root.

## Content model

`TypeExpr` describes runtime values. `ConfigNode` attaches a stable logical `(kind, key)` identity,
typed attributes, and references to that value. Canonical encoding and domain-separated SHA-256
produce explicit `ContentId` values; equal nodes deduplicate and unchanged revisions are shared
between releases.

`InMemoryConfigStore` is the immutable semantic reference implementation. `ConfigStore.layer` is
the Effect-native store that persists config objects, revisions, snapshots, and refs as reserved
Triplex system facts. A release commit and optional ref move use one atomic Triples transaction.

```ts check
import { Layer } from "effect";
import { KvTriples } from "@triplex-build/triplex";
import { ConfigStore } from "@triplex-build/triplex/config";

const AppLayer = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));
```

## Ontology DSL

The DSL separates three identities:

- entity type: PascalCase, such as `Employer`;
- global attribute: lowercase namespaced keyword, such as `:employer/name`;
- TypeScript property: an ergonomic local alias, such as `name`.

```ts check
import { EntityId } from "@triplex-build/triplex";
import { Attribute, EntityType } from "@triplex-build/triplex/config";

export const EmployerName = Attribute.text(":employer/name");

export const Employer = EntityType.make("Employer", {
  attributes: {
    name: Attribute.use(EmployerName, {
      required: true,
      unique: true,
    }),
  },
});

export const EmployerSummary = EntityType.make("EmployerSummary", {
  attributes: {
    name: Attribute.use(EmployerName, { required: false }),
  },
});

export const EmploymentEmployer = Attribute.ref(":employment/employer", Employer);

export const Employment = EntityType.make("Employment", {
  attributes: {
    employer: Attribute.use(EmploymentEmployer, { required: true }),
  },
});

const validFrom = Date.now();
Employer.attributes.name.key; // ":employer/name"
Employer.attributes.name.assertion("Acme", { validFrom });
Employment.attributes.employer.assertion(EntityId.make("employer:acme"), { validFrom });
```

A handle's `assertion(value, { validFrom, validTo })` returns `{ attribute, value, validFrom?,
validTo? }`, ready to spread into an `assert` operation next to `op`, `entityId`, and `entityType`.
Both options are epoch milliseconds and describe the half-open valid interval `[validFrom, validTo)`;
omit `validFrom` to start at the commit time and omit `validTo` for an open-ended fact. A non-finite
value, or a `validTo` that is not later than `validFrom`, throws.

Requiredness is not inherently true of `:employer/name`; it is true of the way `Employer` uses the
attribute. Reference attributes follow the same separation.

`Employer.nodes` yields the independently identified attribute definitions followed by the entity
schema. `Employer.constraints` yields independently content-addressed required, cardinality,
uniqueness, and reference-target rules. Handles remain convenient at the application boundary:

## Releases and refs

Commit application-defined node kinds together. Triplex does not prescribe what a form, policy,
routine, permission, integration, or view means; it preserves their typed graph and identity.

```ts
const publish = Effect.gen(function* () {
  const config = yield* ConfigStore.ConfigStore;

  const release = yield* config.commit({
    label: "2026.1",
    objects: [...(yield* Employer.nodes), formNode, policyNode, routineNode],
    ref: "live",
  });

  yield* config.setRef("test", release.snapshot.id);
  return release;
});
```

Moving a ref copies no configuration. Ref movement uses compare-and-retract so a stale writer
cannot silently overwrite a newer pointer. The store rejects dangling refs and duplicate logical
objects, preserves `validUnder` schema compatibility, and uses Datalog for reverse dependency and
deploy-impact candidate discovery. Merkle hashing and proof verification remain content operations,
not database queries.

Operational transactions can pin the exact release that governed them:

```ts
const write = Effect.gen(function* () {
  yield* triples.transact(operations, {
    actor: "agent:worker-7",
    commandId: "command:123",
    configSnapshot: release.snapshot.id,
  });
});
```

## Runtime evaluation and decision proofs

`ConfigRuntime` resolves a ref, derives the rule catalog from that immutable snapshot, reads only
the current or historical Triple facts statically reachable by the rule, and evaluates against the
pinned release:

```ts
const decide = Effect.gen(function* () {
  const decision = yield* ConfigRuntime.evaluate({
    ref: "live",
    rule: "may-deploy",
    subject: "employee:alice",
    clock: { now: Date.now(), granularity: "day" },
  });

  return ConfigRuntime.verify(decision);
});
```

The decision ID binds the release root, subject, reason, and nested evaluation. Changing the config
pin or proof breaks verification. This proves internal content integrity given a trusted decision
root; it does not independently prove that an external actor chose the right rule, authorized the
decision, or supplied a correct real-world answer.

Passing `asOf` evaluates the same deployed rule against historical facts. A rule read that observes
multiple live values fails rather than arbitrarily choosing one, and nonscalar JSON is rejected at
the storage-to-proof bridge.

## Validation observations

`EntityValidation` deploys runtime entity schemas and explicitly validates ordinary facts against a
config ref:

```ts
const inspectValidation = Effect.gen(function* () {
  const validation = yield* EntityValidation.EntityValidation;
  const run = yield* validation.revalidate({ ref: "live" });

  const state = yield* validation.currentInvalid("live");
  const everInvalid = yield* validation.everInvalid();
  const violations = yield* validation.violations({ subject: "employee:alice" });

  return { run, state, everInvalid, violations };
});
```

Results and individual violations are immutable, content-addressed reserved facts. They bind the
exact config snapshot, schema, subject, and a content ID for the materialized entity state without
duplicating the entity body. Fixing an entity moves its current validation head but does not erase
historical invalidity or messages.

The projection records the latest nonvalidation source position it observed.
`currentInvalid("live")` returns `current`, `stale`, or `unvalidated`; stale results retain their
last known errors rather than becoming an empty answer. Query builders such as
`currentInvalidQuery`, `everInvalidQuery`, and `violationsQuery` produce ordinary Datalog that can
be composed with application queries.

## Atomic graph constraints

The same rules can guard an operational transaction:

```ts
const constrainedWrite = Effect.gen(function* () {
  const snapshot = release.snapshot;
  const constraints = yield* GraphConstraint.collect(snapshot.root);

  yield* triples.transact(operations, {
    actor: "agent:worker-7",
    configSnapshot: snapshot.id,
    enforce: GraphConstraint.enforcement(constraints),
  });
});
```

Enforcement projects the complete post-state and checks every represented valid-time boundary,
including future-effective intervals. A new or worsened required, cardinality, uniqueness, or
reference-target violation fails with `ConstraintViolationError`; facts, journal, command receipt,
and commit position all roll back. Existing violations do not block unrelated writes or repairs.

KV, SQLite, and PostgreSQL serialize this check through the commit-position boundary, preventing
concurrent Triplex writers from both winning the same absence or uniqueness decision. Candidate
loading uses entity-type and reference-target indexes plus batched subject reads. Direct adapter
writes, unconstrained commands, authorization, and general Datalog invariants remain outside this
guarantee.

### Constraints hold at every valid instant

Enforcement does not only check "now". It evaluates each rule at every valid-time edge (each
`validFrom` and `validTo`) of the facts it loads for the affected entities, before and after the
transaction. An entity exists at an instant when any of its typed facts is valid then. At each such
instant:

- `required`: the entity must also have a valid value for each required attribute;
- `cardinality` and `unique`: the counts are taken over the facts valid at that instant; and
- reference target: the referenced entity must have a fact of the target type valid at that same
  instant.

Two modeling rules follow:

1. **All of an entity's facts share one interval.** Give every attribute of a new entity the same
   `validFrom`. If `:vendor/status` starts on 2026-03-15 but `:vendor/name` defaults to the commit
   time, the vendor exists on 2026-03-15 without a name, and a required name rule fails at that
   instant.
2. **Referenced entities must be valid from an earlier (or the same) time.** A review dated
   2026-03-01 that references a vendor whose facts start on 2026-04-01 fails the reference-target
   rule at 2026-03-01. Load the referenced entity from a `validFrom` at or before the earliest
   fact that points at it.

Assertions without `validFrom` start at the commit time, so a backdated assertion of one attribute
next to defaulted assertions of others creates exactly this gap. To change one attribute's value
from a date on, end the old value at that date and assert the new value from it in the same
transaction instead of retracting the old value outright.

`ConstraintViolationError.message` names the first two violations with their constraint key,
subject, and `validAt` (as an ISO instant). `error.violations` holds the complete list. Each entry
carries `constraintKey`, `code`, `subject`, `entityType`, `attribute`, `message`, and the `validAt`
epoch-millisecond instant at which it fails:

```ts
const write = Effect.gen(function* () {
  const triples = yield* Triples;
  return yield* triples
    .transact(operations, meta)
    .pipe(
      Effect.tapError((error) =>
        error._tag === "ConstraintViolationError"
          ? Effect.logWarning(
              error.violations.map(
                (v) => `${v.constraintKey} ${v.subject} at ${new Date(v.validAt).toISOString()}`,
              ),
            )
          : Effect.void,
      ),
    );
});
```

Validation observations remain useful for migrations and audit even when enforcement is enabled.
Applications normally resolve one pinned release, collect its rules, and pass both its
`configSnapshot` and enforcement set at the command boundary.

## Explore configuration

The repository dashboard exposes typed nodes, releases, refs, immutable object history, and impact
analysis over its demo database or a supplied SQLite/PostgreSQL database. The CLI provides the same
operator-oriented history and ref controls as stable JSON. See [CLI and
dashboard](/tools#inspect-configuration).

Continue to [Derivations](/derivations) to use a pinned configuration snapshot in explainable
derived work, or [Troubleshooting](/troubleshooting#does-moving-a-config-ref-roll-back-data) for
common release and rollback surprises.
