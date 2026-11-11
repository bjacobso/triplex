# Cold-author trials

A trial measures whether an author unfamiliar with Triplex can turn a business brief into a
correct, tested model using its public surface. It measures discoverability, first-run success,
repair effort and silent mistakes, rather than engine throughput. Preserve failed attempts as
evidence: eventual green tests alone hide the cost of getting there.

The [2026-11-06 vendor-risk baseline](baseline.md) is the comparison point. Available briefs:
[vendor risk](briefs/vendor-risk.md), [WorldVM homes](briefs/worldvm-home.md), and
[certification expiry](briefs/certification-expiry.md). New briefs contain requirements, not solutions.

## Prepare a run (facilitator)

Use a fresh session with no previous Triplex implementation context. The facilitator prepares the
checkout and directory before handing over; the cold author must not read this repository's
contributor instructions. If a tool automatically injects them, disclose that contamination in the
report. Do not read old trial code, reports, the template's trap catalogue, or the baseline until
independent implementation and the final measurement are complete.

From the repository root, with Node.js >=22.19.0 and pinned pnpm 10.11.0:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@triplex-build/triplex-sqlite... --filter=@triplex-build/triplex-cli...
mkdir -p trials/runs/vendor-risk-YYYY-MM-DD
bash trials/setup.sh trials/runs/vendor-risk-YYYY-MM-DD
cp trials/briefs/vendor-risk.md trials/runs/vendor-risk-YYYY-MM-DD/BRIEF.md
```

Choose a unique directory and the desired brief. `setup.sh` generalizes the original
`vendor-risk/setup.sh`: it links built core and SQLite packages, core's exact Effect copy, and test
tools into a non-workspace directory. It creates ESM, TypeScript and Vitest configuration without
source aliases. Imports resolve through package exports to `dist`; no build output is edited.
The script refuses existing configuration or `node_modules`. It sets up files only; it never runs
or automates an author. For another backend, the facilitator must build and link its public package,
provide any service, and record that setup separately. KV and SQLite are the default trial targets;
PostgreSQL coverage is explicit, never implied by SQLite results.

## Instructions to give the cold author

Read your supplied `BRIEF.md`. Implement synthetic fixtures, a model and tests answering every
question in it. Cite the brief requirement each test covers. Use Effect and public package exports.
Keep business expectations fixed while repairing code; explain any corrected fixture expectation.
Do not edit Triplex itself or copy another trial's implementation.

You may read the root `README.md`, user-facing pages under `docs/` (including examples embedded in
those pages), CLI help output, and published `dist/**/*.d.ts`. You may inspect package `exports`
metadata to locate those declarations. You may read your own trial's files and generated logs.
Do not read package `src`, package tests, other trials, `PLAN.md`, `GOAL.md`, `AGENTS.md`,
`CONTRIBUTING.md`, `ARCHITECTURE.md`, or other contributor notes. Do not follow stack traces or
source maps into forbidden source. Log paths, sections and purpose for every file read, plus help
commands; disclose accidentally loaded forbidden material.

Create `src/` and `test/*.test.ts`. Before the first test execution, typecheck and save the complete
result, including failed typechecks. From the run directory (the commands below assume the
`trials/runs/<name>` layout above):

```sh
../../../node_modules/.bin/tsc -p . > typecheck-01.log 2>&1
../../../node_modules/.bin/vitest run --reporter=verbose > run-01.log 2>&1
```

Capture exit codes immediately (`echo $?` after each command); read the logs even on failure.
Never overwrite them. Run the whole suite, not just a successful subset. After each repair, repeat
both commands with the next log number and record changed expectations or added/removed tests.
Record every test invocation, including probes and reruns, and distinguish full-suite runs from
focused probes. Start a wall-clock timer at handoff and stop at the first complete green suite;
record elapsed time or `not recorded`. Stop and report unsupported requirements honestly rather
than weakening the brief. No time limit is imposed; record one if the facilitator sets it.

## Report and compare (after the cold phase)

Fill [TEMPLATE.md](TEMPLATE.md), then compare with [baseline.md](baseline.md). Preserve logs, code,
revision (`git rev-parse HEAD`), runtime/tool versions, backend setup, files read and all failures.
A green suite can contain tests proving a gap, so report requirement coverage separately. Do not
call an unsupported requirement implemented merely because a gap-detection test passes.

Every report uses the same six-row metrics table. First-run and final rates are passed / total
executed test cases, with percentages and skipped cases listed separately. A collection failure is
`0 collected; blocked`, not a successful empty suite. Runs to green counts every full-suite test
invocation from the first through the first all-pass suite; include failed collection attempts,
exclude typechecks and standalone probes, and record those separately. Report first and final
denominators when tests change. Files read is a distinct-path inventory (partial reads count),
separating docs, declarations, metadata, help and contamination; derive a total only from an
exhaustive inventory. Silent traps hit counts distinct reproduced catalogue IDs and new traps;
list non-reproduced probes separately. Wall-clock time includes reading, modeling and repairs,
with preparation excluded. Use `not recorded` when evidence cannot support a metric.

The starting trap catalogue is the eight entries in the vendor-risk report's **Silent traps**
section, carried into the template as T1–T8. Treat them as historical observations, not assertions
about the current API; a later fix should be recorded as avoided or resolved. The same-millisecond
probe was not reproduced in the baseline. Extend with T9 onward without renumbering old entries.

`trials/` remains excluded by `.prettierignore`, which oxfmt honors; `.oxfmtrc.json` has no override
for it. Preserve `vendor-risk/REPORT.md` verbatim as evidence. That dated report is the baseline;
the executable vendor-risk fixture may already include subsequent regression fixes.
