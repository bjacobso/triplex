# Configuration releases and rollback

This walkthrough defines a typed course schema, publishes two immutable releases, promotes them
through refs, pins operational writes to the actual returned snapshot IDs, inspects history, and
rolls `live` back. It uses the in-memory layer so the whole program is executable from a source
checkout.

For the underlying node, revision, compatibility, validation, and enforcement contracts, see the
[configuration reference](/configuration).

## Complete runnable example

From the repository root, run:

```sh
pnpm exec tsx --tsconfig docs/snippets/tsconfig.json docs/snippets/config-versioning.ts
```

<<< @/snippets/config-versioning.ts{ts}

The two snapshot values in the output are real IDs returned by `ConfigStore.commit`; never copy a
made-up `sha256-…` placeholder into transaction metadata. The exact hashes are deterministic for
this history, but application code should treat them as opaque.

The stable outcomes are:

- `testBeforePromotion` and `historicalV2` are `courses-2026.2`;
- the change list contains the added `:course/status` attribute and changed `Course` schema;
- `v2WritePin` equals the returned v2 snapshot ID;
- after rollback, `liveAfterRollback` is `courses-2026.1`; and
- `advancedFactsAfterRollback` is still `2`.

## 1. Define typed schema objects

`Attribute` owns a global keyword and value type. `EntityType` owns how that attribute is used by
one entity type. Adding `status` as required changes the `Course` entity schema in v2 without
changing the identity or definition of `:course/title`.

`CourseV1.nodes` and `CourseV2.nodes` each evaluate to the complete configuration nodes needed by
that schema, including generated graph-constraint nodes nested under the entity schema. A commit
takes a complete object set, not a patch against the previous release.

## 2. Publish without promoting

Passing `ref: "test"` commits the release and moves `test` in the same atomic Triplex transaction.
The example does not point `live` at arbitrary authoring state: it calls `setRef("live",
v1.snapshot.id)` with the exact ID returned by the successful commit.

The v2 commit moves only `test`, so `live` remains on v1 during inspection. `resolveRef("test")`
returns the immutable snapshot behind the current pointer. A deployment tool can inspect that
snapshot and its changes before promotion.

## 3. Promote and pin writes

Promotion is another `setRef` call. Moving a ref copies no configuration, and compare-and-retract
prevents a stale concurrent writer from silently replacing a newer ref target.

The operational transactions use:

```ts
{
  configSnapshot: v2.snapshot.id,
  enforce: GraphConstraint.enforcement(CourseV2.constraints)
}
```

The snapshot pin records which rules governed the command. `enforce` is separate and opt-in: a
snapshot ID in metadata does not itself turn constraints on. In a long-running host, resolve the
intended ref once at the command boundary, collect constraints from that immutable snapshot when
the TypeScript handles are not already present, and use that same snapshot and rule set throughout
the transaction.

## 4. Inspect an older release

`snapshotById(id)` resolves an immutable historical release whether or not a ref still points to
it. `load()` exposes the reference store model, and
`InMemoryConfigStore.changesBetween(state, from, to)` reports added, removed, and changed logical
objects. The detailed reference also exposes node-level Merkle diffs, revision history, reverse
dependencies, and impact candidates.

The CLI and dashboard provide operator views over the same records. See [CLI and
dashboard](/tools#inspect-configuration) for commands that list releases, resolve a ref, inspect one
object's immutable history, and move a ref.

## 5. Understand rollback

The final `setRef("live", v1.snapshot.id)` is a configuration rollback. It changes what future
code resolving `live` sees. It does **not**:

- retract or rewrite facts written while v2 was live;
- change the `configSnapshot` stored on earlier transaction receipts;
- delete v2, its object revisions, or its dependency graph;
- transform data so it conforms to v1; or
- reverse external work already performed by the host.

That is why the v2 course still has two operational facts after rollback and its receipt still
points to v2. Data migration, compensating commands, validation, and external side-effect recovery
are separate host-owned operations. Plan them explicitly when a configuration change alters what
old or new data means.

## Durable version

For persistence, compose `ConfigStore.layer` over one shared SQLite or PostgreSQL `Triples` layer.
Do not create separate database layers for operational facts and configuration if they must share
an atomic boundary:

```ts
const AppLayer = ConfigStore.layer.pipe(
  Layer.provideMerge(SqliteTriples.layer({ filename: "./triplex.db" })),
);
```

This is a focused composition fragment; imports and the complete in-memory program appear above.
See [Getting started](/getting-started#use-durable-sqlite) and [Host
integration](/host-integration) for runtime and migration choices.
