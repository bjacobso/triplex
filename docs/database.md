---
description: Schema-bound Effect commands and typed reads over any Triples backend.
---

# Database client

`@triplex-build/triplex/database` is the application front door over `Triples` and
`ConfigStore`. Each command has a required actor and command ID, pins the current
release, enforces its constraints, and returns the persisted transaction receipt.
Typed entity reads use your declarations; queries use an explicit Effect Schema
projection. KV and SQLite are supported; PostgreSQL is a pre-1.0 production candidate.

## Compose once per database

The host publishes the model and chooses the backend. Layer acquisition resolves
`live` (or the supplied `ref`) and checks every declared node and reference-target
closure by logical identity and CID. Extra release objects are allowed, and all
release constraints are enforced. Missing or incompatible releases fail acquisition.
The client never publishes configuration.

```ts check
import { Effect, Layer, Schema } from "effect";
import { EntityId, KvTriples } from "@triplex-build/triplex";
import { Attribute, ConfigStore, EntityType } from "@triplex-build/triplex/config";
import * as Database from "@triplex-build/triplex/database";

const Site = EntityType.make("Site", {
  name: Attribute.text(":site/name").required(),
});
const Worker = EntityType.make("Worker", {
  name: Attribute.text(":worker/name").required(),
  trainedFor: Attribute.ref(":worker/trained-for", Site).many(),
});
const Model = { types: [Worker] } as const;
const Store = ConfigStore.layer.pipe(Layer.provideMerge(KvTriples.layer));
const World = Database.layer({ schema: Model });
const worker = EntityId.make("worker:maria");

// Publishing is host-owned and precedes Database acquisition.
const publish = Effect.gen(function* () {
  const config = yield* ConfigStore.ConfigStore;
  yield* config.commit({
    label: "workers-v1",
    objects: yield* EntityType.nodesOf(Worker), // includes the referenced Site
    ref: "live",
  });
});
const program = Effect.gen(function* () {
  const db = yield* Database.Database;
  const receipt = yield* db.command(
    { actor: "user:dana", commandId: "create:worker:maria" },
    (tx) => tx.create(Worker, worker, { name: "Maria" }, { validFrom: 0 }),
  );
  const entity = yield* db.get(Worker, worker);
  const page = yield* db.list(Worker, { limit: 100 });
  const names = yield* db.query(
    { find: ["?name"], where: Worker.where("?worker", { name: "?name" }) },
    { decode: Schema.Struct({ "?name": Schema.String }), pageSize: 100 },
  );
  const then = yield* db.asOf({ recordedPosition: receipt.position, validAt: 0 });
  return { receipt, entity, page, names, knownThen: yield* then.get(Worker, worker) };
});
// Both effects share one Store instance. Real hosts publish during deployment.
const application = publish.pipe(Effect.andThen(program.pipe(Effect.provide(World))));
const main = application.pipe(Effect.provide(Store));
void main;
```

Substitute `SqliteTriples.layer({ filename: "world.db" })` or
`PgTriples.layerFromUrl(...)` for `KvTriples.layer`. Build once per world lifetime;
provide a `ConfigStore` backed by the same `Triples`. Sensitive models require the
existing [Sensitive layer and codec](/sensitive-values) beneath the client.

## Build one command

`command(meta, build)` returns `Effect<TransactionRecord, DatabaseError | E, R>`;
the callback returns `Effect<void, E, R>`. Callback domain errors stay unchanged.
`correlationId` and `causationId` are optional attribution metadata. Authorization
belongs to the host.

| Builder operation                                 | Compilation                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `put(Type, id, values, interval?)`                | Append `Type.assert` operations.                                                   |
| `create(Type, id, values, interval?)`             | The same assertions plus an `EntityAbsent` precondition across all valid time.     |
| `get(Type, id, { validAt? }?)`                    | Decode persisted state; guard the complete unretracted history with `EntityState`. |
| `fact(Type, tripleId)`                            | Fetch and validate a raw source fact for a temporal edit.                          |
| `end(Type, fact, at)`                             | Retract and preserve the past through `Type.end`.                                  |
| `replace(Type, fact, { alias: value }, at)`       | Preserve the past and original end through `Type.replace`.                         |
| `correct(Type, fact, { alias: value })`           | Replace over the original interval through `Type.correct`.                         |
| `retract(Type, fact)`                             | Retract the whole interval with a `TripleLive` guard.                              |
| `inbox.append(input)`, `outbox.append(input)`     | Append an operational entry in the same transaction.                               |
| `inbox.acknowledge(id)`, `outbox.acknowledge(id)` | Acknowledge an entry in the same transaction.                                      |

`put` appends assertions. For a cardinality-one change, use a temporal verb.
Empty puts and undeclared aliases/types fail validation. Explicit intervals are
shared across assertions; omitted `validFrom` remains omitted for the engine to
assign at commit. Required fields and reference targets are checked in the atomic
post-state, across valid-time boundaries.

Builder methods are Effects and must run sequentially in the callback's fiber.
The builder becomes invalid when the callback ends. Failed callbacks submit nothing;
all successful builds submit exactly one `Triples.transact`.

There is no read-your-writes overlay. `tx.get` and `tx.fact` read persisted facts,
even after queued writes. `tx.get` observes each entity once through the indexed
`Triples.liveFacts` read, loading only unretracted facts, including past and future intervals;
different `validAt`
reads filter that observation. Its default time is the command-start Effect Clock.
A `tx.fact` read alone adds no guard; consuming it in a retracting verb adds
`TripleLive`. There are no builder Datalog or list methods; use
[commit validators](/commit-validators) for predicate or absence invariants.

## Preview before committing

`preview(meta, build, { derivations? }?)` runs the same sequential builder and pins
one release, without calling `transact`, claiming the command ID, or running commit
validators. It returns a JSON-serializable `Preview`:

- `release`: the pinned release ID.
- `operations`: `{ ops, preconditions }` from the shared command compiler. Sensitive
  assertion values are sealed before this object is returned.
- `changes`: assertion and retraction descriptions with entity, attribute, typed
  value and valid interval. Retractions include the existing `tripleId`. Assertions
  omit their not-yet-allocated IDs. Commit IDs and timestamps are omitted.
- `violations`: new or worsened graph violations, including `constraintKey`,
  `subject` and `validAt`, computed by the transaction enforcement functions.
  Violations are returned successfully so an approver can inspect them.
- `derivations`: one reconciliation per supplied definition, identified by
  `definition`, with `added`, `removed`, `changed` (`before`/`after`) and `unchanged`
  candidates. Evaluation uses the existing read-only derivation overlay at preview
  time, including hypothetical source provenance.
- `commandAlreadyCommitted`: the existing receipt when the ID was already used.
  In that case the callback is skipped, `release` is the original receipt's release,
  and operations, changes, violations and derivations are empty. A receipt created
  through primitive `Triples` without a release returns `release: null`.

```ts check
import { Effect } from "effect";
import { EntityId } from "@triplex-build/triplex";
import { Attribute, EntityType } from "@triplex-build/triplex/config";
import * as Database from "@triplex-build/triplex/database";

const Person = EntityType.make("Person", {
  name: Attribute.text(":person/name").required(),
});
const meta = { actor: "user:dana", commandId: "person:ada:create" };
const build = (tx: Database.Command) =>
  tx.create(Person, EntityId.make("person:ada"), { name: "Ada" }, { validFrom: 0 });
const preview = Effect.gen(function* () {
  const db = yield* Database.Database;
  return yield* db.preview(meta, build);
});
// After approval, provide the same configured Database layer and command callback.
const commit = Effect.gen(function* () {
  const db = yield* Database.Database;
  return yield* db.command(meta, build);
});
void preview;
void commit;
```

A preview is advisory: commit rebuilds and checks the command against the then-current
store and release. Use the same command ID and callback; keep callbacks deterministic
and supply explicit intervals when comparing changes. Omitted `validFrom` projects
at preview time and is assigned again at commit. Randomized sensitive ciphertext
also differs between preview and commit; plaintext is never returned. Journal change
ordering is backend-dependent, so compare semantic change sets.

Preconditions, operational entry conflicts, and host commit validators are checked
at commit. Inbox/outbox operations appear in `operations`; they produce no triple
changes, matching the journal. Unsupported derivation overlays fail with `read.failed`.
Constraint preview discovers typed subjects through the transaction journal and loads
unretracted histories, including past and future intervals. This can read substantial
history on a large database. Preview does not reserve state against concurrent writers.

## Releases, retries, and receipts

Every new command and ordinary read resolves and checks the current ref. A command
admitted under release R finishes under R if `live` moves during its callback.
This is admission-time pinning. A host needing a stronger promotion boundary must
drain in-flight commands.

Before resolving the ref or running the callback, `command` looks up the command
ID. An existing ID returns its original receipt, including its original actor and
release. Reusing an ID with another payload never executes that payload. Concurrent
claim losers also recover the winner's receipt. A missing or unreadable receipt
fails with `read.failed`; retry the same ID after an uncertain response.

Other conflicts are returned to the host. Reload and retry the complete command
with the same ID. Callbacks must contain no irreversible external actions; record
outgoing intents in the outbox. Delivery, timers, reconciliation, checkpoints,
authorization and retention remain host responsibilities.

## Typed reads and bounded queries

`get(Type, id)` returns `{ entityId, values }` or `null`. Missing state is successful
absence; malformed facts fail validation. The shared `Type.decode` owns aliases,
cardinality, requiredness and sealed markers. Sensitive values stay sealed.

`list(Type, { limit?, cursor? })` returns `{ entities, snapshot, nextCursor? }`.
It delegates to `entityPage`; default 100, maximum 1,000. It preserves ordering and
page boundaries. `query(query, { decode, pageSize?, cursor?, debug? })` decodes each
result binding with the supplied Schema, retaining count/debug/continuation fields.
References remain strings unless the projection decodes them differently. A failed
decode fails the whole page.

`raw(query, options?)` forwards bounded Datalog without projection decoding.
`rawPage(wrappedQuery, { debug? }?)` supports the existing wrapped-query shape,
including its cursor. Both use `SchemaBound` against the captured release. Unknown
attributes fail before backend execution. Use `Triples.queryAll` explicitly for
trusted batch work; there is no unbounded client query.

Return the client cursor unchanged to the same operation with the same query,
type and basis. The envelope retains the release and local model fingerprint;
continuations load that immutable release even when `live` changes. The inner
backend cursor retains the exact read cut and database scope. Malformed or
mismatched continuations fail with `pagination.invalid-cursor`. Cursors are not
authorization tokens. Give each world a distinct backend cursor scope.

## Stable read views

`yield* db.asOf(basis)` returns a read-only view with `get`, `list`, `query`, `raw`,
`rawPage`, `basis` and `releaseId`. It captures omitted `validAt` once with Effect
Clock, and omitted recorded time once with `Triples.currentPosition`. Supply at
most one of `recordedAt` and `recordedPosition`. Positions are safe integers from
zero through the captured head; instants must be finite and nonnegative.

`recordedAt` uses `Triples.resolveRecordedBasis` to find the greatest eligible
position through one captured head, without paging the journal. Equal instants
include every commit at that instant visible at capture; future timestamps resolve
to the captured head, and timestamps before the first commit resolve to zero.
Exact positions keep views stable across same-millisecond commits and later
corrections.

Views retain the schema selected at acquisition. They do not infer which release
was live at a historical time. For an incompatible older model, provide a matching
layer/ref. A view supplies its fixed basis on every read and cannot write.

## Errors and the primitive escape

`DatabaseError` names the client error channel. Client input and decode-shape
failures use `validation.failed`; storage/config corruption and receipt failures
use `read.failed`. Unknown attributes, Datalog, constraints, conflicts, operational
entries, cursors and sensitive planning keep their existing diagnostic codes. See
[error diagnostics](/errors#database-client-mappings).

Acquire `Triples` explicitly in host or migration code for lower-level operations.
The client has no flags to disable pinning, enforcement or guarded entity reads.
