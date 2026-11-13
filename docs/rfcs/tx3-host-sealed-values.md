# RFC: host-sealed values and erasure

Status: **not adopted** (decision 2026-11-13, ask 0014). Hosts supply keys through
`KeyProvider` and `KeyCustody` instead, and Triplex always seals; see
[Host keys, not host-sealed values](../sensitive-values.md#host-keys-not-host-sealed-values).
The rest of this document is kept as the record of the proposal. Its trusted-host
import contract was not built; key classes, key IDs bound into the envelope, erasure
with a blind-token scrub and rotation were built for the `KeyProvider` route.

## Consumer and existing behavior

WorldVM seals before calling Triplex, with keys scoped by vault and retention
class. That boundary is a consumer decision supplied with this request; no WorldVM
checkout or modification is needed for this RFC. It wants Triplex's indexed sealed
equality and joins without exposing plaintext to Triplex's sealing service.

The motivating claim needs qualification. Raw `Triples` already accepts
`SealedValue` (declared scalar type, key ID, ciphertext and optional blind token).
The shared `sealedStorageCases` explicitly exercise raw imports, blind equality
and joins. Conversely, `Sensitive.prepareAssert` rejects sealed input with
`SensitiveValueError` reason `sealed-input`; the decorator corpus pins this
behavior. The documented non-goal concerns a supported client-sealing policy
boundary, not an absent physical ciphertext representation.

Current source contracts:

- `ValueCodec.SensitiveContext`: database, entity ID, attribute and declared type.
- `ValueCodec.aesGcmWith`: synchronous `subjectOf(context)` plus database/attribute
  blind scope. Authenticated data binds database, entity, attribute and type.
- `KeyProvider.KeyContext`: database and opaque subject. Data keys are selected by
  that pair; opening also receives the stored key ID.
- `KeyProvider.blindKey(database)`: one database-wide HMAC key, without subject,
  vault, retention class or historical version lookup.
- The reference codec computes blind tokens itself. Its joins compare token
  identity, not cryptographically verified plaintext equality at query time.

See [sensitive values](../sensitive-values.md) and the
[operational-primitives roadmap](../operational-primitives.md). The relevant
sources and shared tests are in `packages/core/src/sensitive`,
`packages/core/src/Value.ts` and `packages/testkit/src/sensitive.ts`.

## Options

| Option                                        | Meets existing WorldVM plaintext boundary       | Main consequence                                                                                                      |
| --------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Continue raw sealed writes                    | Yes                                             | Already possible, but bypasses decorator policy and supplies no trusted-import/erasure integration contract           |
| Explicit trusted-host envelope import         | Yes                                             | New opt-in authority, token-domain and maintenance contracts; reverses the stated non-goal narrowly                   |
| Adopt reference codec with custom KeyProvider | No, unless WorldVM changes its decision         | Reuses sealing/authentication, but Triplex codec receives plaintext and blind scoping needs extension                 |
| Custom ValueCodec                             | Plaintext seal method still receives PlainValue | Can replace crypto, but is not itself an envelope-import API; disguising envelopes as plaintext abuses logical typing |

Recommend **explicit trusted-host envelope import**, gated on owner approval of
the trust model and erasure design below. Keep ordinary `Sensitive` writes
plaintext-only. Do not expose import automatically through HTTP, CLI or ordinary
tenant write permissions. Do not advise raw adapter access as the integration API.

## Proposed trusted-host contract

A host composes a separate import capability into its runtime. Proposed names and
shape are illustrative, not exported API. An import supplies the existing sealed
envelope plus a registered opaque encryption/erasure domain and blind-token
namespace/version. The host determines domain membership from authenticated
application policy; an untrusted caller cannot choose a weaker scope or mark
someone else's value erased. Domain identifiers and key IDs contain no sensitive
values. Authorization is host-owned; Triplex enforces the configured import policy
before the same atomic transaction as its facts, journal and outgoing entries.

Validate envelope shape, allowed logical type, size limits, registered formats,
key/domain association and token namespace/version. A registered host verifier
may verify a signature/MAC binding the envelope, blind token, domain, database,
entity, attribute and declared type. It must not require Triplex to hold data keys.
Merely checking base64url or accepting a token string is not authentication.
Verification and domain mapping must be deterministic for retries; failures are
redacted typed errors. Keep key material and plaintext out of errors/telemetry.

Triplex would guarantee atomic persistence, historical cuts, opaque round-trip,
indexed token equality, full journal retention and the declared redaction/query
rules. It would **not** guarantee that ciphertext decrypts, that the declared type
matches decrypted plaintext, nonce safety, key destruction, canonical plaintext,
or that equal tokens imply equal plaintext. Those depend on the host's crypto and
canonicalization. Even a signature authenticates the submitting authority, not
plaintext equality. A dishonest or buggy importer can create false joins and
uniqueness violations or evade uniqueness with different tokens. Hosts accepting
multiple importers must share a trusted canonicalization/token authority.

Blind equality is permitted only within an explicitly registered comparable domain
and compatible scalar family. Tokens must encode a collision-resistant namespace
and version, and domain separation must participate in actual engine identity;
metadata-only labels would not prevent cross-domain joins. Database-wide joins
across vaults are an explicit leakage decision. Per-vault/retention tokens prevent
those joins by design. Missing tokens preserve presence reads but support no blind
equality/uniqueness. Constants need a host token service or authorized typed token
query API; existing plaintext constant rewriting cannot invent foreign tokens.
Do not allow an untrusted caller to supply arbitrary token lookup requests.

Retries preserve the exact imported envelope where command idempotency compares
payloads. Randomly resealing the same plaintext is not byte-identical. Key or
blind-version rotation requires an explicit transition protocol: dual-version
lookups and uniqueness checks, reindexing, and eventual retirement. None exists
merely because envelopes contain key IDs. Old ciphertext formats need a registered
opener or remain opaque; the reference AES-GCM opener cannot decode arbitrary
host envelopes.

## Alternative: custom KeyProvider

Data-key vault/retention scoping often needs **no KeyProvider signature change**:
`subjectOf` can return a stable opaque encoding of vault plus retention class,
and a provider resolves that subject's current key and historical key IDs.
This works when that mapping is derivable synchronously from context and remains
valid for old facts. It is insufficient when class membership depends on the
plaintext, asynchronous policy lookup or changes over time without a stored
historical mapping. The current envelope has no explicit subject field and
`openingKey` receives the subject recomputed from today's context. A provider
must not silently open under a newly assigned retention domain.

A first-class version of this alternative would need an immutable authenticated
key-domain reference recorded with the envelope, an asynchronous policy resolver
where required, historical-domain opening and a defined erasure domain enumerator.
Those concern codec/context/envelope policy as well as KeyProvider; adding a
`retentionClass` argument alone does not solve historical resolution.

The larger gap is blind keys. `blindKey(database)` cannot select vault/retention
keys. Extend it with a registered equality-domain context and versioned historical
resolution, update `blindScope`/query planning to describe domain comparability,
and implement rotation/dual-version uniqueness. Database-wide blind tokens remain
linkable after a vault data key is destroyed, so data-key scoping alone is not
erasure. Keeping the existing signature is viable only if WorldVM deliberately
accepts database-wide equality leakage and separate scrubbing.

This alternative also requires WorldVM to let Triplex's codec see plaintext and
adopt its canonicalization, envelope/AAD and opening boundary, or supply a custom
codec with equivalent guarantees. It cannot be presented as respecting the
existing pre-Triplex sealing decision automatically. Choose it if the owner and
consumer explicitly prefer that boundary change over trusted import.

## Erasure and blind-token scrub

The existing design calls for an unjournaled, resumable blind scrub plus one
journaled erasure fact with no attribute/value, retaining presence and audit
positions while removing equality. That maintenance API is not built. Imported
values must join the same protocol; a separate host SQL blind table does not
make Triplex's retained copies disappear.

Required design before implementation:

1. Persist authenticated domain-to-fact membership independently of current key
   availability and mutable application facts. Include retracted historical facts,
   journal `:_tx/change` copies and any canonical token-bearing projections.
2. Durably fence a domain against new assertions/imports and in-flight writers;
   otherwise a scan can finish while a concurrent write restores a token. Define
   crash-safe ordering with external KMS destruction, retries and a persisted
   erasure job. External key destruction and database mutation are not one atomic
   transaction. Do not claim completion until the required participants confirm.
3. Remove blind tokens from SQL value_blind, KV META and token-bearing EAVT/AEVT/
   AVET keys, historical journal JSON copies and relevant derived/configuration
   copies. Update caches and indexes together; TX5's live index stores IDs only.
   Keep ciphertext/fact identity/times/positions when permitted. No ordinary
   retraction suffices: recorded-position replay must not resurrect scrubbed tokens.
4. Handle snapshots/checkpoints, exports, replicas and backups explicitly. Immutable
   content-addressed objects cannot be rewritten under their old content IDs;
   retire/delete or replace manifests with an erasure-aware read barrier. Offline
   copies require their own retention/deletion policy. Triplex cannot revoke a
   token or ciphertext already copied by a consumer.
5. Define completion and reader behavior during incremental scrub. Prefer a durable
   domain read barrier suppressing equality immediately, followed by resumable
   physical cleanup. Uniqueness reuse, concurrent inserts and historical reads
   must observe the same barrier. Presence and opaque erased-value reads survive;
   equality/joins do not. A final erasure fact records an opaque domain/job ID,
   completion time and policy version, with no token/key material or values.
6. Outbox/inbox payloads are host-owned canonical payloads, outside automatic
   Sensitive sealing. They can carry ciphertext or tokens and need an explicit
   participant/retention policy. Audit these and external blobs rather than
   claiming attribute erasure also erases operational payload history.

Scope should support one vault/retention domain rather than assuming one entity
or subject. The host destroys the corresponding data keys. Blind-token deletion
is still necessary even if blind keys are also destroyed: a previously retained
token remains a correlation identifier. An erasure job must not depend on opening
ciphertext with a destroyed key to discover its scope.

## Acceptance and owner decisions

Owner approval is required for reversing the client-sealing non-goal and for the
chosen equality-domain/leakage boundary. Open questions: host verification trust,
immutable domain representation, token query authority, domain fencing/read-barrier
protocol, erasure fact semantics and backup responsibility. Recommend first
approving the trusted-host direction, then a separate detailed API/maintenance
RFC before code. Existing raw sealed writes remain available with their current
limited guarantees; this proposal adds no default acceptance or weaker policy.

Any later implementation must cover KV/FoundationDB and SQL/SQLite/Postgres/
Cloudflare, including sensitive decorator composition, journal receipts and
cheap preconditions. Required failing tests: forged/moved envelopes rejected;
domain-isolated joins; opaque round-trip/replay; token-version uniqueness;
erasure concurrent with writes and reader snapshots; interruption/restart at
every maintenance phase; raw-storage scans finding no scrubbed token in retained
copies. Native FoundationDB infrastructure must be arranged for its maintenance
proof. No runtime tests are added for this documentation-only RFC.

Adoption today: none. No migration, public API change or release version change.
After approval, a future migration may add domain membership, erasure barriers and
maintenance indexes on all adapters; existing envelopes need an explicit backfill
policy. Legacy data with unknown domains must not be declared erased by inference.
