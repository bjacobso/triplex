---
description: Explain facts, entity state and derivation candidates at an exact recorded cut.
---

# Explain a fact with `why`

`Why` answers who asserted a fact, which command wrote it, and which immutable
release that transaction pinned. It returns a versioned JSON DTO with complete
fact intervals and journal attribution. It captures one recorded position and
uses that cut for every read. By default it stops at the assertion and release.

```ts check
import { Effect, Layer } from "effect";
import { EntityId, KvTriples, Triples, ref } from "@triplex-build/triplex";
import { ConfigStore } from "@triplex-build/triplex/config";
import { Why } from "@triplex-build/triplex/why";

const Store = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));
const Explained = Why.layer.pipe(Layer.provideMerge(Store));

const example = Effect.gen(function* () {
  const triples = yield* Triples;
  const why = yield* Why;
  const entityId = EntityId.make("placement:maria-harbor");
  const written = yield* triples.transact(
    [
      {
        op: "assert",
        entityId,
        attribute: ":placement/site",
        value: ref(EntityId.make("site:harbor")),
        validFrom: Date.UTC(2026, 2, 2),
      },
    ],
    { actor: "user:dana", commandId: "create:placement:maria-harbor" },
  );
  const explanation = yield* why.why(
    { kind: "attribute", entityId, attribute: ":placement/site" },
    { basis: { recordedPosition: written.position, validAt: Date.UTC(2026, 2, 3) } },
  );
  return JSON.stringify(explanation);
}).pipe(Effect.provide(Explained));
```

Use the same service over SQLite or PostgreSQL by replacing the `Triples` layer.
`Why.layer` requires only `Triples` and `ConfigStore`; it has no codec or opener.

## Choose a subject

- `{ kind: "fact", tripleId }` explains that exact assertion, including a retracted
  or future-valid assertion. An ID first recorded after the cut is not found.
- `{ kind: "attribute", entityId, attribute }` explains every visible value of an
  attribute. It preserves multi-valued attributes.
- `{ kind: "entity", entityId }` explains every visible fact of the entity.
  Entity results are complete and unpaginated. Empty state returns `facts: []`.
- `{ kind: "candidate", definition, candidateId, revision }` replays the supplied
  immutable derivation at an explicit recorded basis and valid time. Retain the
  definition alongside stored candidates; an ID alone cannot recover it.

```ts check
import { Effect } from "effect";
import { Triples } from "@triplex-build/triplex";
import * as Derivation from "@triplex-build/triplex/derivation";
import { Why } from "@triplex-build/triplex/why";

const explainCandidate = (definition: Derivation.Definition, validAt: number) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    const why = yield* Why;
    const basis = { ...(yield* triples.resolveRecordedBasis()), validAt };
    const evaluation = yield* Derivation.evaluate(triples, definition, { basis });
    const candidate = evaluation.candidates[0];
    if (candidate === undefined) return null;
    return yield* why.why(
      { kind: "candidate", definition, candidateId: candidate.id, revision: candidate.revision },
      { basis },
    );
  });
```

Candidate facts expand positive source witnesses. Negation is evaluated at the
same cut; it creates no fact or correction receipt as an absence witness.
A candidate's definition release and its source transactions' releases can differ.
Replaying an old basis explains knowledge then; it does not claim freshness today.

## Time and causation

`basis` accepts `validAt` plus either `recordedPosition` or `recordedAt`.
Omitted valid time uses the Effect clock once. Omitted recorded time captures the
committed head once. A recorded timestamp resolves to an exact position, including
all equal-timestamp commits visible at capture. Reuse the returned position for
replay. Visibility uses half-open valid intervals, `[from, to)`.

A historical result excludes later retraction metadata. A fact explanation after
retraction reports the retractor without shortening the original valid interval.
The implementation reads journal receipts independently of valid time, so a
backdated March assertion written in November still reports its November actor.

Set `causationDepth` to an integer from 0 through 32 to follow command parents.
Zero performs no parent lookups. A `causationId` names an exact case-sensitive
`commandId` in the same database; correlation IDs do not establish causation.
Each assertion/retraction receipt starts its own trace. Stops report `disabled`,
`root`, `depth-limit`, `missing`, `after-basis`, or `cycle`. Missing external commands
and cycles are successful partial explanations. There is no forward fan-out.

## Reading the result

Every top-level DTO field is present. Missing scalar metadata uses `null`;
`derivation` is `null` for stored facts. Facts sort by entity, attribute and triple
ID; transactions deduplicate and sort by position then ID. Traces sort by starting
transaction ID. Embedded candidates retain their existing optional-field JSON
contract and evaluator source ordering. The result contains no Effect `Option`.

Release lookup uses the transaction's `configSnapshot`, never today's `live` ref.
A release is `unpinned`, `missing` with its stored ID, or `found` with ID, label and
root CID. A pin records declared governance; it does not prove enforcement.

Legacy facts retain missing attribution as `gaps` when an exact public state read
can classify them. Ambiguous or inconsistent history fails `WhyIncompleteHistory`
rather than guessing an actor, position or release. Storage/configuration failures
remain typed failures. Other explanation errors are `WhyInvalidRequest`,
`WhySubjectNotFound` and `WhyCandidateRevisionMismatch`; see [error codes](/errors).

Sealed values remain opaque sealed envelopes. `why` never opens them or returns
a definition's query and sensitive equality constants. Hosts still control access
to actors, ciphertext and equality tokens. Whole-entity history and broad
candidate evaluations can be expensive; host time or response budgets must fail
explicitly instead of returning an unexplained subset.
