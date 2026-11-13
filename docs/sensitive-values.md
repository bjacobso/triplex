# Sensitive values

Status: **pre-1.0, opt-in.** This page is the design record and reference for sensitive attribute
values: what they are, which guarantees Triplex gives, and what remains host work.
[Implementation status](#implementation-status) at the end separates built features from
designed ones.

## Problem

Triplex stores every value in typed plaintext columns or KV records, and Datalog, indexes,
uniqueness checks and graph constraints compare those values directly. Nothing marked an
attribute as sensitive, so a database that holds national identifiers, birth dates or document
numbers kept them readable in every table, journal payload, snapshot and backup. The configuration
layer's observation digests (`config/World.ts`) avoid copying values into decision records, but
they are not encryption and do not protect the facts themselves.

A sensitive attribute needs four properties together:

1. **Declared, not inferred.** Sensitivity is part of the attribute's content-addressed identity,
   so changing it appears as a changed configuration node in a release rather than as a runtime
   toggle.
2. **Sealed at rest.** Writes seal the value through a pluggable codec before it reaches storage.
   Plaintext never lands in a value column, index key, journal payload, snapshot table or error
   message.
3. **Opened only on purpose.** Reads return the sealed form. Plaintext requires an explicit,
   typed `open` effect that needs the codec, and therefore key access, in context.
4. **Honest queries.** Datalog, constraints and derivations either compute the right answer from
   what the store can compare (presence and keyed equality), or fail during planning with a typed
   error that names the attribute. They never return a silently wrong answer.

## Quick start

```ts check
import { Effect, Layer } from "effect";
import { EntityId, KvTriples, Triples } from "@triplex-build/triplex";
import { Attribute, EntityType } from "@triplex-build/triplex/config";
import { KeyProvider, Sensitive, ValueCodec } from "@triplex-build/triplex/sensitive";

const ssn = Attribute.sensitive(Attribute.text(":employee/ssn"));
const name = Attribute.text(":employee/name");

const Employee = EntityType.make("Employee", {
  ssn: Attribute.use(ssn, { unique: true }),
  name: Attribute.use(name, { required: true }),
});

// Decorate any backend's Triples. Test keys are for tests only.
const layer = Sensitive.layer({ database: "acme/main", attributes: [Employee] }).pipe(
  Layer.provide(ValueCodec.aesGcm),
  Layer.provide(KeyProvider.test({ seed: "test-only" })),
  Layer.provide(KvTriples.layer),
);

const program = Effect.gen(function* () {
  const triples = yield* Triples;
  const employee = EntityId.make("employee:1");
  yield* triples.assertBatch([
    { entityId: employee, attribute: ":employee/name", value: { type: "string", value: "Ada" } },
    {
      entityId: employee,
      attribute: ":employee/ssn",
      value: { type: "string", value: "123-45-6789" },
    },
  ]);

  // Equality goes through the blind index; the plaintext never reaches storage.
  const { results } = yield* triples.queryAll({
    find: ["?name"],
    where: [
      ["?e", ":employee/ssn", "123-45-6789"],
      ["?e", ":employee/name", "?name"],
    ],
  });

  // Reads return sealed values. Opening is explicit and needs the codec.
  const sealed = yield* triples.entity(employee);
  const opened = yield* Sensitive.open(sealed);
  return { results, sealed, opened };
});

export const main = program.pipe(Effect.provide(layer));
```

## Model

### Marking an attribute

`Attribute.sensitive(definition)` returns a definition with `sensitive: true`. Its config node
records `sensitive: true` in its attributes, so the node's content ID changes and every release
that adopts it shows a changed attribute node. Non-sensitive attributes keep their existing content
IDs because the field is omitted when false. `EntityType` handles expose `sensitive` per attribute.

`Attribute.sensitive(definition, { keyClass })` also names a **key class**, a short lowercase
label such as `retention-7y`. A subject's values in different key classes are sealed under
different data keys, so one class can be erased while another is kept, for example a passport
number kept for one year and a tax identifier kept for seven. Attributes without a key class use
the subject's `default` class; `default` is reserved and cannot be named explicitly. The key class
is recorded on the attribute node next to `sensitive: true`, so it is part of the node's content
ID and of every release that adopts it. A sensitive node without a key class keeps its earlier
content ID.

Reference attributes cannot be sensitive. A ref is graph identity, and sealing it would break
traversal, reference-target constraints and entity expansion. Blob attributes already store a
content hash rather than the content, so they are rejected too. Sensitive values may be
`string` (text, date and enum attributes), `number`, `boolean`, `datetime` or `json`.

The policy that the runtime enforces comes from one of three sources:

- `Sensitive.attributesOf([...])` collects marked definitions and entity types. It also accepts
  explicit `{ key, valueType, keyClass? }` descriptors.
- `Sensitive.attributesFromNodes(nodes)` reads `sensitive: true` attribute nodes, for example
  every node of a pinned release, so the release is the source of truth.
- `Sensitive.layer({ attributes })` accepts either form.

### The sealed value

Storage is self-describing. A sealed fact carries the `sealed` variant of `TripleValue`:

```ts
interface SealedValue {
  readonly type: "sealed";
  /** The declared plaintext type: string, number, boolean, datetime or json. */
  readonly valueType: SealableValueType;
  /** Codec-owned identity of the key that sealed the value (used by rotation). */
  readonly keyId: string;
  /** Codec-owned envelope, base64url. Opaque to Triplex. */
  readonly ciphertext: string;
  /** Keyed equality token, base64url, absent when the codec has no blind index. */
  readonly blind?: string;
}
```

Because storage records whether a value is sealed, a reader never has to guess. A policy that no
longer lists an attribute still sees older sealed facts as sealed. A sealed fact never becomes
plaintext through a configuration change; only an explicit open can produce plaintext.

Adding the variant widens `TripleValue`, `ValueType` and `Triple["value"]`. That is an additive data
change: databases without sensitive attributes never produce it, and existing rows decode exactly
as before. It is still a source-level change for TypeScript code that switches exhaustively over
`value.type`, so the Changeset marks the core package minor (the 0.x breaking slot). The
in-repository consumers (snapshots, constraints, validation, dashboard, HTTP and CLI) handle the
variant explicitly.

### Services

| Service       | Role                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `ValueCodec`  | Seals, opens and blinds one value, given a `SensitiveContext` (database, entity, attribute, value type).        |
| `KeyProvider` | Supplies data keys per subject and key class, and the per-database blind key, to the reference AES-GCM codec.   |
| `KeyCustody`  | Changes key lifecycle: destroys a subject's data keys (erasure) and makes a new key version current (rotation). |
| `Sensitivity` | The composed runtime capability: policy, codec and database identity. Used by `open`, derivations and overlays. |

```ts
interface SensitiveContext {
  readonly database: string;
  readonly entityId: string;
  readonly attribute: string;
  readonly valueType: SealableValueType;
  /** The attribute's key class; "default" when it declares none. */
  readonly keyClass: string;
}

interface ValueCodecService {
  readonly name: string;
  /** Which equal plaintexts share a blind token. */
  readonly blindScope: "database" | "attribute" | "none";
  readonly seal: (ctx: SensitiveContext, value: PlainValue) => Effect<Sealed, SensitiveValueError>;
  readonly open: (
    ctx: SensitiveContext,
    sealed: SealedValue,
  ) => Effect<PlainValue, SensitiveValueError>;
  readonly blind: (
    ctx: SensitiveContext,
    value: PlainValue,
  ) => Effect<string | undefined, SensitiveValueError>;
}
```

Codecs shipped in core (`@triplex-build/triplex/sensitive`):

- `ValueCodec.aesGcm` (or `ValueCodec.aesGcmWith({ subjectOf, blindScope })`) is the reference
  implementation over WebCrypto (`crypto.subtle`, available in browsers, Node.js 22 and workerd;
  core still imports no Node API). It uses AES-256-GCM with a random 96-bit nonce per value. The
  envelope is a version byte (2), the nonce and the ciphertext with its tag. The additional
  authenticated data binds the database, entity, attribute, declared type, key class and key ID,
  so a ciphertext cannot be moved to another fact or relabelled with another key ID. The blind token is HMAC-SHA-256 under the database blind key
  over a domain tag, the scalar family (number and datetime share one) and the canonical JSON
  plaintext. It is prefixed with the blind key ID. With the default `blindScope: "database"`, equal
  values in two sensitive attributes of one database join.
- `ValueCodec.identity` stores reversible base64url of the canonical plaintext with an unkeyed
  SHA-256 blind token. It gives development databases the same storage shape and query semantics
  as production, so turning encryption on swaps the codec rather than the schema. It is **not**
  confidential. `aesGcm` can still open identity envelopes until they are rewrapped.
- `KeyProvider.test({ seed })` and `KeyProvider.testKeys({ seed })` provide a deterministic
  `KeyProvider` and `KeyCustody` with **test keys only**. Anyone with the seed can open every value.
  Production hosts implement `KeyProvider` and `KeyCustody` over their key service.

The key contract:

```ts
interface KeyContext {
  readonly database: string;
  readonly subject: string; // from aesGcmWith({ subjectOf }); the entity ID by default
  readonly keyClass: string; // "default" when the attribute declares none
}

interface KeyProviderService {
  /** Current data key for new seals; fails with `destroyed` once the scope was erased. */
  readonly sealingKey: (context: KeyContext) => Effect<DataKey, KeyError>;
  /** The data key a stored key ID names. */
  readonly openingKey: (context: KeyContext, keyId: string) => Effect<CryptoKey, KeyError>;
  /** The database-wide HMAC key for blind tokens. */
  readonly blindKey: (database: string) => Effect<DataKey, KeyError>;
}

interface KeyCustodyService {
  /** Destroy a subject's data keys (one key class, or all); returns the destroyed key IDs. */
  readonly destroy: (scope: KeyScope) => Effect<ReadonlyArray<string>, KeyError>;
  /** Make a new data-key version current for a database, subject or key class. */
  readonly rotate: (scope: RotationScope) => Effect<void, KeyError>;
}
```

A key ID must name its key on its own and must not contain sensitive data. Opening resolves the
key from the stored key ID, so a value opens under the key that sealed it even if the host later
maps values to subjects or key classes differently. A provider may reject a key ID that does not
belong to the value's context. `KeyCustody` is separate so a host whose key service manages
lifecycle itself can provide only `KeyProvider`.

A blind key ID must not contain `:`, because blind tokens are stored as `<blind key ID>:<token>`.

### The SQL key store

`SqlKeyStore.layer({ database })` from `@triplex-build/triplex/sql` is the reference `KeyProvider`
and `KeyCustody` for real use on SQLite and PostgreSQL. It is never a default: a host opts in by
providing it.

```ts
import { KeyProvider, RootKey, Sensitive, ValueCodec } from "@triplex-build/triplex/sensitive";
import { SqlKeyStore } from "@triplex-build/triplex/sql";
import { SqliteTriples } from "@triplex-build/triplex/sqlite";

const rootKey = RootKey.fromBytes({
  current: { id: "root-2026-11", key: rootKeyBytesFromYourSecretManager },
});

const layer = Sensitive.layer({ database: "acme/main", attributes: [Person] }).pipe(
  Layer.provide(ValueCodec.aesGcm),
  Layer.provide(SqlKeyStore.layer({ database: "acme/main" })),
  Layer.provide(rootKey),
  Layer.provideMerge(SqliteTriples.layerWithSqlClient({ filename: "app.db" })),
);
```

It keeps keys in the database's own SQL storage, in tables created by SQL migration v10:

- `triplex_data_keys` holds one row per subject, key class and version. Each data key is 32 random
  bytes stored only wrapped (AES-256-GCM) under the root key; the row records which root key
  wrapped it. Its key ID is an opaque random `k1.<hex>`, so opening looks the key up by ID alone.
- `triplex_blind_keys` holds the database's blind key versions, wrapped the same way.
- `triplex_key_erasures` records erased scopes, so a key is never recreated for an erased subject or
  key class. Destroying a key clears its wrapped bytes and keeps the row, so the key ID resolves to
  "destroyed" rather than "unknown".

The **root key** is a `RootKey` service the host supplies, and it is never written to the database.
`RootKey.fromBytes` holds 32 bytes in process memory, for example read from a secret manager at
startup; a host can implement `RootKey` over its key service instead. Each wrapped key is
authenticated against its database and key ID, so it cannot be moved to another row. Pass earlier
root keys in `previous` while stored keys are still wrapped under them.

**Threat model.** This is envelope encryption. It protects a database file, dump or backup that
leaks _without_ the root key: the stored keys cannot be unwrapped, so neither sealed values nor
blind tokens can be computed or checked. It protects nothing if the root key is stored beside the
database, for example in the same disk image, backup or environment file, or if an attacker can run
code in a process that holds the root key. Keep the root key in a different place from the
database and its backups.

Two consequences for erasure. Destroying a key clears it from the live database, but an older backup
still holds the wrapped key, and anyone with that backup and the current root key can still unwrap
it. Erasure is complete against backups only after the root key is rotated, every live key is
rewrapped under the new root key and the old root key is destroyed. Rewrapping arrives with key
rotation. On SQLite, a cleared value can also survive in free pages or the write-ahead log until it
is overwritten or vacuumed.

The key store checks the database row on every open and seal, so a key destroyed by another process
is refused there too; only the unwrapped key bytes are cached in memory, keyed by key ID.

There is no implicit codec. `Sensitive.layer` requires `ValueCodec` in context, so declaring
sensitive attributes without choosing a codec fails to compose. This deliberately departs from an
identity-by-default design: forgetting to configure encryption must not store plaintext silently.

### Composition

`Sensitive.layer(options)` decorates any `Triples` and outputs `Triples | Sensitivity`:

```ts
const layer = Sensitive.layer({ database: "acme/main", attributes: [Employee] }).pipe(
  Layer.provide(ValueCodec.aesGcm),
  Layer.provide(hostKeyProviderLayer),
  Layer.provide(SqliteTriples.layer({ filename: "app.db" })),
);
```

It sits above the storage adapter, so it works the same way over every backend, including
Cloudflare and FoundationDB. Every core service that already reads `Triples` from context gets
the sealed behavior without new parameters. That includes `ConfigStore`, `EntityValidation`,
derivations and the HTTP handlers. A process that opens the raw backend layer without the
decorator still cannot read plaintext: it sees sealed values and has no keys.

`database` is the stable logical identity given to the codec. It scopes keys and blind tokens and
is bound into every ciphertext, so it must not change for the life of the database.

## Semantics

### Writes

`transact`, `assert` and `assertBatch` (which delegate to it):

- seal every `assert` whose attribute is sensitive, after checking the value against the declared
  type (number and datetime are interchangeable), and pass only the sealed value to the inner
  store;
- reject a caller-supplied `sealed` value for any attribute, except when the same transaction
  explicitly retracts a fact by ID on the same entity and attribute whose stored envelope and
  blind token are byte-identical. The layer verifies that fact through the inner `Triples.get`;
  a pattern retraction does not qualify. This lets `Change.end` and `Change.replace` preserve a
  sealed past without opening it while rejecting foreign ciphertext and forged blind tokens;
- rewrite `retract-pattern` value constants on sensitive attributes to blind matches;
- reject unique enforcement on a sensitive attribute when the codec has no blind index.

Write-side failures surface as `WriteError` whose `cause` is a typed `SensitiveValueError`. It
carries `attribute`, `reason` (`sealed-input`, `invalid-value`, `codec`, `key-unavailable`,
`key-destroyed`, `integrity` or `blind-index-unavailable`) and a message that never contains the
value. This keeps the `Triples` write signature unchanged.

Plaintext exists only in the caller's request and in the codec call. The commit's
`TransactionResult.triples` already carry the sealed values.

Use [the temporal verbs](/concepts#end-a-fact-at-a-time) with sealed facts just as with plaintext
facts. `end` reuses the verified ciphertext for the shortened interval; `replace` does the same
for the past and seals its new plaintext value from the split onward. `correct` seals its plaintext
replacement over the original interval. Submit the generated `TripleLive` preconditions with
the operations so a concurrent retraction fails with `TransactionConflictError`.

### Reads

`get`, `entity`, `entities`, `entityPage`, `match`, `history`, `transaction`, `transactions`,
`transactionByCommand` and `transactionsForEntity` return stored sealed values unchanged. The
journal's `:_tx/change` payload embeds the sealed value without its blind token, so history and
"what changed" reads show that a sensitive fact changed, by whom and when, without its plaintext.
Entity snapshots commit to the sealed envelope, also without the blind token.

**Blind tokens live only on the fact.** A sealed value's blind token is stored on the fact and in
its blind index (`value_blind` in SQL, the AVET entries in KV) and nowhere else: journal
payloads, transaction records and entity snapshots carry the key ID and ciphertext only. Erasure
can therefore remove a subject's tokens in one place. SQL migration v11 removes the copies that
earlier versions wrote into journal payloads, and drops entity snapshots that committed to a token;
`SnapshotWriter.backfill` and the next write recreate them. Existing SQLite and PostgreSQL databases
must run it. Cloudflare and FoundationDB storage is frozen and keeps any earlier copies.

`match` with a value on a sensitive attribute is rewritten to a blind-token lookup, so "which
person has this SSN?" is an indexed equality read. A value of a type that can never equal the
declared type matches nothing, as it would in plaintext. A value-only `match` (no attribute) fails
with `ReadError` whose cause is `SensitiveQueryError` (`value-only-match`) when the policy is
non-empty, because it could silently miss sealed facts.

Opening is explicit:

```ts
const reveal = (personId: EntityId) =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    const facts = yield* triples.entity(personId);
    return yield* Sensitive.open(facts); // fails with SensitiveValueError; requires Sensitivity
  });
```

`Sensitive.open` accepts a triple, an array of triples or a `TransactionRecord`, and leaves
non-sealed values untouched. It is the single place where Triplex produces plaintext, so hosts
authorize and audit this call.

### Datalog

The decorator validates and analyses every `query`, `queryAll`, `queryPage`, `explain` and
`explainPage` call against the policy before the inner engine runs. A variable is _sensitive_
when it occurs in the value position of a pattern on a sensitive attribute.

| Use                                                           | Result                                                                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Presence (`[?e ":person/ssn" ?_any]`) and its negation        | Allowed.                                                                                                                                                                                    |
| Constant in the value position                                | Allowed. Rewritten to a blind-token constant (`{ type: "blind", value }`) and answered from the blind index. A constant whose scalar family cannot equal the declared type matches nothing. |
| Join between two sensitive value positions                    | Allowed with a blind index, within one attribute or across attributes when the codec's `blindScope` is `database`.                                                                          |
| Join with a plaintext value or an identity position           | `SensitiveQueryError` (`join`).                                                                                                                                                             |
| Projection in `find`, `optionalProjection` or wrapper filters | `SensitiveQueryError` (`projection`).                                                                                                                                                       |
| `orderBy` (query or wrapper)                                  | `SensitiveQueryError` (`order`).                                                                                                                                                            |
| Comparison or equality predicate                              | `SensitiveQueryError` (`predicate`). Use a pattern constant for equality.                                                                                                                   |
| Aggregate source or `having`                                  | `SensitiveQueryError` (`aggregate`, `having`).                                                                                                                                              |
| Rule bodies and rule arguments                                | `SensitiveQueryError` (`rule`).                                                                                                                                                             |
| Variable attribute whose value is used or constrained         | `SensitiveQueryError` (`dynamic-attribute`), because the analysis cannot prove the attribute is not sensitive.                                                                              |
| Blind-dependent use when the codec's `blindScope` is `none`   | `SensitiveQueryError` (`blind-index-unavailable`).                                                                                                                                          |

`SensitiveQueryError` is a member of `DatalogQueryError`. It carries `attribute` and `operation`,
and its message names the attribute and never a value. Full-text search is not part of Triplex
Datalog today. When the roadmap's `fts` predicate lands, it must reject sensitive variables through
the same analysis.

As defense in depth, the engines enforce the same boundary without the decorator. A raw Datalog
read projects a sealed binding as `null`. It never matches a sealed value against a plaintext
constant or binding, joins sealed values only on equal blind tokens, and excludes them from rule
closure. A sealed value without a blind token equals nothing. KV, SQLite, PostgreSQL and the
Durable Object backend agree on this in the shared `sealedStorageCases`.

### Constraints and validation

- **Required** and **cardinality** count facts and work unchanged.
- **Unique** compares the blind token (`sealed:<blind>`) instead of the canonical value. Without a
  blind index, a transaction that enforces a unique rule on a sensitive attribute fails before
  mutation; the rule is never skipped.
- **Reference-target** cannot apply, because ref attributes cannot be sensitive.
- Violation messages omit values, and `valueIdentity` for a sealed value is the blind token.
- `EntityValidation` checks the presence and cardinality of sealed fields. Their plaintext type was
  enforced when they were sealed. The committed state CID covers the sealed envelope.

### Derivations and overlays

Derivations plan their query through `Sensitivity` when it is in context. A derivation that
projects, orders or compares a sensitive value fails with `SensitiveQueryError` when it is
evaluated. Derivations may use sensitive attributes for presence and blind equality, for example
"employees without an SSN on file" or "applicants whose SSN matches an employee". Sensitive value
variables are withheld from the internal provenance projection. Candidate provenance still records
every sealed source fact by triple ID, never a plaintext value.

`evaluateOverlay` seals hypothetical assertions on sensitive attributes before seeding its
in-memory store, so they compare exactly like committed facts and never reach its indexes in
plaintext. A hypothetical fact's content identity commits to its blind token, not to plaintext or
randomized ciphertext.

`ConfigRuntime` evaluation reads scalar facts into a `World`. A rule that reads a sealed fact fails
with `UnsupportedDecisionFactError`. A rule such as "older than 18" from a sealed birth date needs
an explicit host decision to open the value, which is future work.

### Surfaces

| Surface   | Default                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP      | Entity reads return sensitive fields as `{ "$sealed": { "valueType", "keyId" } }`, without ciphertext or blind token. Writes accept plaintext and seal through the decorated `Triples`. A write to a sensitive attribute fails closed when `Sensitivity` is absent. There is no plaintext read route; hosts call `Sensitive.open` in their own handler after authorization. |
| CLI       | Entity, history, journal and query output prints sealed values as `{ "type": "sealed", "valueType", "keyId" }`. The CLI has no key access and no open command.                                                                                                                                                                                                              |
| Dashboard | Sealed values render as `sealed · <valueType>` and cannot be edited in form mode.                                                                                                                                                                                                                                                                                           |

"Never plaintext by accident" holds structurally: each surface sees only what `Triples` returns,
and `Triples` returns sealed values.

## Storage

All backends store the same logical sealed value. The ciphertext and blind token are kept in
dedicated places, and the plaintext value columns stay empty.

| Backend                    | Ciphertext                                                          | Blind token                                                                                                   | Index                                                                                              |
| -------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| SQLite, PostgreSQL         | `value_sealed TEXT` (JSON envelope: value type, key ID, ciphertext) | `value_blind TEXT`                                                                                            | `idx_attr_blind ON triples(attribute, value_blind) WHERE value_type = 'sealed'` (SQL migration v3) |
| Cloudflare Durable Object  | Same columns                                                        | Same column                                                                                                   | Same index (Cloudflare migration v4)                                                               |
| In-memory KV, FoundationDB | `META` record value tag 7 (envelope and optional blind)             | Tuple tag `0x08` over `blind:<token>`, or `opaque:<ciphertext>` without a blind index, in EAVT, AEVT and AVET | AVET on `(attribute, sealed token)`                                                                |

SQL migration v3 admits `sealed` in the `value_type` check, adds both columns and the index, and
requires an envelope on sealed rows. PostgreSQL replaces the check constraints in place. SQLite
cannot alter a check constraint, so v3 rebuilds `triples` with SQLite's create-copy-drop-rename
procedure and recreates every index. The rebuild is proportional to the table size. Existing rows
are copied unchanged. `runMigrations` now applies each migration and its applied record in one
transaction. The exported `Migration` gained optional per-dialect statements (`dialects.sqlite`,
`dialects.pg`) that run before the portable `up` statements. Hosts that execute migrations
themselves must run their dialect's statements first.

The columns are `TEXT` (base64url) rather than `BLOB`/`bytea` so one DDL serves SQLite,
PostgreSQL and Durable Object SQL, and the KV and journal JSON encodings stay identical. The cost
is about a third more space per sealed value.

Every backend runs a planted-plaintext test. It writes a high-entropy marker into sensitive
attributes through `ValueCodec.aesGcm`, runs the decorator corpus, then scans raw storage for the
marker in every encoding Triplex uses (UTF-8, JSON-escaped and base64url). The corpus includes
the journal, command receipts, a uniqueness violation and planning errors. Each scan includes a
positive control that finds a non-sensitive plaintext value.

- SQLite: every row of every table, plus the raw bytes of the database, WAL and shared-memory
  files after close.
- PostgreSQL: every row of every table in the database schema, plus index definitions.
- In-memory KV: every key and value.
- FoundationDB: every application key and value in an isolated native test subspace;
  this does not scan server storage files or unrelated subspaces.
- Cloudflare Durable Object SQLite: every row of every table.

## Erasure (crypto-shredding)

`Sensitive.erase` erases a subject, or one key class of it, and records that it did:

```ts
const erasePerson = (personId: string, request: { readonly id: string }) =>
  Sensitive.erase({
    subject: personId, // the entity ID, unless `subjectOf` maps values to another subject
    keyClass: "retention-1y", // optional: omit to erase every key class of the subject
    actor: "dpo@acme.example",
    commandId: request.id, // repeating it resumes an interrupted erasure
  });
// succeeds with { subject, keyClass, keyIds, scrubbed, transaction }
```

It requires `Triples`, `Sensitivity` and `KeyCustody`, and runs three steps:

1. **Destroy the keys.** `KeyCustody.destroy` destroys every data key of the scope and returns their
   key IDs. From then on, new seals for the scope fail with `key-destroyed`.
2. **Remove the blind tokens.** A blind token is keyed per database, so it survives a destroyed data
   key: anyone holding a candidate value could still confirm it. The store's `scrubBlindTokens`
   maintenance operation clears the token of every fact, current or retracted, sealed under the
   destroyed key IDs. Tokens live only on facts (`value_blind`, and the KV index entries), so this is
   the only place they need removing. The operation is unjournaled: facts keep their envelope,
   identity, valid times, recorded times and positions.
3. **Record the erasure.** One journaled transaction, with the request's actor and command ID, asserts
   `:triplex/erasure-subject`, `:triplex/erasure-key-class` (`*` for every class) and
   `:triplex/erasure-keys` (how many keys were destroyed) on a reserved `_triplex/erasure/<commandId>`
   entity. It names no attribute and no value.

The tokens are removed again after the record commits, so a write that sealed under the key just
before it was destroyed cannot keep a token. Every step is idempotent; repeating the same
`commandId` resumes an interrupted erasure and records it once.

After erasure:

- Reads return the same sealed values, and history and the journal stay complete. `Sensitive.open`
  fails with `SensitiveValueError` (`key-destroyed`); `Sensitive.open(facts, { erased: "keep-sealed" })`
  leaves erased values sealed, so a UI can render "erased" without failing the read.
- Datalog presence still matches erased facts. Equality, joins and uniqueness no longer do, so a
  unique value whose holder was erased becomes reusable.
- Other subjects, and other key classes of the same subject, are untouched.
- Derivations over erased subjects keep their committed provenance. Re-evaluation sees presence but
  no equality matches, which is the correct post-erasure answer.

Data keys belong to a **subject** and a **key class**. `ValueCodec.aesGcmWith({ subjectOf })` maps a
value to its subject, which defaults to the entity ID; a host may map related entities, such as a
person's documents, to the person. The key class comes from the attribute declaration.

Backends: in-memory KV, SQLite and PostgreSQL implement `scrubBlindTokens`. On SQL it finds the
facts by key ID with a scan of the sealed facts that still carry a token; erasure is rare, so there
is no dedicated index. Cloudflare and FoundationDB are frozen and do not implement it, so
`Sensitive.erase` fails there with `SensitiveErasureError` (`unsupported`) after nothing has changed.
With an external key service, the keys are destroyed first; if a later step fails, repeat the call.

Outside Triplex's reach: values already copied out, such as host outbox payloads, exports and
opened plaintext held by the host; and, with `SqlKeyStore`, older backups until the root key is
rotated (see [the SQL key store](#the-sql-key-store)). Live queries that compared an erased value are
not notified by the scrub; re-run them, or they update with the next change to that attribute.

## Key rotation

Three rotations, each a maintenance operation that rewrites no history: facts keep their identity,
valid times, recorded times, transaction and position, and nothing is journaled.

**Root key** (with `SqlKeyStore`). Configure the new root key as `current` and the old one in
`previous`, then run `SqlKeyStore.rewrapRoot`. It rewraps every stored data and blind key under the
current root key and rewrites no facts. It is resumable and reports how many keys are still wrapped
under an older root key; at zero, remove the old root key from `previous` and destroy it. This is
also what makes an erasure reach backups: a backup taken before the rewrap holds keys wrapped under
the old root key, which no longer exists.

```ts
const rewrapAll = Effect.gen(function* () {
  return yield* SqlKeyStore.rewrapRoot; // { dataKeys, blindKeys, remaining }
});
```

**Data keys.** `KeyCustody.rotate({ database, subject?, keyClass? })` makes a new data key version
current, so new seals use it while older values still open under the key ID they record. To move
existing values too, run `Sensitive.rewrap`. It reseals every stored value whose key is not its
scope's current key, current and retracted facts alike, and rewrites each fact's journal
`:_tx/change` copies with it. It skips erased values and values whose attribute the policy no longer
lists, and it is resumable: a value already under its current key is left alone. Its report lists
the replaced key IDs; pass them to `KeyCustody.retire(database, keyIds)` to destroy those versions.
`retire` refuses a key that is still current.

**Blind key.** `Sensitive.rotateBlindKey` stages the next blind key version
(`KeyCustody.stageBlindKey`), recomputes every stored token under it in one rewrite, activates it
(`KeyCustody.activateBlindKey`, which retires the previous version) and then recomputes any token
written under the old key meanwhile. Recomputing a token opens its value, so tokens of erased values
are removed rather than recomputed. Tokens carry their blind key ID as a prefix, so a token's version
is visible.

The design called for dual-version lookups during blind-key rotation, so it could run online. This
release ships the simpler version above instead: between the token rewrite and the activation,
equality, joins and uniqueness may miss values, so run it when writes are quiet. Dual-version
lookups are deferred until a database is too large to rotate this way.

Rotation needs the same maintenance operations as erasure (`sealedFacts`, `rewriteValues`), so it
runs on in-memory KV, SQLite and PostgreSQL and fails with `SensitiveRotationError` (`unsupported`)
on Cloudflare and FoundationDB.

## Backends

| Backend      | Storage                  | Query rules | Conformance                                                                                   |
| ------------ | ------------------------ | ----------- | --------------------------------------------------------------------------------------------- |
| In-memory KV | Yes                      | Yes         | Sealed-storage and decorator corpora, full corpus through the decorator, raw scan             |
| SQLite       | Yes (migration v3)       | Yes         | Same, plus file scan and the v1 to v3 upgrade                                                 |
| PostgreSQL   | Yes (migration v3)       | Yes         | Same in the opt-in integration suite, plus the v1 to v3 upgrade                               |
| Cloudflare   | Yes (migration v4)       | Yes         | Same in the native-SQL harness; both corpora in workerd                                       |
| FoundationDB | Yes (shared KV encoding) | Yes         | Native sealed/decorator corpora, full Triples corpus through the decorator, raw subspace scan |

The shared corpora are exported from `@triplex-build/triplex/testkit` as `sealedStorageCases`,
`sensitiveConformanceCases`, `sensitiveConformanceLayer` and `findPlaintext`.

## Host keys, not host-sealed values

Decision (2026-11-13, ask 0014): a host that needs its own key custody implements `KeyProvider` (and
`KeyCustody` for erasure and rotation) over its key service, or uses `SqlKeyStore` with its own
`RootKey`. Triplex always seals. There is one sealing path, so there is one erasure story and one
rotation story, and every surface keeps its "never plaintext by accident" guarantee.

The [host-sealed values RFC](rfcs/tx3-host-sealed-values.md) proposed a trusted-host import contract
for values sealed before they reach Triplex. It is not adopted. The gaps it listed for the
`KeyProvider` route are closed: key classes on attributes, key IDs that name their key on their own,
erasure that scrubs blind tokens, and rotation. Data a host sealed itself before adopting Triplex
moves in once: open it with the host's own code and write the plaintext through the decorator. Raw
storage still round-trips sealed envelopes; the decorator still rejects them.

## Out of scope

- Range, ordering, prefix and full-text queries over sealed values. Order-preserving or searchable
  encryption leaks far more than a keyed equality token and is not a general-purpose default.
- Field-level authorization. Whether a caller may call `Sensitive.open` is a host decision; Triplex
  provides the single choke point.
- Client-side sealing. Callers cannot submit pre-sealed values.
- Encrypting attribute names, entity IDs, valid times or transaction metadata. Only values are
  sealed, so entity IDs must not embed sensitive data.
- Length hiding. AES-GCM ciphertext length follows plaintext length; a host codec may pad.
- Opening sensitive values inside `ConfigRuntime` rule evaluation.
- Checking that a write's policy matches its pinned `configSnapshot`. Hosts derive the policy from
  the release with `Sensitive.attributesFromNodes`.

## Related work

- Shared catalogs across tenant databases: sensitivity is part of the attribute node, so a shared
  catalog carries it to every tenant. Key material stays per database (the codec's `database`), and
  blind tokens never join across databases.
- Commit validators: a validator running inside the inner store sees only sealed values. A
  validator that needs plaintext must run above the decorator or call `Sensitive.open`, and must not
  echo values into its error messages.

## Implementation status

Built: marking and key classes, the sealed value type, the identity and AES-GCM codecs, the
`KeyProvider`, `KeyCustody` and `RootKey` contracts, the test key provider, the `SqlKeyStore` reference
key store for SQLite and PostgreSQL, the `Triples` decorator for writes, reads, the journal and
Datalog planning, blind equality in the KV and SQL engines, blind tokens kept only on facts, storage
migrations for SQLite, PostgreSQL and Cloudflare, constraint and validation support, derivation and
overlay support, surface defaults, erasure (`Sensitive.erase`), rotation (`SqlKeyStore.rewrapRoot`,
`Sensitive.rewrap`, `Sensitive.rotateBlindKey`), shared conformance corpora for sealed storage, the
decorator, key stores, erasure and rotation, and raw-storage scan tests. The
[sensitive lifecycle example](https://github.com/bjacobso/triplex/tree/main/examples/sensitive-lifecycle)
runs the whole life of a value on a SQLite file.

Deliberately deferred:

- Dual-version blind lookups, so a blind-key rotation can run while writes continue. Today's rotation
  should run when writes are quiet.
- Erasure and rotation on Cloudflare and FoundationDB, which are frozen. `Sensitive.erase` and the
  rotations fail there with `unsupported`.
- Opening sealed values inside `ConfigRuntime` rule evaluation, which needs an explicit host
  decision to open (see [Out of scope](#out-of-scope)).
