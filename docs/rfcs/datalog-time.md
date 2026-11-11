# RFC: valid intervals and transaction provenance in Datalog

Status: proposed, awaiting owner approval of P4.1 and D2 (P1.3). This document specifies
future behavior; none of its new query syntax is implemented. It changes query planning and
execution, not the fact model or the transaction write boundary.

## Problem and recommendation

WorldVM needs assertion interval bounds without a `history` or `match` read per entity.
[The trial](../../trials/vendor-risk/REPORT.md) finding 5 and issue #73 describe that gap.
Silent trap 1 is related: a backdated review joins its assertion transaction at a past
`validAt`, but the transaction's metadata starts at its later commit instant, so the join
silently disappears. Current workarounds are in [Datalog](../datalog.md) and
[Core concepts](../concepts.md#read-an-assertions-interval).

Recommend an explicit object pattern for interval bindings, a query-wide `validTime: "all"`
mode, and recorded-only evaluation of `:_tx/*` metadata. Keep one shared preflight and one
recorded cut across the complete query, as required by [Architecture](../../ARCHITECTURE.md).
KV and SQLite remain supported; PostgreSQL remains a pre-1.0 production candidate.

## 1. Syntax and scope

Keep `[e, a, v]` and `[e, a, v, tx]`. Add this alternative wherever a fact pattern is legal:

```ts
// Proposed grammar fragment, not a currently executable public API example.
{
  pattern: ["?exception", ":exception/status", "approved", "?tx"],
  valid: { from: "?from", to: "?to" },
}
```

`pattern` is exactly an existing three- or four-term tuple. `valid` must contain at least
one of `from` or `to`. Each field accepts a valid variable identifier or a finite,
non-negative epoch-millisecond number; `to` also accepts `null` to match an open end.
An omitted field imposes no binding or constraint. Unknown keys, empty `valid`, invalid
variables, six-term tuples, nested object patterns and invalid bound literals fail shared
schema decoding. Numeric times follow the existing timestamp domain, not commit-position
units; do not reinterpret seconds, ISO strings or `Date` objects. Do not introduce a new
integer-only time constraint in this feature. Validate concrete paired bounds with the
same interval checks as assertions.

Add `validTime?: "point" | "all"` to `DatalogQuery`, defaulting to `"point"`. A wrapped
query takes its mode from `inner`; there is no second wrapper mode. Read options continue
to carry `basis`. This is a Datalog scope, not a new mode for `entity`, `match` or history.

Alternatives considered:

| Alternative                                        | Assessment                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `[e, a, v, tx, from, to]`                          | Compact but positional, requires a transaction placeholder, and makes omissions obscure. Reject.              |
| Fourth-term metadata object                        | Overloads the established transaction position and complicates existing tuple recognition. Reject.            |
| Separate interval lookup clause                    | Needs a fact identity binding and a second relation to avoid ambiguous same-value assertions. Reject.         |
| Binding bounds implicitly disables point filtering | A projection would change relation membership; an unrelated three-term join could still hide history. Reject. |
| Object pattern plus explicit query-wide mode       | Named, extensible fields; preserves old tuples and makes all-time scope visible. Recommend.                   |

Allow object patterns in positive conjunctions, conjunctive `not` and the existing single-clause
`or` alternatives. Existing variable-safety rules still apply: negation locals do not escape,
and alternatives only filter outer bindings. Reject object interval patterns in recursive
rule bodies in this first implementation. Existing binary rules still execute in the query's
mode and can join ordinary identity endpoints; temporal endpoints are not new rule arguments.
Reject `optionalProjection` with `validTime: "all"`: choosing one of several historical values
would be ambiguous. Plain three-/four-term all-time queries remain legal without interval fields.

## 2. Temporal and value semantics

### Relation membership

At one resolved recorded cut, a pattern returns assertions recorded by that cut and not yet
retracted at that cut. Then:

- In `"point"` mode, domain assertions must satisfy `validFrom <= validAt` and
  `(validTo is absent or validAt < validTo)`. Omitted `validAt` resolves to runtime now once.
  Binding an interval does **not** remove this filter. Bounds are the assertion's complete
  stored bounds, never clipped to the point or intersected with another assertion.
- In `"all"` mode, skip the domain point filter for **every** pattern, including tuples,
  negation and rule scans. Do not resolve an implicit current valid time. An explicit
  `basis.validAt` is a preflight error with a fix to remove it or use `"point"`.
- In either mode, transaction metadata follows section 3.

All-time joins mean “these assertions coexist in the recorded view,” not “their valid intervals
overlap.” A caller requiring overlap must bind bounds and express it explicitly, accounting for
open ends. Do not synthesize intersection intervals, merge adjacent assertions, or collapse
separate periods into one. Projection retains existing distinct-row semantics: project both
bounds (and transaction where needed) to preserve distinguishable periods. Fact identity is
not added by this RFC; assertions indistinguishable in the projected fields collapse.

`recordedAt` and `recordedPosition` remain mutually exclusive public inputs. Position zero is
empty; explicit positions do not gain a wall-clock constraint. Timestamp queries and default
pages retain their existing captured position/timestamp intersection. All-time refers only to
valid time: a retracted assertion is absent at the latest recorded cut even if it once held.
Use an older recorded cut to recover the earlier belief, or history/journal APIs to enumerate
recorded changes. An interval query is not an assertion/retraction event feed.

### Open ends, predicates and types

Missing `validTo` means an interval unbounded above in the fact model. Project it as JSON `null`,
not numeric infinity, a maximum date or Effect `Option`. Infer `from` as datetime/numeric and
`to` as nullable datetime/numeric. SQL BIGINT decoding must return the same JavaScript numbers
as KV and preserve null. No bound is sealed or a text identity.

Extend predicate operands to accept literal `null`; do not make null a legal ordinary fact value
constant or identity. Define portable two-valued equality: null equals null, null differs from
a finite number, and all ordered comparisons involving null are false. Thus `["!=", "?to", null]`
selects finite ends; `["<=", "?to", cutoff]` also excludes open ends. Open-endedness does not make
`[">", "?to", cutoff]` true. This deliberately avoids infinity arithmetic and SQL UNKNOWN.
Wrapper `is-null`/`is-not-null` work on projected ends; numeric wrapper filters use the same guard.

Repeated variables impose equality within and across tuple and interval positions, irrespective
of clause order. Two open ends unify; an open end cannot unify with a start. Numeric value and
interval bindings unify by the existing number/datetime scalar family. A known string identity
used as an interval variable is a preflight type error, including transaction or binary-rule
endpoints; never cast it. Runtime mixed value families use existing guarded scalar equality.
A repeated variable constrained to both start and end can match only equal finite endpoints,
which valid nonempty assertions cannot have. Return no matches, rather than treating the terms
as independent variables. Static incompatible ordered operands fail preflight; a nullable end is
allowed and receives the runtime finite-number guard.

Bounds can appear in `find`, predicates, `having`, grouping, ordering and wrapper filters.
`count` counts distinct public bound values, including null as one distinct value. Implement
that explicitly rather than relying on SQL `COUNT(DISTINCT nullable_column)`, which omits null.
`sum`, `avg`, `min` and `max` use finite numeric inputs only, skip null, and retain input-row
multiplicity. Groups with only open ends produce null for these numeric aggregates. Existing
empty-input rules remain: ungrouped count zero and other aggregates null; grouped empty input
no rows. No aggregate computes a union or duration of intervals.

Ordering uses the existing typed total order, with finite bounds in the numeric family and open
ends in the null family, not a special infinity order. Pagination deduplicates projected rows,
completes the order with projected tie-breakers and captures one exact recorded cut. Include
`validTime`, object fields, null operands and the resolved point (only in point mode) in query
fingerprints. Reject cursor reuse across modes or changed bound filters; omitted continuation
options inherit the captured basis. Version cursors when changing their canonical representation.

### Sealed values and service boundaries

Intervals and assertion transactions are unsealed metadata. Permit binding, filtering and
projecting them on sensitive attributes using existing permitted presence/blind-equality
patterns. Do not allow a value variable to escape the sensitive layer by renaming it into an
interval field. Shared variable/type analysis must retain sealed-value taint: projection,
ordering, numeric comparisons, aggregation and reuse of a sealed value as a bound stay planning
errors. Raw engines retain blind-token-only equality and null projection of sealed values.

Schema-bound attribute validation must traverse object patterns in every permitted location,
including wrappers; reserved transaction attributes keep their existing exemption. Dependency
extraction must discover the wrapped tuple's attributes. Exact derivation provenance must reject
new interval patterns and all-time mode until it can explain them faithfully, rather than silently
ignoring new fields. This RFC does not widen its currently supported subset.

## 3. D2: transaction metadata is about recorded time

Recommend that any matched row whose attribute starts with `:_tx/` ignore valid-time filtering
and obey the query's recorded cut. This applies in positive patterns, negation, disjunction,
rules, and dynamic-attribute scans. Classification is by the matched attribute, not by whether
the entity variable happens to be named `?tx`, nor by a join-order inference. Non-reserved
attributes on the same entity retain domain semantics. Metadata interval bindings, if requested,
return stored commit-based bounds; they do not imply point membership.

This makes a backdated assertion's actor available when the recorded cut includes its commit,
without exposing future knowledge. The fourth tuple term always identifies the **asserting**
transaction, including on a corrected, re-asserted bounded fact. It never changes to the
retracting transaction. Retraction time, position and actor are not interval metadata: use the
journal or history. `temporalView.ts` already clears later retraction metadata for explicit
position reads; the new executor must similarly avoid exposing later retraction knowledge.

| D2 option                                            | Benefit                                             | Cost / recommendation                                                                                                                                                                                                                               |
| ---------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planning-time error for past `validAt` plus metadata | Loud failure, preserves uniform point filtering     | “Past” changes with the clock; without reading data the planner cannot know which metadata join is empty. Rejecting every explicit valid point is predictable but rejects legitimate audits. Safe fallback if the owner rejects the recommendation. |
| Metadata at current valid time                       | Makes most provenance joins work                    | Introduces a second business clock and can hide metadata at future commit instants under clock skew. Reject.                                                                                                                                        |
| Metadata at recorded cut only                        | One-call historical provenance with no second clock | Explicit reserved-attribute exception to uniform validity. Recommend and document it.                                                                                                                                                               |
| Keep current semantics / require two queries         | No engine change                                    | Preserves the silent trap and risks two queries observing different recorded cuts. Reject.                                                                                                                                                          |

Breaking behavior: existing three-/four-term domain queries in default mode are unchanged.
Existing queries involving `:_tx/*` can return additional rows at earlier `validAt`; negation can
remove rows and aggregates/counts can change. Dynamic-attribute queries can now include those
metadata rows too. This is an intentional semantic break, with no legacy flag. It changes Datalog
only; stored metadata intervals and direct fact-read APIs retain their existing behavior. Update
all provenance guidance and query consumers during implementation and record the break in a
publishable-package Changeset. This documentation-only RFC needs no Changeset.

## 4. Native execution and indexes

### Shared planning

Extend `packages/core/src/datalog/schema.ts`, clause discrimination, validation and type inference
as one contract. Normalize tuple/object forms to a pattern IR carrying optional bound terms.
One shared preflight must validate every query before backend execution, including `explain` and
wrapped queries. It determines temporal mode, scope safety, sealed taint and static binding types.
No backend-specific acceptance or per-entity history fallback is permitted. Core remains browser-safe.

### In-memory KV

`packages/core/src/kv/datalog/executor.ts` orders positive patterns before predicates and feeds
`pattern.ts`; that module scans `KvTripleStore` and unifies datoms. Datom META already stores
`validFrom`, nullable `validTo`, assertion position and retraction position. Split its current
`visibleAt` into recorded visibility plus row-sensitive point visibility. Keep
`includeRetracted: true` when evaluating a historical cut; do not use a live-only scan in all-time
mode and accidentally lose assertions visible before their later retraction.

Use existing EAVT for fixed entity/attribute, AEVT for attribute, AVET for attribute/value and
VAET for ref traversal. Bind bounds directly from hydrated datoms in the same scan, using batched
META `getMany` on async KV paths and the synchronous cache/path in memory. Keep the existing hash
join path for large contexts; adding bounds must not fall back to a `history(entity)` call.
Index nested-loop joins can still do scans for join contexts; the guarantee is no additional
per-entity history or per-fact metadata round trip to obtain intervals.

Existing hexastore keys do not lead with interval bounds. AEVT plus filtering is a correct fallback,
but not a selective expiry plan. The later implementation should add two history-preserving KV
indexes keyed `(attribute, finiteValidTo, tripleId)` and `(attribute, validFrom, tripleId)`.
Maintain them on assertion, retain entries on retraction, and rebuild them for existing stores
before enabling their planner path. No entry is needed in the finite-end index for open ends.
Recognize constant-attribute bound ranges and bound equalities in shared normalized predicates;
use bounded key scans, then batch META visibility checks and residual constraints. Without a
constant attribute, choose an existing prefix scan and report the residual filter honestly.
This is a fixed rule-based access-path choice, not a cost-based optimizer project.

### SQLite and PostgreSQL

The compiler lives in `packages/core/src/datalog/compiler.ts`; `packages/sql` owns migrations,
`SqlQueryExecutor`, execution and decoding. Add `validFrom`/`validTo` binding positions mapped
to `alias.valid_from`/`alias.valid_to`, including local negation bindings and hidden typed wrapper
columns. Emit guarded numeric comparisons and null-safe equality explicitly on both dialects.
Decode nullable bounds as number-or-null, including PostgreSQL BIGINT strings.

Replace the current regex-based `applyTemporalBasis` rewrite of `alias.retracted_at IS NULL`
with structured per-alias visibility generation. Every alias, including recursive CTE scans,
gets the same recorded condition. In point mode append
`(attribute is transaction metadata OR (valid_from <= point AND (valid_to IS NULL OR valid_to > point)))`.
Use a constant decision for fixed attributes and a row condition for variable attributes; escape
SQL LIKE underscores if implementing the reserved-prefix test with LIKE. All-time mode emits no
point condition. Bound projections do not change these decisions. Parameterize times and constants.

Existing `idx_attribute_history` supports attribute/recorded scans and
`idx_entity_recorded_position` supports provenance entity lookups at a cut.
`idx_attribute_temporal` leads with `valid_from` and is live-only; it cannot promise a selective
`valid_to` range at a historical position. Add non-partial indexes
`(attribute, valid_to, recorded_position)` and `(attribute, valid_from, recorded_position)`
through shared SQL migrations. Retraction visibility remains a residual condition. For expiry,
push the finite upper/lower bounds onto `valid_to` directly, avoiding COALESCE or casts on the
indexed column. All-time vendor queries use entity/attribute history access and residual visibility.
Joins and bounds run in one native SELECT/CTE query; wrapper count remains the existing optional
second statement. There is no entity history loop or hydration query for interval projection.

Require SQLite EXPLAIN QUERY PLAN and PostgreSQL EXPLAIN evidence on a large, selective fixture:
attribute plus end range uses the new end index, start ranges can use the start index, provenance
uses indexed entity lookup, and result parity holds at older recorded cuts. Small tables may
legitimately use a full scan; test meaningful cardinalities and candidate counts, not an unconditional
optimizer index-name promise. KV explain should show range keys and residual visibility filters.

Cloudflare inherits the core compiler/SQL decoder semantics and needs any shared migration plumbing
to keep compiling and passing existing tests; it is frozen and gets no new feature certification.
FoundationDB inherits the shared KV executor and datom changes. Its interval-index initialization
must either complete before use or use the correct existing prefix fallback, never an incomplete
index. Native FoundationDB performance/integration coverage is excluded from this delivery.
Neither backend requires a parallel implementation or a new support claim.

## 5. Worked queries

These are proposed query fragments, intentionally ordinary `ts` fences: the current public types
do not accept them. The implementation must turn them into checked, runnable examples.

Fixture: all dates below are midnight UTC in 2026. Let `J = Date.UTC(2026, 0, 1)`,
`F = Date.UTC(2026, 1, 1)`, `M = Date.UTC(2026, 2, 1)`,
`E = Date.UTC(2026, 2, 20)`, `C = Date.UTC(2026, 2, 31)` (M plus exactly 30 days),
`A = Date.UTC(2026, 3, 1)` and `Y = Date.UTC(2026, 4, 1)`.

| Position / commit | Actor      | Assertions (entity, attribute, value, interval)                                                                                                                                                            |
| ----------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 / Jan 5         | `user:pat` | `vendor:acme`, `:vendor/status`, `active`, `[J, F)`; same vendor/status/value `[M, open)`; `exception:one`, `:exception/status`, `approved`, `[J, E)`; `exception:open`, same attribute/value, `[J, open)` |
| 2 / Mar 10        | `user:lee` | `review:one`, `:review/status`, `approved`, `[F, A)` (backdated)                                                                                                                                           |
| 3 / Mar 12        | `user:kim` | Retract position 2's review; assert same review/status/value `[F, Y)`                                                                                                                                      |

The stored fourth-term transaction identities are `tx:1`, `tx:2`, `tx:3` respectively.
Each commit also writes ordinary reserved metadata with its actor. These are descriptive fixture
IDs; an implementation test captures actual generated IDs and receipt positions/instants.

### Exceptions expiring within 30 days

```ts
const query = {
  find: ["?exception", "?end"],
  where: [
    { pattern: ["?exception", ":exception/status", "approved"], valid: { to: "?end" } },
    [">", "?end", M],
    ["<=", "?end", C],
  ],
  orderBy: [{ variable: "?end" }],
};
const options = { basis: { recordedPosition: 3, validAt: M } };
```

Expected: `[{ "?exception": "exception:one", "?end": E }]`. The window is `(M, C]`;
point mode additionally requires the exception to be active at M. Open ends do not match.
This is one query; it needs neither two-base subtraction nor direct reads per exception.

### Who asserted the review that held on March 1?

```ts
const query = {
  find: ["?review", "?actor", "?tx"],
  where: [
    ["?review", ":review/status", "approved", "?tx"],
    ["?tx", ":_tx/actor", "?actor"],
  ],
};
const options = { basis: { recordedPosition: 2, validAt: M } };
```

Expected: `[{ "?review": "review:one", "?actor": "user:lee", "?tx": "tx:2" }]`.
March 1 precedes the March 10 commit, but the recorded cut includes it. At position 1 the result
is empty. At position 3 the row instead names `user:kim` and `tx:3`: it explains the corrected
assertion now believed to cover March 1, not the replaced assertion's author.

### Every interval a vendor was active

```ts
const query = {
  validTime: "all",
  find: ["?start", "?end"],
  where: [
    { pattern: ["vendor:acme", ":vendor/status", "active"], valid: { from: "?start", to: "?end" } },
  ],
  orderBy: [{ variable: "?start" }],
};
const options = { basis: { recordedPosition: 3 } };
```

Expected: `[{ "?start": J, "?end": F }, { "?start": M, "?end": null }]`.
No implicit current point removes the January interval. Adding `validAt: M` is an error;
switching to point mode at M returns only the second row. “Every” means every assertion interval
in this recorded view, not every superseded recorded belief.

## 6. Conformance and implementation gate

Add shared cases in `packages/testkit` and run them unchanged on KV, SQLite and PostgreSQL:

1. All three fixtures above, with generated transaction IDs, pinned positions, timestamp cuts,
   and position zero. Ordinary domain tuple queries retain their current results.
2. Bind either/both bounds, project finite numbers/null, match literal endpoints and open ends;
   reject bad keys, units/types, variables, tuple arities and invalid concrete intervals before I/O.
3. Bound projection retains point membership; all-time includes past and future intervals without
   an implicit now. Explicit all-time plus validAt fails consistently, including wrappers/explain.
4. Half-open boundaries: start included, end excluded; exact expiry window edges. Preserve disjoint
   and overlapping assertions; show that all-time joins do not impose interval overlap.
5. Repeated-variable equality within/across patterns, nullable ends, numeric value joins, statically
   incompatible identities, predicate reordering, and null equality/inequality/ordered comparisons.
6. Negation-local interval variables and predicate ordering; disjunction filters; unsafe escaping
   locals fail. Existing rules obey mode and metadata semantics; interval rule bodies and all-time
   optional projection fail loudly.
7. Distinct projection, grouping, every aggregate (including duplicate inputs, all-null ends and
   empty input), having, wrapper null/numeric filters and ascending/descending typed ordering.
8. Pagination with equal bounds and null ends, concurrent assertions/retractions, equal commit
   timestamps, explicit position without wall time, terminal pages, counts and cursor mode/basis
   mismatch. No duplicate or missing projected rows across the captured cut.
9. Backdated `_tx` joins, reordered joins, metadata through variable attributes, negation and rules;
   recorded cuts still hide future metadata. Domain attributes on a transaction entity stay point
   filtered. Assertion tx stays distinct from retract tx after corrections.
10. Sensitive presence/blind equality with interval projection succeeds; sealed value projection,
    ordering, aggregation and variable alias escape fail. Raw execution never exposes plaintext.
11. SchemaBound traversal, dependency extraction and exact-derivation rejection recognize new forms.
12. Instrumented KV batched META reads, selective index scans and SQL statement counts prove no
    per-entity history reads. Test fresh indexes, rebuild/backfill and historical retractions;
    compare indexed execution to fallback scans. Exercise SQL numeric/null decoding.

Write each implementation regression test first and observe failure before implementing it.
Require selective query plans as described above, existing frozen-backend tests, checked public
examples and updated provenance guidance. Run the root checks and package checks; the orchestrator
runs PostgreSQL integration and browser tests. This RFC changes no package source, so it adds no
executable regression test and does not claim the future syntax passes current typechecking.

## 7. Owner questions

1. **D2:** approve recorded-only semantics for every `:_tx/*` row, including variable attributes,
   and the intentional changes to negation/counts? Recommendation: yes; otherwise choose the
   predictable error on explicit point bases involving metadata, not a clock-dependent test.
2. **P4.1 / D6:** approve the object pattern and query-wide all-time scope, with explicit validAt
   rejected in that scope? Recommendation: yes; keep implicit now only for point queries.
3. Approve null as the public open-end representation and finite-only ordered predicates, with
   null-safe equality and distinct-count semantics stated above? Recommendation: yes.
4. Approve interval access-path indexes and existing-store rebuild/migrations as part of the later
   implementation, while leaving interval rule bodies and all-time optional projection rejected?
   Recommendation: yes; ship the three target backends together before enabling the feature.

No question reopens the settled Effect-only, greenfield, browser-safe or backend policy. Owner
approval gates implementation; this item delivers only the RFC.
