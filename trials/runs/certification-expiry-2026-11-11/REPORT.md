# Certification expiry trial

Completed: typecheck clean; 17/17 tests green. The same eight portable cases pass on KV and SQLite, plus one host interval test. Only public package exports and Effect are used. Triplex itself was not edited.

## Outcome by brief question

| Brief question | Outcome | Evidence and ownership |
| --- | --- | --- |
| Q1 — eligibility and boundaries | Expressed and detected on both backends | `eligibility` derives missing certifications per assignment, with explicit reasons. At 2026-11-11T00:00:00Z, exact/plant lacks electrical, missing/lab and seam/lab lack chemical; every other assignment is eligible. Tests cover ±1ms around expiry, seamless renewal, and gap renewal. Triplex applies one temporal basis and negation; host supplies merged coverage. This is a read verdict, not a write-time ban on assignments. |
| Q2 — due within 30 days and deduplication | Expressed and enforced with host guards | Due at the chosen instant: exact, gap, late, overlap, horizon, all electrical. Seam is suppressed by uninterrupted renewal; outside enters one millisecond later. Interval union prevents the older overlap endpoint from creating early work. Triplex merges evidence paths into one candidate per technician/certification. Host reconciler keeps one durable work status per candidate and uses atomic preconditions; repeating evaluation/reconciliation adds no open work. |
| Q3 — time without writes | Detected; timer delivery is host-owned | At EDGE, time-only reads find gap and late newly ineligible while seam stays eligible. A materialization at a new basis is stale without any journal change. Host calls refresh at the returned boundary. Due-window facts also encode expiry-minus-30-days, so an empty-to-nonempty change can occur at NOW+1ms. Real-gap work persists through the gap and disappears when future coverage begins. Tests drive time explicitly; no scheduler is installed in Triplex. |
| Q4 — correction freshness and explanation | Detected and refreshed | Both eligibility and renewal materializations become stale after correction; unrelated note writes leave eligibility current. Refreshed run sourcePosition equals the correction receipt position; basis retains the fixed valid instant. Candidate source triple IDs, assertion transaction IDs and positions resolve to durable evidence. Historical materialization membership remains queryable. |
| Q5 — previous belief, current belief, actors | Expressed on both backends | At 2026-11-22T00:00:00Z, the seed-position cut says late is ineligible; the latest cut says eligible after the Nov25 start is corrected to Nov21. Gap remains ineligible. Initial actor is registrar:initial; correction actor is auditor:lee. Transaction envelopes and entity timeline answer attribution without joining transaction facts at past valid time. |
| Q6 — resolve work and retain decisions | Enforced by Triplex atomic primitives plus host policy | Completing exact's renewal resolves its work and leaves open/resolved decision events and status history. Later expiry-minus-30-days reopens the same logical work with another decision; repeated reconciliation is a no-op. EntityAbsent prevents duplicate creation; TripleLive protects state transitions. Failed competing creation leaves head and facts unchanged. Lifecycle meaning, scheduling, authorization and delivery remain application responsibilities. |

## Fixed interval and workflow assumptions

- All business dates are fixed UTC millisecond instants. NOW = 2026-11-11T00:00:00Z; EDGE = Nov21; GAP_END = Nov25; FAR = 2027-03-01T00:00:00Z. Thirty days means exactly 30 × 86,400,000ms.
- Certificates cover `[effective, expiry)`. Equal endpoints are seamless. Host `episodes` computes connected unions, including chained overlapping and touching evidence, independently for each technician/certification.
- Plant requires electrical; lab requires electrical and chemical. Seam has assignments at both sites to distinguish site eligibility from certification possession.
- Renewal due begins at `max(episode.start, episode.end - 30 days)` inclusively and persists overdue until the next coverage episode begins. A future certificate separated by a gap does not clear work before its effective instant. A seamless or overlapping certificate extends the episode instead of creating a gap.
- A completely absent certificate is an eligibility failure; it has no known expiry and creates no expiry-renewal item. Collecting initial missing evidence would be a separate derivation.
- Host produces temporal coverage and renewal windows from evidence; Triplex does not compute arbitrary interval union in this model. Windows link every supporting raw certificate so renewal candidate provenance includes raw evidence and host projection facts. Candidate output contains only the pair, allowing overlapping evidence paths to merge without conflicting result values.
- Non-temporal fixture metadata and host decision/status facts use validFrom=0. Business-time eligibility uses explicit validAt; audit cuts use exact recordedPosition, so commits need no sleeps or guessed recorded timestamps.
- The initial late-next certificate is known as future-effective Nov25; a later recorded correction changes its effective start to Nov21. The original belief remains available at the seed position.
- Correction command retracts old evidence and projections and asserts the replacement set atomically. The small trial rebuilds the entire certificate projection, so all renewed positive source positions and assertion actors become the correction position/actor, even for unchanged evidence. Original assertions and their actors remain in history. This is conservative and intentionally broader than an incremental production projector.
- One stable work entity per pair holds current status. Separate append-only decision entities retain each transition and evaluation ID; open decisions also retain candidate revision. An evaluation ID must be unique for each host reconciliation cycle.

## Run timeline

| Run | Typecheck | Full suite | Repair / expectations |
| --- | --- | --- | --- |
| 01 | Exit 2: three public value-union accesses needed narrowing | Exit 0, 17/17; 2.10s reported by Vitest | Initial fixtures/model/tests. Runtime passed despite type errors. |
| 02 | Exit 0 | Exit 0, 17/17; 1.11s reported by Vitest | Narrow string status and compare typed values. No fixture or business-expectation changes. |

See RUNS.md and the four immutable numbered logs. There were exactly two test invocations, both full-suite runs, and no focused probes. No fixture expectation was corrected, no tests were removed, and no requirements were weakened to obtain green results.

## Findings ranked by time cost

1. **Most work: separating domain interval rules from derived candidate mechanics.** Public derivation provenance accepts structural patterns/predicates/negation, with a narrower contract than arbitrary Datalog. Connected interval union and the 30-day arithmetic therefore live in an explicit host projection. Temporal due-window edges let Triplex discover wakeups for this host rule. Most authoring time went into this model and its fixed expected outcomes.
2. **Next: audit/freshness and work lifecycle tests.** Distinguishing recorded cuts from business time and separating candidate disappearance from work resolution needed explicit tests. Public declarations and the derivations/Datalog guides supplied the required contracts. No implementation debugging was needed.
3. **Small repair: public value union.** The first typecheck caught unsafe scalar accesses because sealed values lack `value`. Three sites were repaired in one iteration; the business expectations stayed fixed.
4. **Minor discovery friction.** Guessed `packages/triplex` did not exist; public package metadata located `packages/core` through the local package link. One filename-listing glob also failed to exclude absolute blog/RFC paths; no contents from those directories were opened.

These are relative effort rankings, not instrumented per-phase timings. Exact suite durations are recorded above.

## Silent traps and plausible wrong-result risks

No wrong business-result expectation was discovered during execution. The first full suite passed; the only repair was type safety. The following traps were encountered as design choices and explicitly guarded in the fixtures/tests:

- **Presence is not continuous coverage.** Counting an already-recorded future certificate as current would hide the Nov21–Nov25 gap. Interval union and exact-boundary tests preserve it.
- **Checking each certificate independently duplicates or opens premature work.** Overlapping evidence ends Nov30 and Dec5; the union ends Dec5. An early evaluation asserts no overlap work, and candidate provenance must include both evidence records.
- **Expiry-only scheduling misses entry into the 30-day window.** The outside fixture enters at NOW+1ms without any write. The host encodes this additional valid-time edge; Triplex returns it as the next boundary.
- **A durable materialization is not automatically fresh.** Time changes require an explicit new basis and rematerialization. Relevant corrections also invalidate materializations; unrelated note writes do not.
- **Retraction is not erasure.** Replacing evidence must preserve the seed-position belief and original actor. Tests inspect old and new beliefs at the same valid instant and inspect both actor envelopes.
- **A candidate disappearing does not itself resolve application work.** The host must reconcile removal, preserve decision records and make retries harmless.
- **Runtime green can conceal type errors.** This happened in run 01: all assertions passed while tsc failed. Run 02 is both green and type-correct.

## Limits and unsupported claims

- Coverage is KV in-memory and SQLite in-memory through the public SQLite adapter. SQLite uses real SQL behavior, but file persistence, reopen/recovery, other adapters, process crashes, throughput and multi-process concurrency were not tested. Node emitted its experimental SQLite warning; this did not skip tests.
- The host interval projector and missing-certificate policy are application code, not Triplex-enforced domain constraints. Arbitrary raw writes can bypass them. No authorization or assignment-creation guard is installed.
- `cert-policy/v1` is an application policy identifier in definition/transaction metadata; this trial does not publish or enforce a ConfigStore release and makes no claim of cryptographically verified policy provenance.
- Evidence replacement enumerates at most 1,000 transactions for this bounded fixture database. It is not a production catch-up consumer. It guards observed retractions but does not serialize concurrent insertion of previously unseen certificates; a production host needs a version/catalog guard and paged or indexed input discovery.
- Work reconciliation is per-item atomic, not an atomic multi-item run. Retries read durable status and converge, but stale/out-of-order workers require a host freshness/generation guard. The duplicate-creation test proves an atomic guard rejects a competing claim; it is not a stress test of concurrent workers.
- No real timer, durable scheduling checkpoint, outbox or delivery adapter is implemented. Tests simulate host wakeups by evaluating at fixed later instants. Triplex supplies boundary discovery, journal/history, durable candidates, freshness and atomic guards; host must deliver wakeups and retry reconciliation.
- Because positive source assertions are rebuilt on correction, source freshness is intentionally coarse. Eligibility negation explains absence through dependencies; it does not fabricate an evidence fact proving nonexistence.

## Read audit

FILES-READ.md records documentation, declarations, local files/logs, failed paths and automatically supplied instructions. No Triplex source, tests, examples directories, trial directories, source maps, or contributor documents were read. Forbidden directory filenames were incidentally listed; full package metadata beyond exports was incidentally printed and disclosed. No CLI help commands were needed.
