# Run timeline

No test invocations before numbered run 01. Every numbered run executes the whole suite.

## 01 — initial implementation
- Added synthetic fixtures, connected-interval normalization, temporal coverage/due windows, two public derivations, atomic evidence replacement and durable guarded host work reconciliation.
- Added 17 tests: eight portable cases run on each backend and one pure host interval case. Each test title cites brief question numbers.
- Business expectations fixed before execution. No expectations changed.
- Commands: prescribed tsc to `typecheck-01.log`, followed by prescribed full verbose vitest to `run-01.log`.

### 01 result
- Typecheck exit 2: three accesses to the public value union did not narrow away sealed values.
- Full suite exit 0: 17/17 passed, KV and SQLite. Runtime success did not establish type safety.

## 02 — public value-union repair
- Narrowed the status value to `string` before reading it; tests compare complete typed values.
- Business expectations, fixtures and test count unchanged. No corrected fixture expectations.
- Commands: prescribed tsc to `typecheck-02.log`, then full verbose vitest to `run-02.log`.

### 02 result
- Typecheck exit 0.
- Full suite exit 0, 17/17 passed (eight per backend plus one pure host case).
- Vitest reported duration 1.11s. Run 01 reported 2.10s.
- Stop condition reached: full suite green and typecheck clean.
- No focused probes, extra test invocations, removed tests, or business-expectation changes.
