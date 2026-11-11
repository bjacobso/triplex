# Runs

All invocations are full-suite, numbered runs. No focused probes. Logs never overwritten.

## 01
- Implemented `src/model.ts`, `src/fixtures.ts`, `test/vendor-risk.test.ts`: 15 tests with brief question citations.
- Before first test execution: `tsc -p . > typecheck-01.log 2>&1`; appended exit code 2. Sealed-value narrowing, validator query result shape, and layer union typing errors.
- `vitest run --reporter=verbose > run-01.log 2>&1`; appended exit code 1. 11 passed, 4 failed; validator assumed `.results` on its direct binding-array result.
- No business expectations changed. Initial fixture expectations passed.

## 02
- Repair: validator `View.query` returns the binding array directly; public `queryAll` retains `.results`. Narrowed fact scalar extraction for the sealed-value union. Simplified guarded layer parameter to the public Triples service.
- Tests: retained all initial tests and expected answers; added two backend cases for no-write expiry of guarded active vendors and rejected future activation with expired evidence (17 total). Added positive CISO exception + DPA signing and checked business rejection codes.
- No fixture or business expectation changed; no tests removed.
- Commands: full `tsc -p .` to `typecheck-02.log`, followed by full `vitest run --reporter=verbose` to `run-02.log`, each with appended exit status.
- Results: typecheck exit 0; full suite exit 0, 17/17 passed (KV and SQLite). Stopped execution at first green full suite as instructed.
