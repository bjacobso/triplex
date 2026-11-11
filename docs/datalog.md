# Datalog

Triplex exposes bounded Datalog pages through `Triples.query` and a wrapped form through
`Triples.queryPage`. Both default to 100 bindings and allow at most 1,000 per page. The in-memory KV and SQL engines share one schema, semantic preflight, result
identity, ordering contract, and bitemporal basis.

If facts, relationships, or the two time axes are new, read [Core concepts](/concepts) first. A
Datalog clause is a pattern over `(entity, attribute, value)`. Reusing a `?variable` joins clauses;
the `find` list selects the bindings returned to the caller. For example, joining a worker's
placement site to a certificate site answers whether the same relationship exists—not merely
whether either entity has some site fact.

## Query shape

For release-bound attribute checking, install `SchemaBound.layer` from the config subpath.
It checks constant attributes in patterns, negation, every disjunction alternative, rules, and
wrapped queries before `query`, `queryAll`, `queryPage`, `explain`, `explainPage`, and constant
attribute `match` reads. Unknown keys fail with `UnknownAttributeError` including `key`, `path`,
and a nearby spelling in `suggestion` when available; `match` exposes it through `ReadError.cause`.
Variable attributes are skipped. Reserved `:triplex/*` and `:_tx/*` keys remain legal.

```ts check
import { Layer } from "effect";
import { KvTriples } from "@triplex-build/triplex";
import { ConfigStore, SchemaBound } from "@triplex-build/triplex/config";

const storage = KvTriples.layer;
const config = ConfigStore.layer.pipe(Layer.provideMerge(storage));
const bound = SchemaBound.layer({ ref: "live" }).pipe(Layer.provideMerge(config));
```

Commit a release with `ConfigStore.commit({ label, objects, ref: "live" })` before using bound
reads. The default ref is `"live"`; it is resolved per call, so moving it changes which attributes
are legal. A missing ref fails with `DatalogError` (`ReadError.cause` for `match`). Keep `ConfigStore`
built over the underlying storage as above. Without this layer, unknown attributes retain the
ordinary empty-result behavior.

```ts
const program = Effect.gen(function* () {
  const triples = yield* Triples;
  const { results } = yield* triples.query({
    find: ["?name", "?age"],
    where: [
      ["?person", ":person/name", "?name"],
      ["?person", ":person/age", "?age"],
      [">=", "?age", 30],
    ],
  });

  return results;
});
```

`results` is an array of binding objects whose keys retain the `?` prefix. A three-element pattern
is `[entity, attribute, value]`. An optional fourth element binds the assertion transaction:

```ts
const program = Effect.gen(function* () {
  const triples = yield* Triples;
  const { results } = yield* triples.query({
    find: ["?name", "?actor"],
    where: [
      ["?person", ":person/name", "?name", "?tx"],
      ["?tx", ":_tx/actor", "?actor"],
    ],
  });

  return results;
});
```

Transaction facts (`:_tx/*`) are ordinary facts on the `_Transaction` entity, and their valid
time starts at the commit instant. A query whose basis sets `validAt` before the commit therefore
finds no `:_tx/*` facts for that transaction, and a provenance join like the one above returns `[]`
even though the joined fact was valid at that time. To ask "what was true then, and who asserted
it", run two queries:

```ts
const program = Effect.gen(function* () {
  const triples = yield* Triples;
  // 1. The domain state at the past valid time, with the asserting transaction.
  const { results: state } = yield* triples.query(
    {
      find: ["?person", "?name", "?tx"],
      where: [["?person", ":person/name", "?name", "?tx"]],
    },
    { basis: { validAt: pastInstant } },
  );
  // 2. Provenance at the current basis, where every committed transaction is visible.
  const { results: actors } = yield* triples.query({
    find: ["?tx", "?actor"],
    where: [["?tx", ":_tx/actor", "?actor"]],
  });

  return { state, actors };
});
```

`Triples.transaction(txId)` and `Triples.transactionsForEntity(entityId)` read the same envelope
without a valid-time basis. Recorded time still applies: a `recordedAt` before the commit hides both
the fact and its transaction.

The `?` prefix is reserved for variables. Entity, attribute, transaction, and rule identity
positions accept string literals or variables. Malformed runtime input and unsupported programs
fail with typed `DatalogValidationError` or `UnboundVariableError` before either backend runs.

## Values and equality

Stored facts retain seven value types: string, number, boolean, datetime, ref, JSON, and blob.
Datalog projects their public scalar values:

- numbers and datetimes project as numbers;
- strings and refs project as strings;
- booleans remain booleans;
- JSON projects as canonical JSON text; and
- blobs project their content identity.

A bare scalar pattern constant uses public scalar equality. Use a typed constant when storage type
matters:

```ts check
import { EntityId, ref } from "@triplex-build/triplex";

const query = {
  find: ["?movie"],
  where: [["?movie", ":movie/director", ref(EntityId.make("person:nolan"))]],
};
```

A `{ type: "blind", value }` typed constant matches a sealed value by its blind-index token.
Applications normally write plaintext constants and let the
[sensitive values](/sensitive-values) layer rewrite them. That layer also rejects projecting,
ordering, comparing or aggregating sensitive attributes during planning.

Numeric-looking strings and identity values are never guessed into numbers. Equality preserves the
same public scalar families through patterns, joins, predicates, negation, disjunction, grouping,
distinctness, and pagination.

## One temporal basis

Pass a basis as query options:

```ts
const historicalQuery = Effect.gen(function* () {
  const answer = yield* triples.query(query, {
    basis: {
      recordedAt: auditInstant,
      validAt: businessInstant,
    },
  });

  return answer;
});
```

Omitted recorded time means the latest recorded state. Omitted valid time means the runtime's
current business time. Every pattern, join, negation, and rule in the query sees the same cut.

Use `basis: { recordedPosition: receipt.position, validAt: businessInstant }` to
read an exact commit cut, including across joins, rules, and negation. This works
with `query`, `queryAll`, and `queryPage`, as well as `entity`, `entities`, `match`,
and `entityPage`. Do not supply `recordedAt` with `recordedPosition`.

Pages retain the requested cut in their cursor, and reject reuse with a different
position. A requested position beyond the current head is capped at that head for
pagination so later pages cannot gain new commits. Omit the basis on continuation
to reuse the captured cut. Explicit position pages do not add a wall-clock filter;
their entity-page snapshot therefore omits `recordedAt`. Existing timestamp-based
and default pages keep their timestamp and position snapshots.

## Predicates and clause order

Comparison clauses use `>`, `>=`, `<`, `<=`, `=`, and `!=`:

```ts
where: [
  ["?person", ":person/age", "?age"],
  [">=", "?age", 30],
];
```

Ordered predicates are numeric-only; number and datetime facts share that family. Text and
identity values use equality or inequality. Incompatible equality is false and incompatible
inequality is true rather than depending on backend casts.

Conjunction is declarative. Positive patterns establish outer bindings before predicates,
negation, and disjunction regardless of their written order. Patterns inside a conjunctive `not`
establish its local bindings before local predicates run.

## Negation and disjunction

```ts
const activePeople = {
  find: ["?person"],
  where: [
    ["?person", ":person/name", "?name"],
    ["not", ["?person", ":person/status", "inactive"]],
  ],
};

const namedAliceOrBob = {
  find: ["?person"],
  where: [
    [
      "or",
      [
        ["?person", ":person/name", "Alice"],
        ["?person", ":person/name", "Bob"],
      ],
    ],
  ],
};
```

`not` takes one or more clauses. With several, it is conjunctive: it excludes a binding only when
all of its clauses match together, like `NOT EXISTS` over a join. Its clauses are patterns or
predicates, at most eight of them. Variables that appear only inside the `not` are local to it;
every variable it shares with the rest of the query must be bound by a positive pattern outside it:

```ts
// Vendors with no completed review: excludes ?vendor only when one review both
// references it and is complete.
const unreviewed = {
  find: ["?vendor"],
  where: [
    ["?vendor", ":vendor/name", "?name"],
    ["not", ["?review", ":review/vendor", "?vendor"], ["?review", ":review/complete", true]],
  ],
};
```

There is no `and` clause. The top-level `where` list is already a conjunction, and
`["not", ["and", ...]]` is written `["not", clause1, clause2]`.

Each `or` alternative is a single clause: one pattern, one predicate, or one `not` (which may itself
hold several clauses). Alternatives filter bindings that the rest of the query establishes; they do
not bind new variables for `find`. A multi-clause branch such as `["or", [[c1, c2], [c3]]]` is not
supported and fails preflight with a message naming the alternative. To express "c1 and c2, or c3",
use one of these:

- negate the complement with a conjunctive `not`, when the alternatives are absence checks; or
- run one query per alternative and union the results in host code.

Unsafe negation, empty disjunctions, and unbound projections fail during shared preflight.

## Aggregation and ordering

Aggregate clauses are `[operation, source, target]`. Supported operations are `count`, `sum`,
`avg`, `min`, and `max`:

```ts
const countTasks = Effect.gen(function* () {
  const result = yield* triples.query({
    find: ["?status", "?count"],
    where: [
      ["?task", ":task/status", "?status"],
      ["?task", ":task/owner", "?owner"],
    ],
    aggregate: [["count", "?task", "?count"]],
    having: [[">", "?count", 1]],
    orderBy: [{ variable: "?count", direction: "desc" }],
    limit: 20,
  });

  return result;
});
```

Grouping is implicit over non-aggregate projected variables. `count` counts distinct public source
values. The other numeric aggregates retain duplicate input rows. Ungrouped empty input returns
one row with count zero and the other aggregates `null`; grouped empty input returns no rows.

Aggregate and optional-projection targets must appear in `find`. `having` and `orderBy` may refer
only to result bindings. Invalid target collisions and nonnumeric aggregate comparisons are typed
preflight failures.

## Snapshot-stable pagination

Ordinary queries return a cursor too:

```ts
const query = {
  find: ["?person", "?name"],
  where: [["?person", ":person/name", "?name"]],
} as const;

const pages = Effect.gen(function* () {
  const first = yield* triples.query(query, { pageSize: 50 });
  const second = first.nextCursor
    ? yield* triples.query(query, { pageSize: 50, cursor: first.nextCursor })
    : undefined;
  return { first, second };
});
```

Use the same query and page size for continuation. Omitted temporal fields inherit the original
page's basis. `query.limit` and `query.offset` define the total logical subset; `options.pageSize`
pages that subset without changing its membership. `queryPage` exposes separate wrapper filters,
ordering, page size, and optional total count:

```ts
const request = {
  inner: {
    find: ["?person", "?name"],
    where: [["?person", ":person/name", "?name"]],
  },
  orderBy: [{ variable: "?name", direction: "asc" }],
  limit: 50,
} as const;

const pages = Effect.gen(function* () {
  const first = yield* triples.queryPage(request);
  const second = first.nextCursor
    ? yield* triples.queryPage({ ...request, cursor: first.nextCursor })
    : undefined;

  return { first, second };
});
```

Triplex completes the requested order with deterministic tie-breakers and pins the first page's
exact recorded commit position. Later assertions and retractions cannot move rows between pages.
The opaque cursor is versioned and bound to the canonical query, wrapper filters, complete order,
temporal basis, and database scope. Malformed or cross-query/scope reuse fails with
`PaginationCursorError`.

The total order is numbers/datetimes, booleans, text-family values, then null. Direction applies
within a family. Applications should treat cursors as short-lived capabilities and never decode or
edit them.

Queries with joins, negation, disjunction, optional projections, aggregation, and recursive rules
all support this pagination contract. Constant-only projections form at most one distinct row and
return a terminal page. `includeCount` defaults to false because it evaluates an additional full
count query.

### Migrating complete reads

`Triples.query` now returns the first page instead of an unbounded array. Callers must follow
`nextCursor` to process further pages. Trusted batch operations that explicitly require complete
results can use `triples.queryAll(query, options)`, which retains the previous raw-query semantics.
Core configuration discovery and derivation evaluation use that explicit API to preserve complete
results. `Triples.queryPage` without a limit is now bounded too.

Pagination bounds result transfer, not necessarily database work. See the
[Datalog performance investigation](datalog-performance.md) for measured SQLite/PostgreSQL plans,
timings, and the remaining low-level fact-read audit.

## Recursive rules

Triplex supports a deliberately bounded binary recursive form:

```ts
const ancestors = Effect.gen(function* () {
  const { results } = yield* triples.query({
    find: ["?ancestor"],
    where: [["ancestor", "person:alice", "?ancestor"]],
    rules: [
      { name: "ancestor", body: [["?x", ":parent", "?y"]] },
      {
        name: "ancestor",
        body: [
          ["?x", ":parent", "?z"],
          ["ancestor", "?z", "?y"],
        ],
      },
    ],
  });

  return results;
});
```

Same-named definitions union. SQL compiles them to recursive CTEs; KV evaluates them to a
deduplicated fixpoint. Rule endpoints are string identities, repeated variables unify as equality
constraints, and `maxDepth` is a positive safe integer. Unsupported recursive bodies fail during
preflight rather than receiving different interpretations from different backends.

## Dependency discovery

The subscriptions and derivation modules statically discover fixed attributes from Datalog.
`SubscriptionManager.checkAffected` reports queries that may need recomputation; it is not an
automatic live-query runtime. `Triples.dependencyState` returns the latest assertion/retraction
position and earliest recorded future valid-time edge for a fixed attribute set.

Exact derivation provenance has a narrower contract than the query engine. It currently accepts
patterns, predicates, and negation, and rejects rules, disjunction, aggregation, pagination,
dynamic attributes, and transaction-binding clauses when it cannot preserve a complete source
explanation. See [Derivations](derivations.md).
