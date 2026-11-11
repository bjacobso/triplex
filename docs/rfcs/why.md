# RFC: one explanation operation, `why`

Status: proposed for owner approval before P3.2. This RFC changes no runtime or
public exports. It follows the settled decision: stop at the asserting transaction
and its pinned release by default; follow command causation only to an explicitly
requested depth. New implementation targets KV, SQLite and PostgreSQL.

## Subjects and ownership

Add the browser-safe `Why` Effect service in core, exported from the proposed
`@triplex-build/triplex/why` subpath. `Why.layer` requires `Triples` and
`ConfigStore.ConfigStore`; it imports no backend, host, codec or Node API. One
`why(subject, options)` operation has a discriminated subject, rather than four
operations with divergent temporal and serialization rules:

```ts
// Proposed contracts, not currently exported. Brands are strings on the wire.
type BasisInput = {
  readonly validAt?: number;
  readonly recordedAt?: number;
  readonly recordedPosition?: number;
};
type WhySubject =
  | { readonly kind: "fact"; readonly tripleId: TripleId }
  | { readonly kind: "attribute"; readonly entityId: EntityId; readonly attribute: string }
  | { readonly kind: "entity"; readonly entityId: EntityId }
  | {
      readonly kind: "candidate";
      readonly definition: Derivation.Definition;
      readonly candidateId: ContentId;
      readonly revision: ContentId;
    };
type WhyOptions = {
  readonly basis?: BasisInput;
  readonly causationDepth?: number; // default 0; integer 0..32
};
interface WhyService {
  readonly why: (subject: WhySubject, options?: WhyOptions) => Effect.Effect<Explanation, WhyError>;
}
```

Attribute and entity subjects select every visible fact at the basis, preserving
multi-valued attributes. They do not pick a latest value or infer cardinality.
An empty selection is a successful explanation with `facts: []`, not evidence
that the entity never existed. A fact subject selects that exact assertion,
including one no longer visible. An assertion first recorded after the requested
cut is indistinguishable from a missing ID: `WhySubjectNotFound`.

A candidate subject supplies the complete immutable definition, candidate ID and
revision, plus an explicit recorded basis and `validAt`. Evaluate it through
`Derivation.evaluate` and select the matching candidate. No match is
`WhySubjectNotFound`; the same ID with a different revision is
`WhyCandidateRevisionMismatch`. This explains a replayed candidate at a stated
basis, not an implicitly current materialization. Callers can take the candidate
and basis from the public materialization APIs, but must also retain its
definition. Historical definition lookup by ID alone is not part of P3.2.
Hypothetical overlay candidates are outside this initial contract.

## Result and serialization

Return the following versioned DTO. The fragments use existing public
`TripleValue`, `TripleId`, `EntityId`, `TransactionId`, `ContentId`, `Derivation`
and Effect types. Every DTO field is required. `null` means absent; arrays are
complete and ordered. Times are finite epoch milliseconds and positions are safe
integers. Never expose Effect `Option`, `Map`, `Date`, `undefined`, bigint or
non-finite numbers in a result. `TripleValue` retains its existing JSON-safe
tagged encoding, including opaque sealed envelopes.

```ts
type Release =
  | { readonly status: "unpinned" }
  | { readonly status: "missing"; readonly id: string }
  | {
      readonly status: "found";
      readonly id: string;
      readonly label: string;
      readonly rootCid: ContentId;
    };
type TransactionExplanation = {
  readonly txId: TransactionId;
  readonly position: number;
  readonly instant: number;
  readonly actor: string | null;
  readonly commandId: string | null;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly release: Release;
};
type FactExplanation = {
  readonly tripleId: TripleId;
  readonly entityId: EntityId;
  readonly entityType: string | null;
  readonly attribute: string;
  readonly value: TripleValue;
  readonly valid: { readonly from: number; readonly to: number | null };
  readonly recorded: { readonly from: number; readonly to: number | null };
  readonly visible: boolean;
  readonly assertion: TransactionId | null;
  readonly retraction: TransactionId | null;
};
type CausationTrace = {
  readonly start: TransactionId;
  readonly ancestors: readonly TransactionId[]; // immediate parent first
  readonly stop:
    | { readonly reason: "disabled" | "root" }
    | { readonly reason: "depth-limit" | "missing" | "after-basis"; readonly commandId: string }
    | { readonly reason: "cycle"; readonly commandId: string; readonly txId: TransactionId };
};
type Explanation = {
  readonly version: 1;
  readonly subject:
    | { readonly kind: "fact"; readonly tripleId: TripleId }
    | { readonly kind: "attribute"; readonly entityId: EntityId; readonly attribute: string }
    | { readonly kind: "entity"; readonly entityId: EntityId }
    | { readonly kind: "candidate"; readonly candidateId: ContentId; readonly revision: ContentId };
  readonly basis: { readonly validAt: number; readonly recordedPosition: number };
  readonly facts: readonly FactExplanation[];
  readonly transactions: readonly TransactionExplanation[];
  readonly derivation: null | {
    readonly name: string;
    readonly candidate: Derivation.Candidate;
    readonly release: Release;
    readonly evaluationNextTemporalBoundary: number | null;
  };
  readonly causation: {
    readonly maxDepth: number;
    readonly traces: readonly CausationTrace[];
  };
  readonly gaps: readonly {
    readonly kind: "missing-assertion" | "missing-retraction";
    readonly tripleId: TripleId;
    readonly txId: TransactionId | null;
  }[];
};
```

The embedded candidate uses its existing JSON contract: optional properties are
omitted, never assigned `undefined`. Its resolved basis is the result's exact
basis. `SourceFact` already carries source IDs, entity, attribute, valid interval,
and optional assertion transaction/position. `facts` expands all those positive
sources to their typed values and full intervals. A candidate has no asserting
transaction of its own: a materialization receipt records persistence, not why
the candidate holds. Its definition's release and each source write's release
remain separate; they may differ.

`transactions` contains journal-derived envelopes, deduplicated by ID, sorted by
position then ID. It includes assertions, known retractions and requested causal
ancestors, each with its own release. It deliberately omits unrelated transaction
changes; the explained facts already identify the relevant assertions and
retractions. `facts` sorts by entity ID, attribute, then triple ID using code-unit
ordering. Source arrays retain the evaluator's ordering. Traces sort by starting
transaction ID; gaps sort by triple ID then kind. No silent truncation is allowed.

Resolve a release only from the journal's `configSnapshot` using
`ConfigStore.snapshotById`, never from today's `live` ref. No pin means
`unpinned`; an unresolvable pin, including a non-content-ID string accepted by
older writers, means `missing`. Found releases expose their immutable ID, label
and root commitment, not a copied configuration tree. A pin records declared
governance; it does not prove enforcement was requested or successful outside
Triplex's transaction boundary.

Legacy/direct-adapter facts can lack journal attribution. Retain those facts,
set the corresponding transaction reference to `null`, and emit a gap with the
stored ID if known. Never invent an actor from `createdBy`, infer a write's
release from a nearby release commit, or silently substitute another receipt.

## Recorded and valid time

Resolve the basis once. Omitted `validAt` uses the Effect clock once, while
omitted recorded basis captures one committed head. Reject simultaneous
`recordedAt` and `recordedPosition`. Resolve a timestamp to the greatest committed
position whose instant is at most that timestamp, bounded by the captured head;
use zero if none exists. Equal timestamps include all commits at that instant
visible at capture. A supplied position must be at most the captured head.
Return the exact position so a caller can replay the answer without timestamp
ambiguity. Historical timestamps in the future resolve to the captured head.

Selection uses half-open intervals: assertion position at or before the cut,
no retraction position at or before the cut, and
`validFrom <= validAt < validTo` (an absent end is unbounded). For a fact subject,
`visible` reports this predicate instead of filtering away a retracted or
future-valid assertion. Entity and attribute subjects contain only visible
facts. A future-only fact is explainable by ID with `visible: false`, and by a
state subject at its future valid date if already recorded.

The result represents knowledge at the recorded cut. If a later retraction is
present in today's raw history but is after the cut, return `recorded.to: null`
and `retraction: null`, and do not include that later receipt. At a cut after the
retraction, report its timestamp and transaction; the assertion remains available
by fact ID with `visible: false`. A supersession is a retraction and a new
assertion, not an inferred special event: explaining the old ID reports its
retractor; explaining current state reports the replacement. `recorded.to` does
not shorten `valid.to`. If a correction reasserts a bounded interval, that new
assertion owns its own ID and provenance.

Fetch selected assertions with `get`/`history` and state reads at the resolved
position. Fetch assertion and retraction envelopes with `transaction(txId)`,
outside the selected fact's valid-time filter, and check their positions against
the cut. Never join `:_tx/actor` under the historical `validAt`. As documented in
[the modeling guide](../agents.md#5-answer-audit-questions), `_tx` metadata starts
at commit time even when an application backdates its assertions. A write made
in November for March must still explain Dana as the actor at a March valid date.

For candidates, evaluate at the same exact cut. Sources are positive witnesses,
not a fabricated fact for an absent training record. The definition's negated
clause and the pinned evaluation explain that absence at this basis; this is not
a separately persisted proof of every non-match. Existing unsupported provenance
queries remain rejected. Replaying a stored stale run explains that run's basis,
not freshness today. An expired source is absent from a current re-evaluation;
it can still support the historical candidate.

## Causation and cost

Interpret a transaction's `causationId` as the exact, case-sensitive `commandId`
of its immediate cause in the same database. Resolve it with
`transactionByCommand`; do not interpret it as a transaction ID, correlation ID,
external lookup or cross-database address. Existing writers may store external
labels: `training:correct:maria-harbor` names `audit:2026-q1`, for which this
scenario has no receipt. A trace for that correction reports `missing`.
Correlation groups related activity but does not establish causation.

Depth zero performs no parent lookups and returns `disabled` for every starting
receipt. For positive depth D, start independently from every assertion and
retraction receipt in `facts`, following at most D parent edges. Candidate source
assertions are starts too. Ancestors get envelopes and releases but their changed
facts are not recursively expanded. Reuse receipt/release reads across traces.

At each step, no causation ID means `root`. If a link remains when the budget is
spent, report `depth-limit` with that command ID without reading it. A missing
receipt reports `missing`. A receipt after the recorded cut reports `after-basis`
without including it or its metadata in the transaction table. Maintain a visited
transaction-ID set per trace, initially containing the start; a repeated ID
reports `cycle` and is not appended again. Detect self-links as cycles. Terminate
at the first such condition. Cycles and missing links are successful partial
explanations, not retries or a claim of complete causality. No automatic forward
fan-out is performed and actor-supplied causation is attribution, not proof that
the cause was legitimate.

Let F be selected facts, T distinct local assertion/retraction receipts, H the
histories needed to reconstruct intervals, and A distinct traversed ancestors,
where A is at most T × D. The default costs no causal queries. Each extra unique
ancestor requires a command lookup plus its envelope and at most one uncached
release lookup; definitions and releases can dominate payload size.

| Backend    | Expected access and cost                                                                                                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KV         | Direct fact lookup, entity history prefix scans, command-attribute AVET lookup, transaction entity-prefix reads; roughly O(H + F + T + A) records plus ordered-index seeks and reached config nodes. No whole-journal causation replay. |
| SQLite     | Primary fact lookup, indexed entity/history reads, indexed command attribute lookup and transaction entity reads; O(log N) seeks plus returned rows per lookup. Sequential parents can require D rounds; no recursive SQL dependency.   |
| PostgreSQL | Same indexed SQL shape; remote round trips make depth and distinct starts material. Memoize and use bounded concurrency for independent starts. No N-per-database journal scan.                                                         |

Candidate evaluation retains the existing derivation query/provenance cost;
`why` cannot make a broad definition cheap. Whole-entity history is unbounded in
this first version. Cancellation remains an Effect interruption; CLI/MCP hosts
can impose time and response budgets and must fail explicitly rather than return
an unexplained subset. None of these estimates promises a backend-wide single
SQL transaction or includes an unbounded configuration graph as constant work.

## Public reads and typed errors

Use public `Triples.get`, `entity`/`match`, `history`, `transaction`,
`transactionByCommand`, and where necessary paged `transactionsForEntity` to
recover legacy retraction attribution. Match retraction changes by triple ID,
not value. Use `ConfigStore.snapshotById` and `Derivation.evaluate`, with the
public materialization APIs only for callers choosing a durable run. Never
reach into `StorageAdapter`, KV keys, SQL tables, or config system entities from
`Why`. Cache only immutable receipt/release identities; filter every cached
result against the current request's cut.

One public read is missing for an efficient, general exact-cut contract:

```ts
// Proposed addition to Triples, required before wiring Why.layer.
interface RecordedBasisReader {
  readonly resolveRecordedBasis: (basis?: {
    readonly recordedAt?: number;
    readonly recordedPosition?: number;
  }) => Effect.Effect<{ readonly recordedPosition: number }, ReadError>;
}
```

It captures the committed head, validates the request, and implements the
timestamp/position rules above without exposing adapters. KV needs an ordered
journal timestamp/position seek (or a documented bounded-head scan until indexed);
SQL needs a committed journal instant/position lookup with a suitable index.
`transactionsForEntity` already exposes a captured head but cannot resolve an
arbitrary timestamp efficiently; paging `transactions` to find it would make
ordinary explanations depend on database age. This is a proposed public read,
not an existing capability. P3.2 must implement it through the public contract
or return to the owner if its allowed files do not cover it.

No new public fact-history or command-parent read is necessary: full history and
journal receipts provide intervals and positions. `get` is not a historical
read; reconstruct its requested recorded view using the assertion/retraction
receipts. Missing journal positions for a legacy assertion prevent exact-cut
classification when timestamps tie: fail `WhyIncompleteHistory` rather than
guess. Missing metadata that does not affect selection remains a reported gap.
An inconsistent source ID, transaction position or immutable receipt is also
`WhyIncompleteHistory`.

```ts
type WhyError =
  | ReadError
  | ConfigStore.LoadError
  | DatalogQueryError
  | CanonicalJson.CanonicalEncodingError
  | Schema.SchemaError
  | Derivation.CandidateConflictError
  | WhyInvalidRequest
  | WhySubjectNotFound
  | WhyCandidateRevisionMismatch
  | WhyIncompleteHistory;
```

`WhyError` combines existing read/config/derivation errors with proposed tagged
errors: `WhyInvalidRequest` (invalid basis,
depth, missing candidate basis or hypothetical input), `WhySubjectNotFound`,
`WhyCandidateRevisionMismatch`, and `WhyIncompleteHistory`. Preserve underlying
typed failures; do not turn storage failure or corrupt config into a missing
link. New errors carry subject IDs and machine-readable reason codes, never
fact values or candidate bodies. There is no write-error channel and no implicit
repair. Implementation must use the actual exported derivation error union,
including sensitive-query and canonical-encoding errors, rather than `unknown`.

## Sensitive values

`why` neither requests `ValueCodec`/`KeyProvider` nor calls `Sensitive.open`.
Selected sealed values remain the stored `sealed` envelopes, including opaque
key/ciphertext metadata and optional blind token under the existing read policy.
They never become plaintext, a display string, or a hash of plaintext. Journal
copies must receive the same treatment. Candidate results retain the evaluator's
withheld sealed bindings; source expansion may expose only sealed envelopes.
Do not echo a supplied definition's plaintext sensitive equality constants into
the result, errors or telemetry. The result carries its ID and name, not its raw
query. Hosts still authorize access to actors, ciphertext and equality tokens;
this read operation creates no new decryption or authorization capability.

## Worked site-safety examples

The following are exact proposed DTO outputs using concrete IDs and instants
captured from running the existing [site-safety snippets](../snippets/home/site-safety/app.ts):
publish `hr-2026.1`, onboard, record training, place Maria, publish `hr-2026.2`,
then correct training. These are the six successful commits from `run.ts`;
the retry and rejected placement add no commit. Fact/transaction IDs and wall
clock times vary on another run; content IDs below were calculated by the
existing public derivation/configuration code, not invented aliases. The proposed
serializer is specified here; `why` itself is not yet implemented.

### Why is this placement's site harbor?

Request the attribute of `placement:maria-harbor` at recorded position 6 and
valid time March 3 (`1772496000000`), with default causation depth. The placement
started March 2 (`1772409600000`). Dana's write pins `hr-2026.1` even though
`live` has moved to `hr-2026.2`:

```ts
const explanation = why.why(
  {
    kind: "attribute",
    entityId: EntityId.make("placement:maria-harbor"),
    attribute: ":placement/site",
  },
  { basis: { recordedPosition: 6, validAt: 1772496000000 } },
);
```

```json
{
  "version": 1,
  "subject": {
    "kind": "attribute",
    "entityId": "placement:maria-harbor",
    "attribute": ":placement/site"
  },
  "basis": {
    "recordedPosition": 6,
    "validAt": 1772496000000
  },
  "facts": [
    {
      "tripleId": "01M762QPRVRMSBZ3AHBY7F7E3F",
      "entityId": "placement:maria-harbor",
      "entityType": "Placement",
      "attribute": ":placement/site",
      "value": {
        "type": "ref",
        "value": "site:harbor"
      },
      "valid": {
        "from": 1772409600000,
        "to": null
      },
      "recorded": {
        "from": 1794426788633,
        "to": null
      },
      "visible": true,
      "assertion": "_tx/01M762QPRSDFXDBQSPDJAQP2XF",
      "retraction": null
    }
  ],
  "transactions": [
    {
      "txId": "_tx/01M762QPRSDFXDBQSPDJAQP2XF",
      "position": 4,
      "instant": 1794426788633,
      "actor": "user:dana",
      "commandId": "create:placement:maria-harbor",
      "correlationId": "request:7f3a",
      "causationId": null,
      "release": {
        "status": "found",
        "id": "sha256-92c859ed4c5ff7b06b57a97b6f4a9774abf6d862a63487135965b9457cde8a3c",
        "label": "hr-2026.1",
        "rootCid": "sha256-e09adbce90b60e492eb2e8b39a18242be6dd7163c97fe2b2a700fb6c4cfcbe41"
      }
    }
  ],
  "derivation": null,
  "causation": {
    "maxDepth": 0,
    "traces": [
      {
        "start": "_tx/01M762QPRSDFXDBQSPDJAQP2XF",
        "ancestors": [],
        "stop": {
          "reason": "disabled"
        }
      }
    ]
  },
  "gaps": []
}
```

### Why is there an open training task for Maria at harbor?

The snippets call this open work, but persist no Task entity. Explain the
candidate from `task.site-safety-training`, defined by `openWork`, evaluated at
recorded position 6 and March 3. Request its exact ID and revision below with
that definition and basis. Its two positive source facts are the placement's
worker and site; both come from Dana's transaction at position 4.

The auditor at position 6 retracted the March 1 training belief and asserted
training for [March 5, June 1). Consequently the negated training clause succeeds
on March 3, as `output/open-work.json` shows. That absent fact is not a source;
the correction receipt is not fabricated as a positive witness. The evaluation's
next boundary is March 5, while the candidate itself has no boundary from its
unbounded positive sources. A caller needing the correction can separately
explain the old training triple by ID. In April this candidate is absent; on
June 1 it exists again when training expires.

```ts
const explanation = why.why(
  {
    kind: "candidate",
    definition: training, // the definition made in openWork
    candidateId: candidate.id,
    revision: candidate.revision,
  },
  { basis: { recordedPosition: 6, validAt: 1772496000000 } },
);
```

```json
{
  "version": 1,
  "subject": {
    "kind": "candidate",
    "candidateId": "sha256-d8a4f233ae0e9452c7f0edfa1c415fb9afa32bd6e75f73e72f712336620eb32f",
    "revision": "sha256-a7063abe0bb4df2f48b0f3213b54efaa2e807e19aa2d33845c949d433dacfad4"
  },
  "basis": {
    "recordedPosition": 6,
    "validAt": 1772496000000
  },
  "facts": [
    {
      "tripleId": "01M762QPRVRMSBZ3AHBY7F7E3F",
      "entityId": "placement:maria-harbor",
      "entityType": "Placement",
      "attribute": ":placement/site",
      "value": {
        "type": "ref",
        "value": "site:harbor"
      },
      "valid": {
        "from": 1772409600000,
        "to": null
      },
      "recorded": {
        "from": 1794426788633,
        "to": null
      },
      "visible": true,
      "assertion": "_tx/01M762QPRSDFXDBQSPDJAQP2XF",
      "retraction": null
    },
    {
      "tripleId": "01M762QPRVRMSBZ3AHBY7F7E3E",
      "entityId": "placement:maria-harbor",
      "entityType": "Placement",
      "attribute": ":placement/worker",
      "value": {
        "type": "ref",
        "value": "worker:maria"
      },
      "valid": {
        "from": 1772409600000,
        "to": null
      },
      "recorded": {
        "from": 1794426788633,
        "to": null
      },
      "visible": true,
      "assertion": "_tx/01M762QPRSDFXDBQSPDJAQP2XF",
      "retraction": null
    }
  ],
  "transactions": [
    {
      "txId": "_tx/01M762QPRSDFXDBQSPDJAQP2XF",
      "position": 4,
      "instant": 1794426788633,
      "actor": "user:dana",
      "commandId": "create:placement:maria-harbor",
      "correlationId": "request:7f3a",
      "causationId": null,
      "release": {
        "status": "found",
        "id": "sha256-92c859ed4c5ff7b06b57a97b6f4a9774abf6d862a63487135965b9457cde8a3c",
        "label": "hr-2026.1",
        "rootCid": "sha256-e09adbce90b60e492eb2e8b39a18242be6dd7163c97fe2b2a700fb6c4cfcbe41"
      }
    }
  ],
  "derivation": {
    "name": "task.site-safety-training",
    "candidate": {
      "id": "sha256-d8a4f233ae0e9452c7f0edfa1c415fb9afa32bd6e75f73e72f712336620eb32f",
      "revision": "sha256-a7063abe0bb4df2f48b0f3213b54efaa2e807e19aa2d33845c949d433dacfad4",
      "definitionId": "sha256-6d430a3fcdb169282b5dfe77b1d00ea297f32b614f6b5fda40d099e3ff2cb7cb",
      "configSnapshot": "sha256-92c859ed4c5ff7b06b57a97b6f4a9774abf6d862a63487135965b9457cde8a3c",
      "identity": {
        "?worker": "worker:maria",
        "?site": "site:harbor"
      },
      "result": {
        "?worker": "worker:maria",
        "?site": "site:harbor"
      },
      "basis": {
        "recordedPosition": 6,
        "validAt": 1772496000000
      },
      "sources": [
        {
          "tripleId": "01M762QPRVRMSBZ3AHBY7F7E3E",
          "transactionId": "_tx/01M762QPRSDFXDBQSPDJAQP2XF",
          "transactionPosition": 4,
          "entityId": "placement:maria-harbor",
          "attribute": ":placement/worker",
          "validFrom": 1772409600000
        },
        {
          "tripleId": "01M762QPRVRMSBZ3AHBY7F7E3F",
          "transactionId": "_tx/01M762QPRSDFXDBQSPDJAQP2XF",
          "transactionPosition": 4,
          "entityId": "placement:maria-harbor",
          "attribute": ":placement/site",
          "validFrom": 1772409600000
        }
      ]
    },
    "release": {
      "status": "found",
      "id": "sha256-92c859ed4c5ff7b06b57a97b6f4a9774abf6d862a63487135965b9457cde8a3c",
      "label": "hr-2026.1",
      "rootCid": "sha256-e09adbce90b60e492eb2e8b39a18242be6dd7163c97fe2b2a700fb6c4cfcbe41"
    },
    "evaluationNextTemporalBoundary": 1772668800000
  },
  "causation": {
    "maxDepth": 0,
    "traces": [
      {
        "start": "_tx/01M762QPRSDFXDBQSPDJAQP2XF",
        "ancestors": [],
        "stop": {
          "reason": "disabled"
        }
      }
    ]
  },
  "gaps": []
}
```

## Verification for P3.2

Before implementation, add failing shared KV/SQLite/PostgreSQL cases for all
four subjects; multi-valued and empty state; assertion/retraction receipts and
release pins; a pin differing from `live`; candidate revision mismatch; positive
sources and negation without fabricated witnesses; and sealed source/journal
values with no opener supplied. Exercise historical recorded cuts before and
after correction, future-valid assertions, valid interval endpoints, the `_tx`
backdated-actor trap, equal commit timestamps, and a concurrent retraction after
basis capture. Verify depth zero does no parent reads, exact depth limits,
self/multi-command cycles, external missing commands, after-basis links, shared
ancestor deduplication and cancellation. Legacy attribution gaps and corrupt
receipts must remain distinct from empty selections and storage failures.

Use the worked outputs as DTO fixtures, capturing clocks/IDs explicitly or
comparing against the fixture's generated IDs. Verify JSON round trips and no
Effect `Option` objects, plaintext leaks, unrelated journal changes, or later-cut
retraction metadata. This RFC adds no package tests or generated snippet outputs.

## Non-goals and owner questions

P3.2 does not add task lifecycle, a natural-language explanation generator,
authorization, decryption, external causation resolution, downstream command
fan-out, automatic recursive expansion of derived facts, proof of a human's
motivation, or a persisted proof for negation. It does not extend the derivation
query subset or implement CLI/MCP transport; those follow in P3.5/P3.6.

Recommendations awaiting approval with this RFC:

- Approve one `Why` service/subpath and the exact-cut `resolveRecordedBasis`
  prerequisite, including any timestamp index cost. The alternative of using a
  fresh timestamp on each read cannot promise consistent multi-read explanations.
- Approve the proposed depth ceiling of 32 and complete whole-entity results.
  If WorldVM needs fact-count budgets or pagination, settle that before P3.2;
  truncation must be explicit in a revised result contract.
- Approve candidate lookup by supplied definition plus exact ID/revision/basis.
  An ID-only historical registry or explicit immutable-run lookup could follow,
  but requires a public definition/run read contract beyond today's candidate
  provenance. No new registry is implied here.
- Confirm whether WorldVM needs independently structured negative witnesses.
  This proposal preserves today's positive-source contract and identifies the
  evaluated definition/basis; stronger absence proofs need a separate derivation
  design rather than pretending a missing training fact has a transaction.

These questions concern the proposed API details, not the settled default stop
at transaction/release or the optional bounded causation chain. This document
alone introduces no breaking API, migration, Changeset or adoption requirement.
