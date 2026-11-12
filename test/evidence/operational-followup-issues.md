# Issue-only follow-ups

These deliverables implement no new runtime modes, storage ports or query syntax.
No consumer migration or public API change is required. The existing empty RFC
Changeset covers no release; this issue-only evidence needs no publishable version.

## TX7: journal duplication

[Issue #70](https://github.com/bjacobso/triplex/issues/70) proposes an opt-in ID-only
change representation and records the actual byte experiment. Raw evidence:
[tx7-journal.json](tx7-journal.json), source `4315e57`, dirty=false, Node v24.13.0,
SQLite 3.50.4. Reproduce against public built packages:

```sh
pnpm --filter @triplex-build/triplex-sqlite exec tsx scripts/measure-journal.ts /tmp/tx7-journal.json
```

| Business string bytes | Actual history rows | Actual change JSON bytes | Proposed ID-only JSON bytes | Estimated JSON bytes saved |
| --------------------- | ------------------- | ------------------------ | --------------------------- | -------------------------- |
| 16                    | 5                   | 263                      | 55                          | 208                        |
| 1024                  | 5                   | 1273                     | 55                          | 1218                       |
| 65536                 | 5                   | 65786                    | 55                          | 65731                      |

The proposed representation is `{op,tripleId}` computed from actual change rows;
it is not a second implemented write mode. It saves **zero history rows** if one
ID-only row remains. N assertions touching E entities produce 2N+E+2 rows before
optional metadata; retraction costs differ. Index/WAL/page sizes and throughput
are not measured. SQLite is the sole byte measurement; the issue requires later
cross-adapter measurements and receipt compatibility design before implementation.

## Existing contracts and verified gaps

- [BlobStore #71](https://github.com/bjacobso/triplex/issues/71) tracks the already
  proposed browser-safe streaming content-addressed port and external adapters,
  including staged publication, reachability, retention and erasure decisions.
- [Direct reads #72](https://github.com/bjacobso/triplex/issues/72) covers unbounded
  fact/history arrays. Existing entityPage pages entities at a pinned cut but each
  body is complete; existing Datalog and feed pagination are acknowledged.
- [Datalog intervals #73](https://github.com/bjacobso/triplex/issues/73) covers
  binding validFrom/validTo. The public PatternClause schema accepts three/four
  terms; the measurement script confirms a six-term candidate is rejected.
  TemporalBasis filters cuts but does not expose each fact's interval variables.
- [Canonical JSON #74](https://github.com/bjacobso/triplex/issues/74): the missing-export premise is **refuted**. The existing public
  `@triplex-build/triplex/content` CanonicalJson namespace supplies encode and
  encodeOrThrow. The raw experiment records canonical output; the package check
  now verifies an import in a clean external consumer. Follow-up is documentation
  and adoption of that existing contract, not another encoder.

All adapter implementations are eventual design scope of the first, third and
fourth issues; no untested adapter implementation is claimed. Public canonical
encoding is browser-safe core functionality independent of adapters.

Validation: `pnpm pack:check` passes for 11 tarballs and the clean consumer including
canonical import. `pnpm check` passes, including 38 local documentation links. No
PostgreSQL runtime or schema changes are made here, and the journal experiment
uses SQLite only. Existing hosted TX6 #68 checks are all green.
