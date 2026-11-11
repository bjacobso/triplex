# RFC: the schema-bound `Database` service

Status: proposed, P2.5; implementation waits for owner approval in D3. This document
adds no exports or runtime behavior. All code below is proposed API or illustrative
composition, not a checked example of an available client. The underlying operations
are available unless explicitly identified as a future integration.

The client makes the safe path short: one attributed command, one immutable release,
one enforced transaction, guarded read-before-write operations, and decoded entity
reads. It does not replace `Triples`, add a write path, infer authorization, or run a
workflow. WorldVM selects one database per world and owns release promotion.

## 1. Location, schema, and layer construction

Export `Database` (the Effect service tag), `layer`, and the client types from a new
core subpath, `@triplex-build/triplex/database`. Keep the root export unchanged for
this implementation. Core remains browser-safe, ESM and Effect-only: no Promise
facade, backend imports, Node APIs, connection pools, or host selection inside the
client. Target KV, SQLite and PostgreSQL; frozen experimental backends retain their
existing compilation and tests without a new-feature promise.

```ts
import * as Database from "@triplex-build/triplex/database";

const Model = {
  types: [Site, Worker, Placement],
  objects: [], // additional ConfigNode values: constraints, policies, forms, etc.
} as const;
const Store = ConfigStore.layer.pipe(
  Layer.provideMerge(SqliteTriples.layer({ filename: "world.db" })),
);
const World = Database.layer({ schema: Model, ref: "live" }).pipe(Layer.provide(Store));
```

`layer({ schema: { types, objects? }, ref? })` requires the existing `Triples` and
`ConfigStore.ConfigStore` services and produces only `Database`. The host must
provide a ConfigStore over the same database as Triples, once per world lifetime.
Substitute `KvTriples.layer` or `PgTriples.layerFromUrl(...)` for SQLite above;
layer construction never decides backend support or database identity. Sensitive
models require the host's existing `Sensitive.layer` and codec composition below
the client; the client does not invent a codec or open values.

Build the declared graph with `EntityType.nodesOf(...types)` and the supplied
objects. Deduplicate identical `(kind, key, cid)` nodes; reject conflicting logical
identities. Include reference-target closures through `nodesOf`, not just the types
written directly. Local aliases are TypeScript handles, not persisted identities.
Additional constraints must be ordinary versioned graph-constraint config nodes,
not a parallel unversioned array of runtime rules.

**Recommendation: check compatibility and refuse mismatch; never publish at startup.**
Resolve `ref` (default `live`) during layer acquisition. Walk the resolved snapshot
and require every declared logical node to exist with the same content ID, including
its dependency closure. Additional release objects are allowed. This is deliberately
conservative compatibility: no structural subtyping, automatic migration, or claim
that two different constraint graphs are equivalent. A changed supplied type,
requiredness, sensitivity, attribute definition, policy or constraint fails the
check. Alias-only changes do not change content identity. Enforce _all_ constraints
in the resolved release, including objects beyond the local declarations.

A missing ref or mismatching declaration fails acquisition before serving requests.
The host publishes with `config.commit({ label, objects, ref })` or promotes with
`config.setRef`; neither is a client method. Automatically publishing on startup
would let an old WorldVM worker move a world's release backwards. Comparing the
entire supplied graph with the entire release would unnecessarily reject unrelated
host-owned policy additions. Exact node compatibility avoids both outcomes.

Resolve and check again at each new command or ordinary read. Cache compatibility
and `GraphConstraint.pinned` results by immutable root identity, never by ref name.
Compatible ref changes take effect on the next call; incompatible changes fail
loudly until the host provides the matching model/layer. A command admitted under
release R finishes under R even if the host moves `live` during its callback. This
is an admission-time pin, not a commit-time ref fence. WorldVM must drain in-flight
commands if promotion requires that stronger boundary. No hidden config-ref writes
or private config-entity reads are introduced to implement fencing.

## 2. Commands and their builder

```ts
const program = Effect.gen(function* () {
  const db = yield* Database.Database;
  return yield* db.command(
    {
      actor: "user:dana",
      commandId: "create:placement:maria-harbor",
      correlationId: "request:7f3a",
    },
    (tx) =>
      Effect.gen(function* () {
        yield* tx.put(
          Placement,
          placementId,
          { worker: maria, site: harbor },
          { validFrom: MAR_2 },
        );
      }),
  );
});
```

`command(meta, build)` returns `Effect<TransactionRecord, DatabaseError | E, R>`
when the callback returns `Effect<void, E, R>`. Keep `commandId`, `correlationId`
and `causationId` spellings identical to TransactionMeta, rather than introducing
`id` aliases. `actor` and `commandId` are required nonempty strings. Correlation and
causation are optional strings copied verbatim. Actor is attribution, not proof of
authentication; the host authorizes before calling. The callback's value is not
returned or persisted, so a retry can return exactly the same receipt shape.

Every builder operation is an Effect returning `void`, except `get` and `fact`.
Execute sequentially in the callback's fiber; concurrent use, use after callback
completion, or detached use fails validation. A failed callback submits nothing.
The builder collects operations and preconditions; it never calls `transact` early.

| Builder call                                      | Meaning                                                                                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `put(Type, entityId, values, interval?)`          | Append `Type.assert(...)` operations, including entityType and one shared interval. This is assertion, not implicit upsert or full replacement. A second single-valued assertion can fail constraints. |
| `create(Type, entityId, values, interval?)`       | The same assertions plus `{ _tag: "EntityAbsent", entityId }`; strict creation across all valid time. No prior read is needed.                                                                         |
| `get(Type, entityId, { validAt? }?)`              | Decode persisted state and retain an EntityState guard as specified below. Missing state returns `null` but still guards the observed fact set.                                                        |
| `fact(Type, tripleId)`                            | `Triples.get`, verify type and declared attribute, require unretracted state, return the raw Triple for a temporal verb. No automatic decryption.                                                      |
| `end(Type, fact, at)`                             | Collect `Type.end(fact, at)`.                                                                                                                                                                          |
| `replace(Type, fact, oneAliasValue, at)`          | Collect `Type.replace(fact, oneAliasValue, at)`.                                                                                                                                                       |
| `correct(Type, fact, oneAliasValue)`              | Collect `Type.correct(fact, oneAliasValue)`.                                                                                                                                                           |
| `retract(Type, fact)`                             | Collect `{ op: "retract", id: fact.id }` and a matching TripleLive guard after type/attribute validation. Explicit whole-interval removal, not an end date.                                            |
| `inbox.append(input)`, `outbox.append(input)`     | Collect `{ op: "append-entry", kind, ...input }`; input is existing `{ scope, idempotencyKey, payload }`.                                                                                              |
| `inbox.acknowledge(id)`, `outbox.acknowledge(id)` | Collect `{ op: "acknowledge-entry", kind, id }`. Delivery and retries stay host-owned.                                                                                                                 |

Use the existing `EntityType.assert` value encoding and interval semantics. Omitted
validFrom stays omitted so the engine assigns the same commit instant; explicit
validFrom/validTo apply to every generated fact. Reject empty values, undeclared
aliases/types, invalid intervals, and repeated edits to the same source fact before
submission. Required-field/graph validity is decided by enforcement, not a second
client validator. `put` accepts optional fields as today's assertion builder does.
There are no implicit entity shells: empty entities are not representable.

Temporal verbs delegate to the existing pure builders without altering their
operations. `end` preserves the past, `replace` preserves the past and original end,
and `correct` replaces over the source interval. Combine independent changes with
`Change.combine` in caller order and forward _all_ generated preconditions. A
caller-supplied source Triple is allowed; its TripleLive guard still tests that exact
assertion at commit. Sensitive past-value reuse follows the existing same-transaction
retract rule in `Sensitive.layer`.

### Reads inside a command

There is **no read-your-writes overlay in P2.6**. Queued writes are invisible to
`tx.get` and `tx.fact`; another read after `put` still reads persisted state. Keep
new values in local variables. P3.3 preview may later evaluate the compiled command
against an overlay, without changing this command contract implicitly.

`tx.get` calls `Triples.history(entityId)` once on first use of that ID. From that
one result select all unretracted facts, across _all valid intervals_, and retain
their IDs as `{ _tag: "EntityState", entityId, tripleIds }`. Filter this same fact
set by the requested validAt (default captured command-start Effect Clock time),
then decode the selected type. Cache this observation per entity for the callback;
different validAt reads filter the same observed set. This avoids incorrectly using
only today's visible IDs as a complete EntityState guard. Future-valid assertions
and past intervals matter to that guard. Empty history gives an empty-set guard.

The observation is latest recorded state when fetched, not a historical basis.
Different entities can be fetched at different instants; their complete guards
must all hold inside the serialized transaction. There is no database-wide read
snapshot promise. `tx.fact` alone does not guard an unused read; it registers a
TripleLive guard when consumed by a retracting verb, because the primitive requires
a matching retraction. For a decision depending on other fields, use `tx.get`.
There are no builder `list`, Datalog or historical recorded-time reads: automatic
entity guards cannot protect arbitrary query absence or predicate phantoms. Use
commit validators for such business checks when P2.2 is available.

### Submission, retries and explicit escape

Validate meta, then call `transactionByCommand(commandId)` **before** resolving
live or running the callback. If found, return that TransactionRecord unchanged,
including its original actor/release, even if live has since changed. Command IDs
are database-wide identities, not actor-scoped keys; reusing an ID with a different
payload does not execute that payload. This matches the existing receipt guarantee;
there is no persisted request hash or invented mismatch detection.

Otherwise resolve/check the release, run the builder once, and submit exactly one
`transact(ops, { ...meta, ...pinned, preconditions })`. Here `pinned` is precisely
`yield* GraphConstraint.pinned(release)`; clients cannot supply configSnapshot or
enforce overrides. On success read `transaction(result.txId)` and return that stored
record. If the atomic command claim loses with CommandAlreadyCommittedError, read
`transactionByCommand` again and return the winner. A missing receipt after a
reported success/duplicate is a read failure, never an empty success or a second
write. If that read fails, retrying the command ID recovers the committed receipt.

Only duplicate-claim handling is automatic. Conflicts fail; the host retries the
whole command with the same ID and fresh observations. User callbacks must contain
no irreversible external effects: two competing callers may both build although
only one commits. Express outgoing intents through the outbox. Interruption or a
lost commit response can leave an uncertain outcome; recover by command ID.

There are no `enforce: false`, `unguarded: true`, or unpinned client modes. Opting
out means explicitly acquiring the existing lower-level `Triples` service in host
or migration code and writing the desired operations/meta there. This is a deliberate
escape hatch, not a compatibility flag. Raw client Datalog escapes model syntax,
but never schema checking. Authorization is not guaranteed by hiding Triples.

## 3. Reads, typed queries, pagination and `asOf`

`db.get(Type, entityId)` returns `Effect<Entity<Type> | null, DatabaseError>`.
Resolve/check one release, call `Triples.entity(entityId, basis)`, select facts
whose entityType equals Type.entityType, then call P2.3's planned `Type.decode`.
Return `{ entityId, values: decoded }` so IDs cannot collide with a field alias.
No selected facts means `null`; malformed facts are failures, not absence. The
decoder owns alias mapping, one/many cardinality and sealed-value representation.
P2.6 must use its approved exported result type rather than independently copying
HTTP's encoder or asserting that encrypted values are plaintext. Until P2.3 lands,
this typed return is a dependency, not a shipped capability. Do not pick a latest
value to hide corrupt single-valued state.

`db.list(Type, { limit?, cursor? }?)` returns `{ entities, snapshot, nextCursor? }`.
Call `Triples.entityPage({ entityType: Type.entityType, limit, cursor, basis })`
and decode each body identically to get. Preserve entity-ID order, the backend
snapshot, and page boundaries. Default 100, maximum 1,000; never fetch every entity
and slice in memory. No relationship expansion or implicit unbounded list.

Typed queries use existing model clauses and an explicit Effect Schema projection:

```ts
const OpenTraining = {
  find: ["?worker", "?site"],
  where: [
    ...Placement.where("?placement", { worker: "?worker", site: "?site" }),
    Worker.not("?worker", { trainedFor: "?site" }),
  ],
} as const;
const Row = Schema.Struct({ "?worker": Schema.String, "?site": Schema.String });
const read = Effect.gen(function* () {
  return yield* db.query(OpenTraining, { decode: Row, pageSize: 100 });
});
// page.results: readonly { readonly "?worker": string; readonly "?site": string }[]
```

`Type.where` encodes typed constants through handles and expands aliases to the
same clauses a caller writes by hand; `Type.not` builds the existing negation.
These arrays do not carry enough information to infer projection types, optional
bindings, aggregates, or a complete entity object. Require an explicit projection
schema and decode each flattened backend result binding with it. References in
Datalog remain strings unless the projection explicitly decodes a brand. Entity
objects come from get/list, not a hidden N+1 query behind every projected ID.

`db.raw(query, { pageSize?, cursor?, debug? }?)` forwards ordinary Datalog without
projection decoding. `db.rawPage(wrappedQuery, { debug? }?)` handles existing
wrapped queries, including their pagination fields. Both stay SchemaBound. No
client queryAll method: batch callers can explicitly use checked Triples.queryAll.
`query` uses the same options as raw plus required `decode`; it changes only the
result bindings, retaining backend count/debug/continuation fields.

Each logical read must check against its **captured** release. Reuse
`SchemaBound.layer({ ref })` over a request-local ConfigStore facade: its
`resolveRef(ref)` returns that already-resolved immutable snapshot; all other
methods delegate to the original service. Provide the original Triples beneath
that decorator. This is ordinary public Effect layer composition and prevents a
second live-ref resolution from checking against another release. ConfigStore's
own reads continue using its underlying store, avoiding a decorator cycle. Get and
list check the declared type before their direct entity reads; raw/typed queries
use the existing SchemaBound validation, including reserved attributes and shared
Datalog preflight. Do not copy the attribute checker or bypass Sensitive planning.

For continuation, use a versioned client cursor envelope containing operation kind,
release ID, local model fingerprint, and the backend's opaque cursor. Validate it,
load that release with `snapshotById`, and check compatibility again. Decode and
query with that captured release throughout pagination, even if live moves.
Forward the inner cursor unchanged: it binds database scope, query/type, temporal
basis and exact commit cut. A malformed envelope, changed model, missing release,
wrong call kind, wrong query/basis or cross-database cursor fails with
PaginationCursorError. The envelope is not an authorization token. First pages
resolve live; continuation pages do not substitute live for the captured release.
The row decoder is supplied again on continuation; its validation still runs on
every row. A failed decode fails the page, without returning partial success.

### A pinned read view

```ts
const read = Effect.gen(function* () {
  const then = yield* db.asOf({ validAt: lastTuesday });
  const placement = yield* then.get(Placement, placementId);
  const knownThen = yield* db.asOf({ recordedPosition: receipt.position, validAt: MAR_2 });
});
```

`asOf(basis)` is an **Effect**, unlike the review's synchronous sketch: acquiring a
stable recorded cut and schema can perform reads and fail. It returns a read-only
view with get/list/query/raw/rawPage and a `basis` plus `releaseId`; no command or
nested asOf. Resolve/check live once at view creation and retain that snapshot.
Capture omitted validAt once with Effect Clock and omitted recorded axis once
with `Triples.currentPosition`. Explicit recordedPosition is a safe integer from
zero through the captured head. Reject a future position, non-finite/negative
time, and simultaneous recordedAt/recordedPosition. Normal db reads retain the
engine's current-time defaults; the view supplies its fixed basis on every call.

For recordedAt, normalize to an exact position using public operations today:
capture head H, page `Triples.transactions({ after, limit: 1000 })` up to H, and
select the greatest position at or below H whose instant is at or before recordedAt,
or zero. Return `{ recordedPosition, validAt }`, never both recorded fields. This
is an explicitly O(journal) fallback, not an efficient timestamp index or a new
engine capability. The proposed `resolveRecordedBasis` in the [why RFC](./why.md)
can replace this only after approval/implementation with equivalence tests. Existing
position/omitted-axis view creation does not scan the journal.

The pinned schema is the one selected at view acquisition, not automatically the
release that happened to be live at the requested historical instant. Facts may
have been written under several releases; there is no single inferred historical
schema. For an old incompatible model the host supplies a matching layer/ref
pointing to that immutable release. Cursor continuations must match a view's
release and basis. This keeps historical data and configuration time distinct.

## 4. Compilation contract and proof obligations

No client operation reaches adapters, KV keys, SQL tables, private config entities,
or an internal transaction API. The following is the complete initial method set;
helpers described here compile to ordinary values or the public calls listed.
Clock reads, pure declaration checks, decoding and cursor encoding add no writes.

| Client call                        | ConfigStore operations                                                         | Triples operations and pure compilation                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| layer acquisition                  | resolveRef(ref)                                                                | None; nodesOf plus logical-node/CID comparison.                                                                                                                                                   |
| command, existing ID               | None                                                                           | transactionByCommand(commandId); return stored record.                                                                                                                                            |
| command, new ID                    | resolveRef(ref)                                                                | transactionByCommand; builder reads below; exactly one transact with GraphConstraint.pinned(release) and combined guards; transaction(txId). On duplicate claim only, transactionByCommand again. |
| tx.put / tx.create                 | None beyond command pin                                                        | Type.assert; create adds EntityAbsent; no immediate write.                                                                                                                                        |
| tx.get                             | None beyond command pin                                                        | One history(entityId) per observed entity; filter unretracted IDs for EntityState, visible intervals/type for Type.decode.                                                                        |
| tx.fact                            | None beyond command pin                                                        | get(tripleId); validate source; return Triple.                                                                                                                                                    |
| tx.end / replace / correct         | None                                                                           | Corresponding Type verb, hence Change.end/replace/correct, combined without rewriting operations or guards.                                                                                       |
| tx.retract                         | None                                                                           | One retract op and TripleLive; no retract-pattern expansion.                                                                                                                                      |
| tx inbox/outbox append/acknowledge | None                                                                           | Existing append-entry/acknowledge-entry TransactOp values; all submitted with the same facts/meta.                                                                                                |
| db.get / view.get                  | resolveRef/check once, or retained view snapshot                               | entity(id, basis), type selection and Type.decode.                                                                                                                                                |
| db.list / view.list                | resolveRef first page, snapshotById on continuation, or retained view snapshot | entityPage with backend cursor; Type.decode for each body.                                                                                                                                        |
| db.query / view.query              | Same release selection as paged reads                                          | Captured-release SchemaBound.query, hence Triples.query with unchanged Datalog/options; Schema.decodeUnknownEffect per row.                                                                       |
| db.raw / view.raw                  | Same                                                                           | Captured-release SchemaBound.query, no result decoder.                                                                                                                                            |
| db.rawPage / view.rawPage          | Same                                                                           | Captured-release SchemaBound.queryPage with wrapped query unchanged except unwrapping/rewrapping its cursor.                                                                                      |
| db.asOf                            | resolveRef/check once                                                          | currentPosition; for timestamp only, bounded transactions pages through captured H; fixed Clock validAt; no entity reads/writes until view use.                                                   |

Before P2.6 implementation, write failing tests using spy public services. Compare
generated `TransactOp[]`, complete TransactionMeta, guards, Datalog objects and
options with hand-written fixtures using deep equality, not merely equivalent
query results. Include explicit and omitted intervals, all three temporal verbs
against the sequences in [concepts](../concepts.md), one/many aliases, reference
encoding, sealed past reuse, create, retract, both entry kinds and acknowledgement.
Assert call order and zero transact on failed builds; duplicate fast path does no
ref lookup/callback and the concurrent loser returns the exact winner receipt.

Add shared KV/SQLite/PostgreSQL behavior cases for constraint rejection, atomic
entry/fact rollback, complete EntityState guards including future facts and an
insertion-only race, stale TripleLive, compatible/incompatible ref moves, same-ID
retries and uncertain-response recovery. Read tests cover decoder failures, null,
sealed values, model-constant queries versus hand clauses, unknown attributes,
page boundaries/cross-world cursors, ref movement between pages, and view stability
across same-millisecond commits and corrections. Prove persisted-only command reads
after queued writes. A raw query must fail on a misspelled attribute before backend
execution. No tests are added in this design-only item; those are implementation
acceptance requirements, not claimed passing checks.

## 5. Error channel and diagnostic codes

Use an explicit `DatabaseError` union of the actual read, transaction, config,
canonical/schema and sensitive errors reached by the calls above, plus the approved
P2.3 decode error type. Do not erase them into `unknown` or catch all failures as
not-found. `command` additionally preserves callback error E unchanged; hosts own
diagnostics for their own domain errors. Defects and Effect interruption stay
outside the typed failure channel. Never catch a programmer defect and retry it.

Normalize client input errors and known pure-builder exceptions to the existing
ValidationError with a path and fix. Preserve the original cause locally. For
config/decoding errors currently outside the public diagnostic module, wrap in
ReadError for storage corruption or ValidationError for invalid input/data shape;
do not send an unrecognized config error to diagnose and pretend `internal` is a
useful recovery code. P2.6 must document these mappings in docs/errors.md and add
diagnostic tests. This RFC requires no new stable code or error class.

| Failure                                                                                                                                                                                   | Existing docs/errors.md code                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Missing live ref, declared node mismatch, invalid meta/basis, unknown type/alias, empty put, builder misuse, invalid temporal split or typed source, projection/entity decode shape error | validation.failed; paths such as schema.types, meta.commandId, basis.recordedAt, command.replace.at, results[3].                   |
| Config persistence/corruption, history/entity/journal lookup failure, impossible missing receipt                                                                                          | read.failed, with cause retained locally and no silent null conversion.                                                            |
| Unknown raw-query attribute                                                                                                                                                               | schema.unknown-attribute, retaining nearest-key fix/path. Unwrap the known SchemaBound match cause only if match is later exposed. |
| Invalid Datalog, parsing, binding, projection, grouping, aggregates or predicates                                                                                                         | Existing datalog.\* codes from diagnose, including grouping-specific subcodes; unchanged.                                          |
| Preconditions, serialization or deadlock                                                                                                                                                  | transaction.conflict.precondition / serialization / deadlock; only these are automatically eligible for a host retry.              |
| Post-state constraints                                                                                                                                                                    | constraint.violation; retain violations and their validAt diagnostics.                                                             |
| Operational key collision                                                                                                                                                                 | operational.entry-conflict.                                                                                                        |
| Duplicate command claim                                                                                                                                                                   | Handled as receipt recovery; low-level escape retains transaction.command-already-committed.                                       |
| Cursor or release continuation mismatch                                                                                                                                                   | pagination.invalid-cursor.                                                                                                         |
| Missing required source fact / already retracted source                                                                                                                                   | triple.not-found / transaction.conflict.precondition respectively. Missing entity get is successful null.                          |
| Other backend write/transaction/fact validation failures                                                                                                                                  | Existing write.failed, transaction.failed, triple.invalid or triple.duplicate according to the underlying typed error.             |
| Unsupported sensitive planning / codec failure                                                                                                                                            | sensitive.query / sensitive.value; never expose plaintext through errors.                                                          |

Always use `diagnose` for recognized errors instead of duplicating code strings in
transport implementations. Projection Schema errors are validation failures even
when the Datalog itself was valid. Do not log query constants, values, payloads,
sealed envelopes or arbitrary causes in diagnostics.

## 6. Future pieces slot into the same boundary

- **P2.3 decode:** one decoder used by get/list/tx.get. Its eventual treatment of
  required missing fields and sealed values is authoritative; approval of this RFC
  cannot substitute for that implementation's result/error contract.
- **P2.2 validators:** compose validators on the supplied Triples before providing
  Database. They run in its one transact boundary; no pre-commit Datalog check in
  the client substitutes for them. Follow settled D7: validators can see inbox and
  outbox entries read-only in the after-view. Preserve the approved CommitRejected
  error and add its stable diagnostic mapping when that error lands; no code for
  this planned error is claimed to exist in docs/errors.md today.
- **why:** after the separate RFC is approved and implemented, a client convenience
  can delegate to Why.why with the view basis. Stop at transaction/release by
  default and follow causation only to the requested depth. Initial P2.6 exposes
  no placeholder why method and invents no provenance from decoded objects.
- **P4.3 live queries:** a future watch takes the same query/projection definition
  and delegates feed/dependency/wakeup behavior to the approved live-query service.
  It must define release-change and decoder-failure events there. Static asOf
  views do not watch. No polling loop or subscription design is settled here.
- **P3.3 preview:** reuse compiled ops/meta/guards and the existing overlay, then
  commit with the same command ID. No new write semantics, external delivery or
  authorization capabilities are implied by preview.

## 7. Documentation and adoption after approval

Lead with the client in docs/getting-started.md, docs/agents.md, the homepage
site-safety snippets, and examples/compliance-host's command/read handlers. Update
configuration, concepts, operational-primitives, errors and host-integration pages
to distinguish client defaults from explicitly managed Triples. Keep Datalog and
custom-runtime documentation as the primitives reference. Update checked snippets,
generated story outputs and HTTP examples where they demonstrate application
composition; do not redesign HTTP response contracts merely to adopt a client.
README.md waits for the owner's standalone-audience decision. The vendor-risk
report stays historical; run a fresh P2.7 trial rather than editing its findings.

In docs/agents.md, command rules 1, 2, 4, 7, 8 and 9 become client behavior (one
transaction, required identity, pin+enforce, temporal guards and guarded tx.get).
The guide should teach these defaults once and explain the lower-level escape.
Rule 3's correlation/causation remains optional but recommended. Rules 5 and 6
remain domain modeling duties: shared intervals do not infer business dates or
make referenced entities exist earlier. Release publishing, authorization,
domain invariants, obligation reconciliation, checkpointing, delivery, temporal
wakeups, retention and retries remain host duties. The vendor-risk expiry trap
still needs detection and a timer; an enforced command cannot stop time passing.
The client also does not change `_tx` valid-time joins: keep the documented
two-stage audit workaround until D2's separate semantics are approved and built.

## 8. Site-safety example: before and after

The model, synthetic IDs and MAR_2 are the existing declarations from
[app.ts](../snippets/home/site-safety/app.ts). Both versions assume Site/Worker
already exist at MAR_2. Both preserve a single command receipt and enforce
required/reference constraints across valid-time boundaries. Publishing releases,
derivation evaluation and HTTP serving remain the existing host code.

The command region today (16 nonblank, non-comment lines, excluding region markers):

```ts
export const placeWorker = (
  release: InMemoryConfigStore.ConfigSnapshot,
  placement: EntityId,
  worker: EntityId,
  site: EntityId,
) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    const facts = Placement.assert(placement, { worker, site }, { validFrom: MAR_2 });
    return yield* triples.transact(facts, {
      actor: "user:dana",
      commandId: `create:${placement}`,
      correlationId: "request:7f3a",
      ...(yield* GraphConstraint.pinned(release)),
    });
  });
```

Against the client (12 such lines):

```ts
export const placeWorker = (placement: EntityId, worker: EntityId, site: EntityId) =>
  Effect.gen(function* () {
    const db = yield* Database.Database;
    return yield* db.command(
      {
        actor: "user:dana",
        commandId: `create:${placement}`,
        correlationId: "request:7f3a",
      },
      (tx) => tx.put(Placement, placement, { worker, site }, { validFrom: MAR_2 }),
    );
  });
```

The reduction also removes the caller's release parameter. There are intentional
behavior improvements: live is resolved and checked per command, and duplicate
IDs return the original journal record rather than failing at transact. `put`
preserves today's assertion semantics; use create if WorldVM needs strict creation.

The existing audit region can stay unchanged beside this client, using the host's
Triples and ConfigStore services. Its fact-level `trained` helper and client form
are shown together below. They share the already-looked-up receipt:

```ts
// Today: eight nonblank, non-comment lines, including the generator wrapper.
const read = Effect.gen(function* () {
  const trained = (basis: TemporalBasis) =>
    triples
      .match({ entityId: maria, attribute: Worker.trainedFor.key }, basis)
      .pipe(Effect.map((facts) => facts.length > 0));
  const trainedAsKnownThen = yield* trained({ validAt: MAR_2, recordedAt: receipt.instant });
  const trainedAsKnownNow = yield* trained({ validAt: MAR_2 });
});
```

```ts
// Client: six nonblank, non-comment lines, including the generator wrapper.
const read = Effect.gen(function* () {
  const then = yield* db.asOf({ validAt: MAR_2, recordedPosition: receipt.position });
  const now = yield* db.asOf({ validAt: MAR_2 });
  const trainedAsKnownThen = ((yield* then.get(Worker, maria))?.values.trainedFor.length ?? 0) > 0;
  const trainedAsKnownNow = ((yield* now.get(Worker, maria))?.values.trainedFor.length ?? 0) > 0;
});
```

Here the example assumes P2.3 returns an empty array for an absent many-valued
alias, matching the intended entity decoder; adjust the expression to its approved
shape if that differs. This replaces only the training-state calculation: actor,
governedBy and liveToday still come from the existing journal/config audit code.
No future why implementation is silently counted as a current read reduction.

The open-work clauses remain exactly OpenTraining in section 3. For an ordinary
bounded UI read, `yield* db.query(OpenTraining, { decode: Row })` replaces a raw
Triples query and host projection casting. For task identity, provenance and
recheckAt, keep the existing Derivation.make/evaluate path in app.ts; a decoded
query page is not a derivation candidate or a scheduler.

For runtime composition the existing Store is three nonblank lines for SQLite;
the client adds one `Database.layer(...).pipe(Layer.provide(Store))` declaration
(one line in this presentation). The model and release publication stay the same.
Counts compare only the displayed region pairs, excluding imports, comments and
blank lines; they do not claim that the whole app shrinks by these percentages or
hide the once-per-world layer cost. HTTP/server lines are unchanged.

## 9. Owner questions before P2.6

Recommend approving the following together under D3; these are proposed details,
not requests to revisit the settled Effect-only, WorldVM-first or backend decisions:

1. Approve conservative node/CID compatibility with extra release objects allowed,
   host-only publishing, and admission-time live pinning. Does WorldVM require a
   commit-time release fence instead of host draining? That would need a separate
   public config-ref precondition design before claiming such a guarantee.
2. Approve append-style put plus strict create, required actor/commandId, receipt-only
   command results, and persisted-only guarded entity reads inside callbacks.
   Automatic upsert or read-your-writes would require additional temporal/overlay
   semantics; neither should be inferred from the verb put.
3. Approve explicit Effect Schema query projections and no implicit entity hydration.
   This avoids pretending today's Type.where arrays encode a result type.
4. Approve effectful asOf, current-schema historical views and the public journal-scan
   timestamp fallback. If WorldVM needs frequent recordedAt reads, prefer approving
   the shared resolveRecordedBasis prerequisite from the why RFC before P2.6.
5. Approve the core database subpath and explicit Triples escape with no client
   safety-disable flags. Confirm adoption scope above; README continues to wait.

This RFC alone has no breaking package change and needs no Changeset. P2.6 must
record any public error-union/export changes in a Changeset, settle P2.3's concrete
decode types, and integrate approved validator diagnostics when available. No
owner approval, implementation completion or trial success is implied here.
