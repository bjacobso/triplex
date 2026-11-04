# Sensitive values (RFC)

Status: **implemented, pre-1.0, opt-in.** This page is the design record for sensitive attribute
values: what they are, which guarantees Triplex gives, and what remains host work. The
[implementation status](#implementation-status) section at the end tracks what is built.

## Problem

Triplex stores every value in typed plaintext columns or KV records, and Datalog, indexes,
uniqueness checks and graph constraints compare those values directly. Nothing marks an attribute
as sensitive, so a database that holds national identifiers, birth dates or document numbers keeps
them readable in every table, journal payload, snapshot and backup. The configuration layer's
observation digests (`config/World.ts`) avoid copying values into decision records, but they are
not encryption and do not protect the facts themselves.

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

## Model

### Marking an attribute

```ts
import { Attribute, EntityType } from "@triplex-build/triplex/config";

const ssn = Attribute.sensitive(Attribute.text(":person/ssn"));
const birthDate = Attribute.sensitive(Attribute.date(":person/birth-date"));

const Person = EntityType.make("Person", {
  attributes: {
    ssn: Attribute.use(ssn, { unique: true }),
    birthDate: Attribute.use(birthDate),
  },
});
```

`Attribute.sensitive(definition)` returns a definition with `sensitive: true`. Its config node
records `sensitive: true` in its attributes, so the node's content ID changes and every release
that adopts it shows a changed attribute node. Non-sensitive attributes keep their existing content
IDs because the field is omitted when false. Reference attributes cannot be sensitive. A ref is
graph identity, and sealing it would break traversal, reference-target constraints and entity
expansion. Blob attributes already store a content hash rather than the content, so they are
rejected too.

### The sealed value

Storage is self-describing. A sealed fact carries the sealed variant of `TripleValue`:

```ts
interface SealedValue {
  readonly type: "sealed";
  /** The declared plaintext type: string, number, boolean, datetime or json. */
  readonly valueType: SealableValueType;
  /** Codec-owned identity of the key that sealed the value (used by rotation). */
  readonly keyId: string;
  /** Codec-owned envelope, base64url. Opaque to Triplex. */
  readonly ciphertext: string;
  /** Keyed equality token, base64url, or absent when the codec has no blind index. */
  readonly blind?: string;
}
```

Because storage records whether a value is sealed, a reader never has to guess. A policy that no
longer lists an attribute still sees older sealed facts as sealed. A sealed fact never becomes
plaintext through a configuration change; only an explicit open can produce plaintext.

Adding the variant widens `TripleValue` and `Triple["value"]`. That is an additive data change:
databases without sensitive attributes never produce it, and existing rows decode exactly as
before. It is still a source-level change for TypeScript code that switches exhaustively over
`value.type`, so the Changeset marks the core package minor (a 0.x breaking slot), and the
in-repository consumers (dashboard, HTTP, CLI, snapshots and constraints) handle it explicitly.

### Services

| Service              | Role                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `SensitiveAttributes` | The policy: which attribute keywords are sensitive and their declared plaintext type.                      |
| `ValueCodec`          | Seals, opens and blinds one value with a `SensitiveContext` (database, entity, attribute and value type).   |
| `KeyProvider`         | Supplies per-subject data keys and the per-database blind key to the reference AES-GCM codec.              |
| `Sensitivity`         | The composed runtime capability: policy, codec and database identity, used by `open` and by overlays.     |

```ts
interface SensitiveContext {
  readonly database: string;
  readonly entityId: string;
  readonly attribute: string;
  readonly valueType: SealableValueType;
}

interface ValueCodecService {
  /** Codec name recorded in errors and diagnostics, never in data. */
  readonly name: string;
  /** Whether equal plaintexts in different attributes share a blind token. */
  readonly blindScope: "database" | "attribute" | "none";
  readonly seal: (ctx: SensitiveContext, value: TripleValue) => Effect<Sealed, SensitiveValueError>;
  readonly open: (ctx: SensitiveContext, sealed: SealedValue) => Effect<TripleValue, SensitiveValueError>;
  readonly blind: (ctx: SensitiveContext, value: TripleValue) => Effect<string | undefined, SensitiveValueError>;
}
```

Codecs shipped in core:

- `ValueCodec.identity`: reversible base64url of the canonical plaintext, with an unkeyed SHA-256
  blind token. It exists so that development databases have the same storage shape and the same
  query semantics as production, and turning encryption on swaps the codec instead of the schema.
  It is **not** confidential. It must be chosen explicitly; there is no implicit default codec.
  Declaring a sensitive attribute without providing a codec fails at layer construction.
- `ValueCodec.aesGcm`: the reference implementation over WebCrypto (`crypto.subtle`, available in
  browsers, Node.js 22 and workerd; core still imports no Node API). It uses AES-256-GCM with a
  random 96-bit nonce per value. The additional authenticated data binds the database, entity,
  attribute and declared type, so a ciphertext cannot be moved to another fact. The blind token
  is HMAC-SHA-256 under the database blind key over a domain tag, the scalar family and the
  canonical plaintext. Its `blindScope` is `database`, so equal values in two sensitive attributes
  of one database join.
- `KeyProvider.test(...)`: deterministic **test keys only**, derived from a seed. It supports
  per-subject keys, rotation of the current key ID and key destruction for erasure tests. Production
  hosts implement `KeyProvider` over their KMS. Triplex never persists key material.

### Composition

`Sensitive.layer(options)` decorates any `Triples`. It works the same way over every backend,
including Cloudflare and FoundationDB, because it sits above the storage adapter:

```ts
const layer = Sensitive.layer({ database: "acme/main", attributes: [ssn, birthDate] }).pipe(
  Layer.provide(ValueCodec.aesGcm),
  Layer.provide(KeyProvider.test({ seed: "test-only" })),
  Layer.provideMerge(SqliteTriples.layer({ filename: "app.db", scope })),
);
```

The output is `Triples | Sensitivity`. Every core service that already reads `Triples` from
context, including `ConfigStore`, `EntityValidation`, derivations and the HTTP handlers, gets the
sealed behavior without new parameters. A process that opens the raw backend layer without the
decorator still cannot read plaintext. It sees sealed values and has no keys.

## Semantics

### Writes

`transact` (and `assert`, `assertBatch`, which delegate to it):

- seals every `assert` whose attribute is sensitive, after checking the value against the declared
  type, and passes only the sealed value to the inner store;
- rejects a caller-supplied `sealed` value for any attribute. Sealing is a store capability, not
  an input format, and accepting foreign ciphertext would let a caller forge blind tokens;
- rewrites `retract-pattern` value constants on sensitive attributes to blind matches;
- checks `meta.enforce` rules before the write (see [constraints](#constraints)).

Plaintext exists only in the caller's request and in the codec call. The commit's
`TransactionResult.triples` already carry the sealed values.

### Reads

`get`, `entity`, `entities`, `entityPage`, `match`, `history`, `transaction`, `transactions`,
`transactionByCommand` and `transactionsForEntity` return the stored sealed values unchanged. The
journal's `:_tx/change` payload embeds the same sealed value, so history and "what changed" reads
show that a sensitive fact changed, by whom and when, without its plaintext.

`match` with a value constant on a sensitive attribute is rewritten to the blind token, so lookups
such as "which person has this SSN?" are indexed equality reads.

Opening is explicit:

```ts
const facts = yield* triples.entity(personId);
const opened = yield* Sensitive.open(facts); // Effect<readonly Triple[], SensitiveValueError, Sensitivity>
```

`Sensitive.open` accepts a triple, an array of triples, or a `TransactionRecord`. It leaves
non-sealed values untouched. Hosts log or authorize this call; it is the single place where
plaintext is produced.

### Datalog

The decorator analyses every `query`, `queryAll`, `queryPage`, `explain` and `explainPage` call
against the policy before the inner engine runs. A variable is *sensitive* when it occurs in the
value position of a pattern on a sensitive attribute.

| Use                                                           | Result                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Presence (`[?e ":person/ssn" _]` or an unused value variable) | Allowed.                                                                                       |
| Constant in the value position                                | Allowed; rewritten to the blind token (`{ type: "blind", value }`). Uses the blind index.      |
| Join between two sensitive value positions                    | Allowed when both have blind tokens and the codec's `blindScope` permits it (same attribute, or `database` scope). |
| Join with a plaintext position or an identity position        | `SensitiveQueryError` (`join`).                                                                |
| Projection in `find`, `orderBy`, wrapper filters, `having`    | `SensitiveQueryError` (`projection`, `order`, `filter`).                                      |
| Comparison or equality predicate                              | `SensitiveQueryError` (`predicate`). Use a pattern constant for equality.                      |
| Aggregate over the value                                      | `SensitiveQueryError` (`aggregate`).                                                          |
| Rule bodies and rule applications                             | `SensitiveQueryError` (`rule`) when a rule touches a sensitive attribute.                      |
| Pattern with a variable attribute                             | `SensitiveQueryError` (`dynamic-attribute`) when a policy exists, because the analysis cannot prove the attribute is not sensitive. |
| Blind-dependent use with a codec whose `blindScope` is `none` | `SensitiveQueryError` (`blind-index-unavailable`).                                             |

`SensitiveQueryError` is a member of `DatalogQueryError` and carries `attribute`, `operation` and
a message that names the attribute and never the value. Full-text search is not part of Triplex
Datalog today. When the roadmap's `fts` predicate lands, it must reject sensitive variables through
the same check.

As defense in depth, the engines themselves never project a sealed value. Without the decorator,
a raw Datalog read that binds a sealed value projects `null`, orders it with other non-scalar
values, and joins it only with another sealed value carrying the same blind token. KV, SQLite and
PostgreSQL agree on this in the shared corpus.

### Constraints

- **Required** and **cardinality** count facts and work unchanged.
- **Unique** compares the blind token (`sealed:<blind>`) instead of the canonical value. If the
  codec has no blind index, a transaction that enforces a unique rule on a sensitive attribute fails
  before mutation with `SensitiveValueError` (`blind-index-unavailable`). It does not skip the rule.
  Uniqueness across a blind-key rotation is covered by the rotation design below.
- **Reference-target** cannot apply because ref attributes cannot be sensitive.
- Violation messages already omit values. `valueIdentity` for a sealed value is the blind token,
  never plaintext.

### Derivations and overlays

Derivations run their queries through `Triples`, so the planning rules above apply unchanged. A
derivation that projects, orders or compares a sensitive value fails with `SensitiveQueryError` when
it is evaluated. Derivations may still use sensitive attributes for presence and blind equality,
for example "people without an SSN on file". Candidate provenance records triple IDs and sealed
values, never plaintext.

`Derivation.evaluateOverlay` builds an ephemeral in-memory store. When `Sensitivity` is in context,
it seals hypothetical assertions on sensitive attributes before seeding and applies the same query
analysis and blind rewriting. Hypothetical sensitive values therefore compare exactly like
committed ones and never reach the in-memory indexes in plaintext.

`ConfigRuntime` evaluation reads scalar facts into a `World`. Sealed facts are not scalar, so an
evaluation that reads a sensitive attribute fails with a typed error. A rule such as "older than
18" from a sealed birth date needs an explicit host decision to open the value. That opt-in is
future work.

### Surfaces

| Surface   | Default                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP      | Entity reads return sensitive fields as `{ "$sealed": { "valueType": ..., "keyId": ... } }`, without ciphertext or blind. Writes accept plaintext and seal through the decorated `Triples`. There is no plaintext read route; hosts that need one call `Sensitive.open` in their own handler after authorization. |
| CLI       | `entity`, `history`, `journal` and `query` print sealed values as `{ "type": "sealed", "valueType", "keyId" }`. The CLI has no key access and no open command. |
| Dashboard | Sealed values render as a locked `sealed · <valueType>` badge. It has no open action.                                                                       |

"Never plaintext by accident" holds structurally. Each surface sees only what `Triples` returns,
and `Triples` returns sealed values.

## Storage

All backends store the same logical sealed value. The ciphertext and blind token are kept in
dedicated places, and the plaintext value columns stay empty.

| Backend                   | Ciphertext                      | Blind token                    | Index                                                                                         |
| ------------------------- | ------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| SQLite, PostgreSQL        | `value_sealed TEXT` (JSON envelope: type, key ID, ciphertext) | `value_blind TEXT` | `idx_attr_blind ON triples(attribute, value_blind) WHERE value_type = 'sealed'` (migration v3) |
| Cloudflare Durable Object | Same columns                    | Same columns                   | Same index (Cloudflare migration v4)                                                          |
| In-memory KV, FoundationDB | `META` record value tag `sealed` (type, key ID, ciphertext, blind) | Tuple tag `0x08` over the blind token in EAVT, AEVT and AVET | AVET on `(attribute, sealed blind)`                                                            |

Migration v3 widens the `value_type` check to admit `sealed` and adds the two columns and the
index. PostgreSQL replaces the check constraint in place. SQLite cannot alter a check constraint,
so it rebuilds the `triples` table inside the migration transaction and recreates every index;
that cost is proportional to the table size and is the documented SQLite procedure. Existing rows
are untouched.

The columns are `TEXT` (base64url) rather than `BLOB`/`bytea` so one DDL serves SQLite,
PostgreSQL and Durable Object SQL, and the KV and journal JSON encodings stay byte-identical. The
cost is roughly a third more space per sealed value.

A sealed fact without a blind token is still indexed in KV, under its triple ID. That keeps its
key unique and makes clear it never matches an equality lookup.

The planted-plaintext test writes a high-entropy marker into a sensitive attribute with
`ValueCodec.aesGcm`, then scans raw storage for the marker in any encoding Triplex uses (UTF-8,
JSON-escaped and base64url):

- every table and column in SQLite (`sqlite_master`, then every row);
- every table in the PostgreSQL schema;
- every key and value in the KV backend.

The test also commits a constraint-enforced transaction and triggers a planning error, so it covers
the journal, command receipts and error messages.

## Erasure (crypto-shredding)

Design, partially built:

- `KeyProvider` is keyed by **subject**, which defaults to the entity ID. A host may map several
  entities to one subject, for example a person's documents to the person.
- Erasing a subject destroys its data key in the key provider. Facts, positions, journal entries
  and sealed envelopes remain, so history stays complete and every audit query keeps working. The
  ciphertext can no longer be opened.
- Reads after erasure return the same sealed values. `Sensitive.open` fails with
  `SensitiveValueError` (`key-destroyed`); `Sensitive.open(..., { erased: "keep-sealed" })` leaves
  such values sealed instead, so a UI can render "erased" without failing the whole entity.
- **Blind tokens must be scrubbed too.** A blind token keyed per database survives a destroyed data
  key, so someone holding a candidate value could still confirm it. Erasure therefore also clears
  `value_blind` (and the KV blind index entries) for the subject's facts through an unjournaled
  maintenance operation, like checkpoint maintenance, and records one journaled erasure fact
  naming the subject and the time. It names no attributes or values. After scrubbing, Datalog
  presence still matches erased facts, while equality, joins and uniqueness no longer do. A unique
  value whose holder was erased becomes reusable.
- Derivations over erased subjects keep their committed provenance. Re-evaluation sees presence but
  no equality matches, which is the correct post-erasure answer.

Built today: per-subject keys, key destruction in the test provider, and typed `key-destroyed`
opening with the `keep-sealed` mode. Not built: the storage-level blind scrub and the erasure
fact. They need a new optional `StorageAdapter` maintenance method on every backend.

## Key rotation

Design:

- **Data keys.** Each envelope records its key ID. `KeyProvider.dataKey` returns the current key
  for new seals, and `KeyProvider.openingKey(keyId)` resolves historical keys, so rotation needs no
  data change. Re-encryption under a new key (*rewrap*) rewrites `value_sealed` for an existing
  fact ID in place. The fact's meaning, valid time, transaction and position do not change, so
  transaction history is untouched. Rewrap is an unjournaled maintenance operation with a durable
  checkpoint, so it resumes after interruption. Journal `:_tx/change` payloads hold their own
  copies of the sealed value. Rewrap either rewrites them too, or keeps the old key IDs available
  for opening. The reference provider does the latter.
- **Blind key.** Rotating the blind key changes every token. Tokens carry a key-version prefix.
  During rotation the decorator expands each equality constant to both versions and compares joins
  on the token payload within one version. A background rewrap recomputes tokens, which requires
  opening every value. Uniqueness enforcement compares both versions until the rewrap completes.
- Not built: the rewrap maintenance operation (same adapter extension as the blind scrub) and
  dual-version blind lookups.

## Backends

| Backend      | Storage | Query rules | Conformance                                              |
| ------------ | ------- | ----------- | -------------------------------------------------------- |
| In-memory KV | Yes     | Yes         | Shared `sensitiveConformance` corpus                     |
| SQLite       | Yes     | Yes         | Shared corpus, raw-storage scan, migration from v2       |
| PostgreSQL   | Yes     | Yes         | Shared corpus and raw-storage scan in the opt-in integration suite |
| Cloudflare   | Yes (migration v4) | Yes | Covered by its SQL harness through the shared corpus |
| FoundationDB | Yes (shared KV encoding) | Yes | Opt-in native suite; not run by default            |

## Out of scope

- Range, ordering, prefix and full-text queries over sealed values. Order-preserving or searchable
  encryption leaks far more than a keyed equality token and is not a general-purpose default.
- Field-level authorization. Whether a caller may call `Sensitive.open` is a host decision; Triplex
  provides the single choke point.
- Client-side sealing. Callers cannot submit pre-sealed values.
- Encrypting attribute names, entity IDs, valid times or transaction metadata. Only values are
  sealed. Entity IDs must not embed sensitive data.
- Length hiding. AES-GCM ciphertext length follows plaintext length; codecs may pad.
- Opening sensitive values inside `ConfigRuntime` rule evaluation.

## Related work

- Shared catalogs across tenant databases: sensitivity is part of the attribute node, so a shared
  catalog carries it to every tenant. Key material stays per database, and blind tokens never join
  across databases.
- Commit validators: a validator that inspects values sees the sealed form when it runs below the
  decorator. A validator that needs plaintext must run above it, or call `Sensitive.open`, and must
  not echo values into its error messages.

## Implementation status

See the summary in [Current state](/current-state). Delivered: marking, the sealed value type, the
identity and AES-GCM codecs, the test key provider, the `Triples` decorator for writes, reads,
journal and Datalog planning, blind equality in the KV and SQL engines, storage migrations for
SQLite, PostgreSQL and Cloudflare, constraint support, overlay sealing, surface defaults, and the
raw-storage scan tests. Design only: blind scrubbing on erasure, rewrap and blind-key rotation.
