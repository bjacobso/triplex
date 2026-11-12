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
  name: EmployerName.required().unique(),
});

// A bare attribute is an optional, single-valued use.
export const EmployerSummary = EntityType.make("EmployerSummary", { name: EmployerName });

export const Employment = EntityType.make("Employment", {
  employer: Attribute.ref(":employment/employer", Employer).required(),
});

const validFrom = Date.now();
Employer.attributes.name.key; // ":employer/name"
Employer.attributes.name.assertion("Acme", { validFrom });
Employment.attributes.employer.assertion(EntityId.make("employer:acme"), { validFrom });
```

Attribute constructors fix the stored value type:

| Constructor         | TypeScript input   | Stored as  | Datalog projects | Ordered `<` `>`? | Use for                                            |
| ------------------- | ------------------ | ---------- | ---------------- | ---------------- | -------------------------------------------------- |
| `Attribute.text`    | `string`           | `string`   | string           | No               | Names, free text                                   |
| `Attribute.number`  | `number`           | `number`   | number           | Yes              | Quantities, scores                                 |
| `Attribute.integer` | `number`           | `number`   | number           | Yes              | Counts                                             |
| `Attribute.boolean` | `boolean`          | `boolean`  | boolean          | No               | Flags                                              |
| `Attribute.date`    | `string`           | `string`   | string           | No               | Calendar dates you display, such as `"2026-03-15"` |
| `Attribute.instant` | `number` or `Date` | `datetime` | epoch ms number  | Yes              | Times you compare, sort, or expire                 |
| `Attribute.enumOf`  | one of the values  | `string`   | string           | No               | Closed sets such as statuses                       |
| `Attribute.ref`     | `EntityId`         | `ref`      | string ID        | No               | Relationships to another entity type               |

`date` is a calendar string, so ordered Datalog predicates (`<`, `<=`, `>`, `>=`), which are
numeric-only, cannot compare it. Use `instant` for any time you compare or expire. When a date says
when the fact itself holds, prefer the assertion's `validFrom` and `validTo` over either attribute.

A handle's `assertion(value, { validFrom, validTo })` returns `{ attribute, value, validFrom?,
validTo? }`, ready to spread into an `assert` operation next to `op`, `entityId`, and `entityType`.
Both options are epoch milliseconds and describe the half-open valid interval `[validFrom, validTo)`;
omit `validFrom` to start at the commit time and omit `validTo` for an open-ended fact. A non-finite
value, or a `validTo` that is not later than `validFrom`, throws.

Requiredness is not inherently true of `:employer/name`; it is true of the way `Employer` uses the
attribute. Reference attributes follow the same separation.

`.required()`, `.many()`, and `.unique()` describe a use and chain in any order:
`.required().unique()`, `.unique().many()`, or `.many().required()`. Each call returns a new use,
preserving the other constraints and leaving the original unchanged. Inspect a use with
`isRequired`, `cardinality`, and `isUnique`; entity handles retain `required`, `cardinality`, and
`unique` data fields.

The first modifier on a definition also accepts the remaining options, for example
`.required({ unique: true })` or `.many({ required: true })`. These and
`Attribute.use(attribute, options)` produce the same configuration content IDs as chaining.
Declare entity types with `EntityType.make(name, fields)`, passing aliased fields directly.

`Employer.nodes` yields the independently identified attribute definitions followed by the entity
schema. Use `EntityType.nodesOf(Employer, EmployerSummary, Employment)` to publish several types
together: it deduplicates shared attribute nodes by content ID before `ConfigStore.commit`.
`Employer.constraints` yields independently content-addressed required, cardinality,
uniqueness, and reference-target rules.

## Reading typed entities

`Type.decode(facts, options?)` returns an Effect that turns visible facts into an object
keyed by the declaration's aliases. Read the desired temporal basis first; the decoder does
not filter historical or retracted facts itself.

```ts check
import { Effect } from "effect";
import { EntityId, Triples } from "@triplex-build/triplex";
import { Attribute, EntityType } from "@triplex-build/triplex/config";

const Worker = EntityType.make("Worker", {
  name: Attribute.text(":worker/name").required(),
  roles: Attribute.text(":worker/role").many(),
  joined: Attribute.instant(":worker/joined"),
});

export const readWorker = Effect.gen(function* () {
  const triples = yield* Triples;
  const facts = yield* triples.match(
    { entityId: EntityId.make("worker:maria") },
    { validAt: Date.UTC(2026, 0, 1) },
  );
  const decoded = yield* Worker.decode(facts, { withFacts: true });
  // name is present; roles is an array; joined may be undefined.
  // Sealable values also admit a {$sealed: {valueType, keyId}} marker.
  const name = decoded.values.name;
  if (typeof name === "string") console.log(name);
  // Original facts include IDs and intervals for Worker.replace/end/correct.
  return { values: decoded.values, nameFacts: decoded.facts.name };
});
```

Optional scalar aliases decode to `undefined` when absent; cardinality-many aliases always
return readonly arrays, including `[]` when absent. Required aliases must have at least one
fact unless `{ allowPartial: true }` is passed, which also makes required scalar types admit
`undefined`. Two visible facts for a scalar alias fail even if their values are equal.
Cardinality-many values are deduplicated and sorted by canonical identity, so their order
need not match assertion order. Instants decode to epoch-millisecond numbers, including when
written with a `Date`; calendar dates remain strings, enums retain their literal union, and
references retain `EntityId`.

All facts must have the declared entity type and belong to one entity. Incompatible stored
values, missing required aliases, and ambiguous scalar aliases produce typed
`EntityType.EntityDecodeError` failures with a `reason` and optional `alias`.
An empty input is a missing entity body: it fails if required aliases exist, otherwise it
decodes to empty arrays and undefined scalars. The decoder cannot distinguish a nonexistent
entity from an entity with no visible facts.

Undeclared attributes are ignored by default. `{ unknownAttributes: "reject" }` rejects them;
`{ withFacts: true }` returns `{ values, facts, unknownFacts }` with original facts grouped by
alias and undeclared facts separately. Metadata preserves every supplied fact, including
multiple facts that decode to the same many-value.

A sealed stored value always becomes a marker containing only its value type and key ID,
even if the declaration no longer marks it sensitive. For this reason sealable output types
include `EntityType.SealedMarker`; narrow them before using plaintext. Sensitive attributes
with unsealed stored values fail. Opening stays an explicit `Sensitive.open` call on the
original facts; the decoder never opens values. Metadata contains those original facts,
including their sealed envelopes when present, so use `values` as the display object.

## Writing entities

`Type.assert(id, values, options?)` turns attribute values, keyed by the TypeScript aliases, into
`assert` operations tagged with the entity type. Values are typed by their attribute, and a
cardinality-many use takes an array, so `trainedFor: [harbor]` asserts one fact per element.
Every alias is optional and `undefined` is skipped: requiredness is a property of the entity's
state after the transaction, which `enforce` checks atomically, not of each write. `validFrom` and
`validTo` set the half-open business-time interval `[validFrom, validTo)` on every operation; call
`assert` more than once when facts hold for different intervals.

`GraphConstraint.pinned(release)` returns the `configSnapshot` and `enforce` metadata for one
release, so a write records and enforces the same rules:

```ts check
import { Effect } from "effect";
import { EntityId, Triples } from "@triplex-build/triplex";
import { Attribute, ConfigStore, EntityType, GraphConstraint } from "@triplex-build/triplex/config";

const Site = EntityType.make("Site", { name: Attribute.text(":site/name").required() });

const Worker = EntityType.make("Worker", {
  name: Attribute.text(":worker/name").required(),
  trainedFor: Attribute.ref(":worker/trained-for", Site).many(),
});

const harbor = EntityId.make("site:harbor");
const maria = EntityId.make("worker:maria");
const training = { validFrom: Date.UTC(2026, 2, 1), validTo: Date.UTC(2026, 5, 1) };

export const onboard = Effect.gen(function* () {
  const triples = yield* Triples;
  const release = yield* (yield* ConfigStore.ConfigStore).resolveRef("live");
  if (release === undefined) return yield* Effect.die("no live release");
  return yield* triples.transact(
    [
      ...Site.assert(harbor, { name: "Harbor" }),
      ...Worker.assert(maria, { name: "Maria" }),
      ...Worker.assert(maria, { trainedFor: [harbor] }, training),
    ],
    { actor: "user:hr", commandId: "onboard:maria", ...(yield* GraphConstraint.pinned(release)) },
  );
});
```

Single-attribute handles remain available for hand-built operations:
`Worker.name.assertion("Maria", { validFrom, validTo })` returns the `attribute`, encoded `value`,
and valid-time fields to spread into an `assert` operation.

## Querying by alias

`Type.where(entity, patterns)` returns one Datalog pattern clause per alias, and `Type.not(entity,
patterns)` returns a `not` clause over them. Values are variables or constants typed by the
attribute; reference constants become typed `ref` constants, so they match exactly. A
cardinality-many attribute matches one value per pattern.

```ts
const untrained = {
  find: ["?worker", "?site"],
  where: [
    ...Placement.where("?placement", { worker: "?worker", site: "?site" }),
    Worker.not("?worker", { trainedFor: "?site" }),
  ],
};
```

The clauses are ordinary Datalog, so they combine with raw patterns, predicates, and rules.
Datetime, JSON, and blob values are not Datalog constants; bind them to a variable and compare
with a predicate.

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
