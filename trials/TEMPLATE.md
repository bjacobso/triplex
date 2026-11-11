# Cold-author trial: <brief> on Triplex

Date: <UTC date>. Revision: <hash>. Brief: <link>. Backends: <actually tested>.
Node/pnpm/TypeScript/Vitest versions: <versions>. Preparation: <commands and services>.
Session isolation and accidental contributor-context disclosure: <details>.

## Metrics

| Metric | Recorded value | Evidence / qualification |
| --- | --- | --- |
| First-run test pass rate | <passed/total; percent; skipped> | <first full-suite log> |
| Final pass rate | <passed/total; percent; skipped> | <final full-suite log; changed denominator?> |
| Number of runs to green | <count or not reached> | <ordered full-suite logs; separate probes/typechecks> |
| Files read | <count or not recorded; inventory below> | <partial reads and help listed separately> |
| Silent traps hit | <count; IDs; new traps> | <reproduced vs avoided vs not reproduced> |
| Wall-clock time | <duration or not recorded> | <handoff and first-green times; preparation excluded> |

## Brief

<Verbatim brief or immutable link. Synthetic data only.>

## Run it

<Exact commands, prerequisites, exit codes and final output. Link all retained logs.>

## Outcome

| Brief item / question | Status | How / test / limitation |
| --- | --- | --- |
| <requirement> | <implemented / partial / unsupported> | <evidence> |

## Timeline

<Reading, first typecheck, first full-suite run, each repair/run and first green result.
Record added/removed tests and expectation corrections without hiding first-run failures.>

## Findings (ranked by time cost)

<Discoverability failures, errors, workarounds and desired documentation.>

### Files read

<Every distinct path and section, purpose, declaration files, package metadata, help commands,
and any forbidden-context contamination. Do not guess missing paths or totals.>

## Silent traps

For each ID record hit / avoided / resolved / not tested / not reproduced, with evidence.
These are historical observations from 2026-11-06, not promises about current behavior.

| ID | Starting catalogue from vendor-risk | Observation / evidence |
| --- | --- | --- |
| T1 | Provenance join at past validAt silently returns empty | <status> |
| T2 | Non-literal assertion options silently drop validTo | <status> |
| T3 | Typo in attribute silently returns empty | <status> |
| T4 | Missing value differs from false; pinning alone does not enforce requiredness | <status> |
| T5 | Cardinality is only checked with enforcement | <status> |
| T6 | Time alone expires evidence without a write or error | <status> |
| T7 | Default validFrom is commit time | <status> |
| T8 | Timestamp cut may include later same-millisecond commits (baseline did not reproduce) | <status> |

<Append new IDs from T9 onward. Explain silent failures that tests initially missed.>

## Draft GETTING-STARTED / AUTHORING outline

<What public guidance would have made this trial succeed sooner.>

## Comparison with baseline

<Compare the six metrics with baseline.md after the cold phase. Explain changes in scope,
test count, backend coverage, API revision or allowed reading; do not imply identical difficulty
across different briefs. Separate actual requirement coverage from passing gap tests.>
