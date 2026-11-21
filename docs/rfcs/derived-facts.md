# RFC: derived facts that retract themselves

Status: proposed, awaiting owner approval. This is a design, not an implemented API. It changes
no package source or public exports. Incremental matching (Rete or differential), rule salience
and accumulators are out of scope.

## 1. Problem

Triplex already has most of a forward-chaining rules engine. Facts are the working memory,
Datalog does the matching, `Derivation.make` and `evaluate` turn matches into candidates with
exact source provenance, `reconcile` diffs candidate sets, and Materialization and the
[runner](../runner.md) deliver those diffs durably, including at temporal boundaries.

Two pieces are missing.

1. **A derivation cannot write its results back as ordinary facts that disappear when their
   support does.** Today a host that wants `:worker/needs-training` as a real fact writes an
   `onDiff` handler: assert on `added`, find and retract the right fact on `removed`, retract
   and re-assert on `changed`, and keep enough bookkeeping to know which facts it wrote. The
   [compliance host](https://github.com/bjacobso/triplex/tree/main/examples/compliance-host)
   runs the same added, removed and changed lifecycle by hand for its requirement occurrences.
   Every host that wants derived facts repeats it, and each copy can drift (a missed `changed`,
   a retraction that erases history instead of ending it, a handler that also writes facts users
   can edit).
2. **Chained derivations settle one runner batch per hop.** If rule B reads the facts rule A
   writes, a commit that changes A's inputs is followed by a runner batch that writes A's
   output, a second commit, a second batch for B, and so on. Readers see every intermediate
   state, and a chain of N hops costs N commits and N handler round trips.

Why this matters to Triplex users, independent of any one host: derived facts are what make a
fact database usable as a working rules engine. Once a conclusion is a fact, everything Triplex
already offers applies to it: Datalog joins, entity reads, history and `asOf`, live queries,
runner registrations, graph constraints, commit validators and `why`. Query-time derivation
(Datalog rules or a repeated query) gives none of those.

Clara Rules calls the first piece `insert-logical`: a fact inserted by a rule's right-hand side
is retracted automatically when the rule's left-hand side stops matching (truth maintenance).
This RFC proposes the Triplex form of that, plus the smallest fixpoint that makes chains settle
inside one commit.

## 2. Recommendation

Add **logical rules**: a derivation definition plus a data-only template that says which facts
each candidate supports. A runtime-wide layer, built like `CommitValidation.layer`, runs a new
**derivation stage** inside every application transaction, after the command's operations are
applied and before `enforce`, the journal entry and commit validators. The stage evaluates the
affected rules against the in-progress state, in dependency order, and appends the assertions
and ends needed to make each rule's owned attributes equal its current output. Those writes are
part of the same transaction: one journal entry, one commit position, the same command ID.

Rules may not form cycles, so one ordered pass is the fixpoint. Time-driven changes (a supporting
fact starts or expires without a commit) are applied by a maintenance commit at the boundary
instant, scheduled by the runner's existing boundary timer.

### API sketch

Proposed contract fragments, deliberately ordinary `ts` fences. Implementation must add checked
examples against public exports. Names are open (section 9).

```ts
import * as Derivation from "@triplex-build/triplex/derivation";

const makeRules = Effect.gen(function* () {
  const needsTraining = yield* Derivation.make({
    name: "worker.needs-training",
    configSnapshot: release.snapshot.id,
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
  const siteHasGap = yield* Derivation.make({
    name: "site.has-training-gap",
    configSnapshot: release.snapshot.id,
    identity: ["?site"],
    query: {
      find: ["?site"],
      where: [["?worker", ":worker/needs-training", "?site"]], // reads rule 1's output
    },
  });
  return yield* Derivation.Logical.rules([
    Derivation.Logical.rule(needsTraining, {
      emit: [
        { entity: "?worker", attribute: ":worker/needs-training", value: "?site", type: "ref" },
      ],
    }),
    Derivation.Logical.rule(siteHasGap, {
      emit: [{ entity: "?site", attribute: ":site/has-training-gap", value: true }],
    }),
  ]);
});

// `rules` is the result of makeRules. Every application transaction through this layer
// maintains the derived facts.
const Store = Derivation.Logical.layer(rules).pipe(Layer.provide(SqliteTriples.layer(options)));
```

```ts
interface Emit {
  readonly entity: string; // an output variable bound to an entity ID, or a constant ID
  readonly attribute: string; // constant; the rule owns this attribute
  readonly value: string | Constant; // an output variable or a constant
  readonly type?: TripleValue["type"]; // defaults from the bound value's Datalog type
  readonly entityType?: string;
}
interface Rule {
  readonly definition: Derivation.Definition;
  readonly emit: readonly Emit[];
  readonly id: ContentId; // binds definition ID and canonical emit templates
}
interface Rules {
  readonly rules: readonly Rule[]; // topologically ordered
  readonly owned: ReadonlyMap<string, readonly string[]>; // attribute -> rule names
  readonly id: ContentId; // the rule set identity
}

declare const Logical: {
  readonly rule: (definition: Derivation.Definition, options: { emit: readonly Emit[] }) => Rule;
  readonly rules: (rules: readonly Rule[]) => Effect.Effect<Rules, LogicalRuleError>;
  /** Decorates a backend like `CommitValidation.layer`. */
  readonly layer: (rules: Rules) => Layer.Layer<Triples, never, Triples>;
  /** Bring stored derived facts in line with `rules` and record `rules.id` as active. */
  readonly rebuild: (triples: TriplesService, rules: Rules) => Effect.Effect<TransactionResult, ...>;
};
```

With these two rules, one commit that creates a placement for an untrained worker records the
placement, `:worker/needs-training`, and `:site/has-training-gap` at the same position. The commit
that records the training ends both derived facts at that instant. No handler is involved.

## 3. Semantics

### Ownership

Each emitted attribute is **owned** by the rules that emit it. Owned attributes are written only
by the derivation stage:

- An application `assert`, `retract` or `retract-pattern` that touches an owned attribute fails
  with a typed `DerivedAttributeWriteError` before any validator runs.
- Reads are unrestricted. Derived facts are ordinary facts to Datalog, entity reads, history,
  `asOf`, live queries, the runner, constraints and validators.
- Derived facts carry `createdBy: "triplex/derived:<rule name>"` so a reader can see where one
  came from without a lookup.

Ownership is per attribute, not per fact. A user cannot assert a value that a rule also derives
on the same attribute; model that as two attributes and union them in the reading query. This
keeps ownership visible in the schema and avoids a hidden support table (section 8, D).

### Truth maintenance

For each owned attribute, the stage computes the **desired set**: the union, over every owning
rule, of `(entity, attribute, value)` produced by that rule's emit templates for each current
candidate. It compares it with the **live set**, the facts on that attribute visible at the
stage's valid instant, matched by entity, attribute and canonical value.

- Desired and not live: assert with `validFrom` at the stage instant and no `validTo`.
- Live and not desired: end the fact at the stage instant with the existing `Change.end`
  semantics (retract, then re-assert with `validTo`), so past valid time keeps the conclusion. If
  the fact began at that same instant it is retracted outright, because it was never valid for
  any interval.
- Both: no write.

Several candidates or rules supporting the same fact produce one fact, which ends only when the
last support goes. This is Clara's support counting, computed by re-evaluation rather than kept
as counters. A candidate whose output changes ends the old value and asserts the new one.

### Which rules run

A rule runs when its definition's fixed dependency attributes intersect the attributes changed
so far in this transaction, counting the command's changes and the derived changes made earlier
in the pass. Unrelated commits pay nothing beyond the attribute check. Each run is the existing
`Derivation.evaluate` against the in-progress view at the stage basis, so rule results and
provenance are identical to what `evaluate` returns for the committed state.

### Fixpoint: one stratified pass

`Logical.rules` builds the attribute graph (a rule reads its dependency attributes and writes its
owned attributes) and rejects any cycle, including a rule reading its own output, with a typed
`LogicalRuleError` naming the cycle. It then orders the rules topologically. Because no rule can
affect an earlier one, one pass in that order reaches the fixpoint: every rule runs at most once
per transaction. Negation over another rule's output is allowed, since stratification guarantees
the negated attribute is final before it is read.

Recursion through derived attributes is out of scope. A rule can still use transitive closure
inside its own query once derivations accept the bounded recursive Datalog form.

### Position in the transaction

The stage inserts one step into the [commit-validator ordering](../commit-validators.md#ordering):

1. Enter the serialized boundary; check reserved namespaces, inputs and owned-attribute writes.
2. Claim the command ID and allocate the commit position.
3. Check preconditions.
4. Apply the command's operations.
5. **Derivation stage**: evaluate affected rules in order, applying each rule's derived writes
   before the next rule reads.
6. `enforce` over the command's and the stage's operations together.
7. Write one journal entry with every change.
8. Commit validators. `commit.changes` and `commit.after` include the derived changes.
9. Commit.

This keeps the reasons the validator page gives for read-only validators. The derived writes are
part of the operations, the journal, `enforce` and the validated state, exactly as that page
recommends for anything a validator would derive. Validators stay read-only and order-independent.
A constraint violation or validator rejection caused by a derived write rolls back the whole
transaction, including the command's own writes; the error names the rule. A stage that cannot
decide (a read error, a `CandidateConflictError`, an emit value of the wrong type) fails the
transaction closed.

System writes (configuration, materialization, runner control, checkpoints) skip the stage, as
they skip validators. Rules may not depend on reserved `:triplex/*` or `:_tx/*` attributes, so a
system write can never change a rule's input.

### Valid time and boundaries

The stage evaluates at `validAt` equal to the transaction instant, the default commit validators
already use. A derived fact therefore states what the rule concluded from that instant forward.

Some changes need no commit: a supporting fact reaches its `validTo`, or a future-effective fact
starts. `evaluate` already returns each rule's `nextTemporalBoundary`. The stage records the
minimum across the rule set in a reserved control fact. A maintainer commits an empty
maintenance transaction at each boundary `T`, with actor `triplex/derived-facts`, whose stage
evaluates at `validAt = T` and asserts or ends facts at `T`. Because valid time is set to `T`,
a late maintenance commit still records the exact valid instant; only recorded time lags.
Offline catch-up replays each boundary in order, as the runner does.

The maintainer should be the runner's existing timer rather than a second scheduler (an option
on `Runner.start`), since the runner already owns exact-instant boundary replay, catch-up and
single-process ownership. Without a maintainer, derived facts are correct after every relevant
commit and may be stale between a temporal boundary and the next relevant commit; the docs must
say so.

Retroactive writes (a command asserting a fact with `validFrom` in the past) do not rewrite
past derived intervals. Derived history records what each evaluation concluded at its instant.
Section 9 lists this as an open question.

### Rule set identity and changes

The stage must never run two different rule sets against one database: one process would assert
what another ends. `rebuild` records `rules.id` in a reserved control fact. Every stage checks,
inside the transaction, that the recorded ID equals its own and otherwise fails with
`DerivedRulesChangedError`. Changing rules is an explicit step:

1. stop writers that run the old rule set;
2. run `Logical.rebuild(triples, nextRules)`, one journaled system transaction that evaluates
   every rule, brings each owned attribute to its desired set (including ending facts on
   attributes no longer owned, if asked) and records the new ID;
3. start writers with the new layer.

`rebuild` is also how an existing database adopts its first rules.

## 4. What it builds on and what stays the same

- `Derivation.make`, `evaluate` and `reconcile` are reused unchanged. Rules accept only
  definitions `make` already accepts; dynamic-attribute definitions are rejected because their
  dependencies cannot be planned.
- Materialization and the runner are unchanged. A runner registration can watch a derived
  attribute like any other; derived changes appear in the same journal entry as the command
  that caused them, so a downstream registration sees one batch, not one per hop.
- Provenance: a derived fact's `createdBy` names its rule and its assertion position fixes the
  evaluation cut, so `why` can re-run the rule at that position to recover the exact candidate
  sources without new storage. Extending `why` to do that is a follow-up.
- `db.preview` should run the stage on its overlay so a preview shows derived changes. That is a
  follow-up, not part of the first implementation.

## 5. Cost

Each relevant commit re-runs every affected rule as a complete `queryAll` plus a scan of its
owned attributes, inside the commit serialization. That cost is added to commit latency and
holds the write boundary. For scale, [Datalog performance](../datalog-performance.md) measures a
fixed-attribute query over 10,000 entities at about 20 ms and a two-attribute join at 23 to
43 ms on SQLite and PostgreSQL. A commit that touches the inputs of three such rules could add
60 to 130 ms.

That is acceptable for the intended sizes (rules over thousands to low tens of thousands of
matches), and it is why incremental matching stays out of scope until it is measured. Before the
API is documented as supported, the implementation must add a benchmark beside the existing
Datalog measurements: commit latency with 0, 1, 3 and 10 rules on the same 10,000-entity fixture,
for unrelated commits and for commits that touch every rule, on KV, SQLite and PostgreSQL. The
results decide whether entity-scoped re-evaluation or incremental matching is needed next.

The `rules` constructor can also accept a per-rule budget (maximum candidates, like the runner's
10,000 default). Exceeding it fails the transaction closed rather than truncating.

## 6. Package graph and compatibility

- All new code is in `packages/core`, browser-safe, under the existing
  `@triplex-build/triplex/derivation` subpath. No new dependency or package.
- The stage runs through an internal `TransactionMeta` field, the same mechanism commit
  validators use. The two `transact` implementations (`store/TriplesLive.ts` for the SQL
  backends and `kv/layers/KvTriplesLive.ts` for KV and FoundationDB) call one shared helper
  between applying operations and `enforce`. `enforce` currently loads its baseline facts from
  the command's operations before they are applied; it must also load the baseline for the
  stage's operations.
- Shared conformance cases in `packages/testkit`, beside `commitValidatorCases`, run on every
  backend.
- Additive for existing users: nothing changes unless a host installs the layer. One Changeset
  for the core package.

## 7. Tests the implementation must include

Each names a plausible wrong implementation it catches.

- Support loss ends, not erases: after ending, `asOf` the earlier instant still shows the derived
  fact. Catches plain retraction.
- Two candidates support one fact; removing one keeps it, removing both ends it. Catches
  per-candidate assert and retract.
- A two-rule chain settles in one commit: one journal entry holds the command's change and both
  derived changes, and a runner registration on the second attribute receives one batch. Catches
  per-hop commits.
- Rule order is by dependency, not declaration: declare the chain in reverse and get the same
  result. Catches declaration-order evaluation.
- A cycle, a self-read and a negated self-read are rejected at `rules`.
- An application write to an owned attribute is rejected; a validator that rejects a derived
  fact rolls back the command's facts too.
- A future-effective source fact produces its derived fact at exactly its `validFrom` after
  catch-up, even when the maintenance commit runs later.
- A writer with a different rule set fails with `DerivedRulesChangedError`.
- The same scenarios give identical facts on KV, SQLite and PostgreSQL.

## 8. Alternatives considered

**A. Status quo: write-back in `onDiff`.** Works today and costs nothing in the commit path, but
each host rebuilds truth maintenance, chains take a batch per hop, and readers see intermediate
states.

**B. Query-time derivation only (Datalog rules or a shared query).** Always consistent and adds
no writes. It is the right choice when only reads need the conclusion. It cannot give the
conclusion history, journal changes, constraints, validators or runner and live-query
dependencies, which are the reasons to want a fact.

**C. Runner-driven write-back.** A runner registration with emit templates that commits each
diff. Automatic retraction and no commit latency, but still post-commit, one batch per hop, and
eventually consistent. The same `Rule` objects could support this as an asynchronous mode later
for rules too expensive to run in the commit; it is not proposed now.

**D. Per-fact support records.** Store which candidates support each derived fact, as Clara does,
so asserted and derived values can share an attribute. Rejected for the first version: hidden
state, more writes per commit, and an ambiguous owner for a fact both a user and a rule assert.

**E. A write channel on commit validators.** Rejected for the reasons the validator page gives:
writes from a validator would need their own journal, `enforce` and validation, and would make
validator order matter. The stage is a separate step that runs before all of them.

**F. Iterate to a fixpoint with cycles (semi-naive evaluation).** Needed for recursion through
derived facts, which is out of scope. Requiring an acyclic rule graph makes one pass sufficient
and keeps the cost of a commit predictable.

## 9. Open questions for the owner

1. Names: `Derivation.Logical` (after Clara's `insert-logical`), `Derivation.Rules` (collides with
   Datalog `rules`) or a derived-attribute marker in configuration (`Attribute...derived()`).
2. Should ownership also be declared in the release, so `describe` and typed writes know an
   attribute is derived, or is the layer the only source of truth?
3. Retroactive writes: is forward-only derived history acceptable, or should a backdated source
   write re-derive past intervals? The latter needs evaluation across valid time and is much
   larger.
4. Should the boundary maintainer be a `Runner.start` option (recommended) or its own scoped
   handle for hosts that do not run the runner?
5. Is the per-commit cost budget a hard limit per rule, per transaction, or both?
