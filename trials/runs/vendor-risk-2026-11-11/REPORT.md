# Vendor risk trial

Synthetic data only; illustrative, not compliance advice.

Outcome: typecheck passes; 17/17 tests pass across KV and in-memory SQLite. Triplex was not edited. Imports use Effect and public Triplex exports; no internal entrypoint is imported. This is a small host model, not a deployable procurement system.

## Outcomes by brief question

| Brief question | Outcome | Evidence / implementation |
| --- | --- | --- |
| Q1: Which vendors need review now? | Expressed and detected | `answers({validAt})` uses complete portable Datalog enumeration/provenance reads, temporal entity reads, then shared host business evaluation. At 2026-06-01 UTC: exception-expired, expired, high-missing-dpa, new, no-questionnaire, soc-expired. Non-customer-data vendor is excluded. |
| Q2: Active vendors incomplete/expired? | Detected; new activation guarded | At the chosen date: expired and high-missing-dpa. Legacy invalid activations are deliberately seeded through the raw backend. Guarded active vendor becomes queryable as invalid at its 2027-01-01 review boundary without a transaction or position change. |
| Q3: Exceptions expiring within 30 days? | Expressed and detected | exception expires 2026-06-15. Exact 30-day inclusion, 31-day exclusion, and exclusion of already expired exceptions tested. Only approvals with CISO transaction provenance, nonblank reason and bounded lifetime count. |
| Q4: Historical review, asserter, later correction? | Expressed; history retained | Original questionnaire true asserted by user:analyst; atomic `Change.correct` records false by user:reviewer for the same business interval. Exact original commit-position cut retains true/complete; latest cut returns false/incomplete. Journal identifies both actors and history retains both assertions. |
| Q5: Enforcement vs host guard vs detection? | Guarded and detected, with host boundary | Runtime-wide host-written commit validator rejects non-CISO exceptions, blank reasons, over-six-month exceptions, over-twelve-month questionnaire windows, incomplete signatures, and direct invalid activations. Rejected facts and command receipt roll back. High-risk exception still requires DPA. Raw backend bypass succeeds and audit detects it. Expiry itself is detected on dated reads. |
| Q6: KV/SQLite identical portable answers? | Demonstrated for tested portable cases | Direct equality test of Q1–Q3 result objects; all history, correction, expiry, bypass, rollback and guard cases also run against both backends with the same expectations. No SQL-specific queries. |

Every test title cites its brief requirement. Files: `src/model.ts`, `src/fixtures.ts`, `test/vendor-risk.test.ts`.

## Model choices and responsibility boundary

- Chosen business date: 2026-06-01 UTC; explicit business time, independent of machine date. "Need review" means customer-data vendor lacking any required current evidence, regardless of active status.
- A completed questionnaire has a twelve-calendar-month interval, representing the review cycle. A SOC 2 Type II fact has its own explicitly supplied current-evidence interval. A review needs both current questionnaire and SOC 2 Type II or approved exception; personal-data processing additionally requires DPA. An exception substitutes for SOC evidence only, never questionnaire or DPA.
- Calendar month addition clamps to month end, including leap/month-length differences. Validity is half-open. Exception horizon is `(chosenDate, chosenDate + 30*24 hours]`.
- Triplex provides temporal visibility, atomic commits, validator execution, provenance, exact recorded-position snapshots and guarded correction preconditions. Business rules are TypeScript host code, not inherent database schema rules or declarative authorization. No ConfigStore release or graph constraints were needed for this minimal model; policy identity is the validator name `vendor-risk.v1`, not a content-addressed policy release.
- The host must authenticate the actor and prevent users from supplying `user:ciso`; the string alone proves no real identity. The authenticated CISO principal is fixed in this synthetic model. The host must expose only the guarded service to application callers. Anyone holding the raw backend can bypass these rules, as tested.
- The guard checks affected entities at the transaction instant and changed valid-time starts, including future activation dates. It is not an exhaustive proof over every existing future interval edge. Natural expiry after activation is intentionally permitted and detected. Continuous compliant active status needs scheduled reads and host workflow actions; no scheduler or automatic deactivation is implemented.
- Requiredness/cardinality, validation of external evidence authenticity and SOC report dates, role administration, evidence storage, renewal workflows, and concurrent production request integration are outside this fixture model. Evidence booleans are trusted synthetic attestations. The model does not implement a general conflicting-fact resolver or protect an external signature system.
- Portable answers combine Datalog and host evaluation; these are not single standalone Datalog business queries. Complete reads suit this small synthetic batch, not a claim of production-scale efficiency. Historical cuts use exact recorded positions, avoiding timestamp collisions; timestamp-only correction cuts were not separately tested.

## Run timeline

| Run | Change | Typecheck | Full suite |
| --- | --- | --- | --- |
| 01 | Initial fixtures/model and 15 tests | Exit 2: value narrowing, query shape, layer typing | Exit 1: 11 passed, 4 failed; validator incorrectly accessed `.results` |
| 02 | Fixed query return shape, narrowed scalar values, simplified layer typing; added two expiry cases and positive exception+DPA signing assertions | Exit 0 | Exit 0: 17 passed |

Initial run began 13:40:58 local; final run began 13:42:08 local. Exact execution details and commands are in `RUNS.md`; failures and successes remain in separate numbered logs. No focused probes. No expectations were corrected or relaxed; initial fixture result expectations passed unchanged. No tests removed. Stopped on the first green full suite.

## Findings ranked by time cost

1. **Host policy design and temporal fixtures (largest effort):** define review age separately from SOC currentness, choose which exception requirement is waived, distinguish write rejection from time-driven detection, and preserve intentional legacy violations.
2. **Validator query API mismatch (one repair cycle):** `Triples.queryAll` returns an object containing results, but `CommitValidation.View.query` returns the array itself. Typecheck caught this; runtime confirmed it caused four failures. Public declarations resolved it.
3. **Type surface friction (same repair cycle):** sealed fact values prevent unconditional `.value` access, and generic backend layer inference rejected a KV/SQLite union. Explicit scalar narrowing and a Triples-only input surface fixed these.
4. **Historical provenance and calendar boundaries (prevented by docs):** public modeling guide explains separate-time provenance reads and half-open intervals. Used exact commit cuts and clamped calendar arithmetic from the outset.

## Silent traps

No observed run produced a plausible wrong answer that was subsequently discovered and corrected. The observed API error failed loudly. These documented hazards were avoided, not claimed as discovered bugs:

- Joining transaction actor facts at an earlier business date can silently lose the state row. Provenance reads use the same recorded cut with current valid time; journal reads resolve actors independently.
- Retracting/reasserting without preserving recorded cuts can erase what the application appears to have believed. Used `Change.correct` plus its generated preconditions.
- Default current valid time would make historical fixtures appear absent or expired; all business answers explicitly supply their date.
- Trusting caller-supplied approver fields would let forged exceptions qualify. Approval uses the transaction actor, with authentication still a host responsibility.
- Assuming an active flag stays compliant until another write would miss expiry. Position-stability tests demonstrate time-only changes in answers.

## Reading disclosure

`FILES-READ.md` records allowed reads, failed lookup paths, and automatically supplied instructions. The user's AGENTS.md block was supplied in conversation; no repository AGENTS.md was opened. Own failure logs exposed Effect source paths/function names in stack traces, which were not followed. No forbidden Triplex implementation, tests, contributor notes, RFCs or trial examples were opened.
