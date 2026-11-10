# FoundationDB native operational conformance follow-up

This package closes a validation gap in TX2/TX4/TX5/TX6 and fixes a FoundationDB
cursor-scope defect exposed by that validation. Based on scope investigation #77;
allocator implementation remains gated on the pending owner contract decision.
Implementation revision and PR link follow after final checks.

## Reproduced failures and changes

The earlier reports correctly recorded native tests as unavailable at the time.
A continuation provisioned the missing client without a system-wide install and
ran them. The first run failed before all ten cases: the fixture called removed
Effect.timeoutFail and imported the KvBackend service from its old entry point.
The corrected fixture uses Effect 4 timeoutOrElse, the public core/internal port,
and live test services. TypeScript now checks both native files and their fixture,
including branded IDs and the actual Testcontainers cleanup signature.

A portable corpus uses real elapsed time; the initial virtual-clock run suspended
Effect.sleep and was explicitly interrupted. No timeout budget was increased to
mask it. Both raw and sensitive-decorated shared Triples corpora then passed on
native FoundationDB with the existing 16-KiB fixture bulk-write budget unchanged.
The sealed-storage corpus is included as well.

The old subscription negative test declared both attribute and type dependencies,
so an email change correctly invalidated its employee-type watch. The corrected
cases distinguish attribute-only absence of invalidation from conservative type
invalidation on a different attribute. Removed timeoutFail calls were also fixed.
No watch implementation semantics changed.

## Cursor bug and adoption

Previously all FdbTriples.layer configurations used runtime scope "default".
A native regression creates two fresh, isolated subspace runtimes, verifies the
second is empty, and submits the first's outbox cursor there. It was accepted
and returned an empty page instead of PaginationCursorError. The failing test
was run before the production fix; fresh Layer scopes ensure this tests actual
separate backends rather than a test harness memoized service.

Now the runtime identity is SHA-256 of the configured cluster-file path and exact
subspace bytes, using a framed JSON encoding. A foreign subspace cursor is rejected.
Public call shape is unchanged:

```ts
const layer = FdbTriples.layer({ clusterFile, subspace: Buffer.from("world/home/") });
```

Keep that configuration stable for cursor continuation; aliases to one cluster
file can intentionally have distinct identities. This is configured keyspace
identity, not a proof about reassignment of cluster files or subspaces to another
database generation. Existing opaque cursors must restart because their default
identity changed. Facts and journal data require **no migration**. FoundationDB
is private and remains experimental; the empty Changeset excludes private-package
release frontmatter while recording adoption and compatibility impact.

## Native setup and exact commands

Local platform: macOS arm64, Node v24.13.0, pnpm 10.11.0, OrbStack Docker,
foundationdb npm binding 2.0.1, API version 720, server/client 7.3.75. The existing
fixture starts disposable native arm64 containers with unique subspaces. No
WorldVM files or existing database containers are changed.

Downloaded official release assets into /tmp/triplex-fdb-client.KZy39z:

```sh
gh release download 7.3.75 --repo apple/foundationdb --pattern 'FoundationDB-7.3.75_arm64.pkg*' --dir /tmp/triplex-fdb-client.KZy39z
cd /tmp/triplex-fdb-client.KZy39z
shasum -a 256 -c FoundationDB-7.3.75_arm64.pkg.sha256
pkgutil --expand-full FoundationDB-7.3.75_arm64.pkg expanded
```

Verified package SHA-256:
`6b162b0bebefd49873ce2e7d7db7bb001515c80ce3a90545585859c26362488f`.
No installer or server launch agent runs. From packages/foundationdb, direct Node
preserves the macOS loader variable through Vitest workers:

```sh
DYLD_LIBRARY_PATH=/tmp/triplex-fdb-client.KZy39z/expanded/FoundationDB-clients.pkg/Payload/usr/local/lib /Users/benjacobson/Library/pnpm/node node_modules/vitest/vitest.mjs run test/fdb-triples.test.ts test/FdbSubscriptions.test.ts
```

Focused red/green cursor and migration command appends:
`-t 'foreign subspace|legacy live-index'`. The legacy fixture removes live-index
keys and the hex 0x26/0x01 readiness key, advances bounded migration batches across
upgraded writes/retraction, then checks the exact current attribute precondition.
It initially deleted the wrong decimal marker byte; that test fixture was corrected
before asserting native backfill success.

CI uses Ubuntu/Node 24, pinned 7.3.75 x86_64 client/server, verifies the official
shared-library checksum, sets LD_LIBRARY_PATH without installation, requires the
native module explicitly so missing bindings cannot silently skip, and runs
pnpm test:foundationdb:integration. Local integration remains opt-in; default unit
checks exclude both native suites. Native TypeScript checks run in the default gate.

## Verification and scope

The full native run passes **19 tests** across two files, including both shared
Triples corpus runs, sealed/decorator conformance, raw-storage scan, cross-subspace
cursor rejection, legacy backfill and four watch cases. It takes 91.97 seconds
on the local arm64 environment. The native TypeScript gate and frozen lockfile
install pass. `pnpm check` passes, `pnpm pack:check` verifies 11 tarballs and a clean consumer,
and `pnpm test:postgres:integration` passes 45 tests. Final docs build also passes
40 local links. Hosted native Linux CI is pending PR creation.
The raw sensitive test scans every application key/value in its isolated subspace,
including META/history, journal copies and indexes, with a planted-plaintext detector
and a positive non-sensitive Grace control. It does not claim to scan the server's
internal storage files, unrelated subspaces, backups or external copied data.

No throughput benchmark is claimed. Native tests validate real adapter semantics;
the earlier 10/10000 I/O/index experiments retain their original measured adapters.
The new native CI job's hosted result must be inspected before claiming it passes.
