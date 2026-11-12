# Execution timeline

Business expectations come from BRIEF.md Q1–Q6 and remain fixed. Every numbered run is a whole-suite run. No focused test invocations.

## 01 — initial implementation

Added schema-bound home model, synthetic fixtures, explicit host authorization and key-domain mapping; KV/SQLite tests for all six questions, 16-way duplicate submissions, synchronized conflicting updates, exact-position replay and SQLite reopen. PostgreSQL skipped after no configured connection and default local service reported no response. No fixture expectations corrected before execution.

Commands: `tsc -p . > typecheck-01.log 2>&1` followed by the exit status appended; then `vitest run --reporter=verbose > run-01.log 2>&1` with exit status appended. Results recorded after completion.

01 result: typecheck exit 2; test exit 1, suite failed during module loading, zero tests collected. `.required()` returns a use whose `unique` is a boolean, so chaining `.unique()` is invalid.

## 02 — repair schema declaration

Code only: pass `{ unique: true }` to `.required()`, following the published declaration. No test or business expectation changed. Whole-suite run; typecheck first, both results saved in new logs.

02 result: typecheck exit 0; whole suite exit 1; 14 passed, 1 failed, 1 skipped. SQLite replay returned `updated` at validAt 20 after the fixture mistakenly corrected the preserved `[0,10)` assertion. KV happened to order the replacement assertions differently. This is a silent fixture trap, not evidence that exact-position replay is unsupported.

## 03 — select temporal source by interval

Test fixture repair: `statusFact` now selects the assertion containing an explicit valid-time instant; the correction uses validAt 20 to select the new `[10,infinity)` interval. No expected business result changed (`ready` / `updated` / `corrected` remains fixed). No tests added or removed. Whole suite, typecheck first, separate immutable logs.

03 result: typecheck exit 0; whole suite exit 0; 15 passed, 1 skipped. Stopped testing on the first green whole suite, as instructed. All business assertions retained. No focused probes or additional test executions occurred.

Execution starts from Vitest logs: run 01 16:06:12, run 02 16:06:26, run 03 16:06:45 (machine-local log clock). Logs are never overwritten. Typechecks preceded each corresponding suite invocation. A final `git status --short` reported that this trial directory is not a Git repository; no Git operations or changes to Triplex were made.
