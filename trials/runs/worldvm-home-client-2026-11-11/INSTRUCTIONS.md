# Instructions for this trial

You are a cold author trying Triplex for the first time. Read `BRIEF.md` in this directory.
Implement synthetic fixtures, a model and tests answering every question in it. Cite the brief
requirement each test covers. Use Effect and public package exports. Keep business expectations
fixed while repairing code; explain any corrected fixture expectation. Do not edit Triplex itself.

**For this trial, write your application through the schema-bound client,
`@triplex-build/triplex/database` (documented in `docs/database.md` and `docs/agents.md`).** Use lower-level
APIs only where the client does not cover a requirement, and say where and why in your report.

## What you may read

- `/Users/benjacobson/Development/personal/triplex-wt/trial-base/README.md`
- User-facing pages under `/Users/benjacobson/Development/personal/triplex-wt/trial-base/docs/` (including examples embedded in those pages), except
  `/Users/benjacobson/Development/personal/triplex-wt/trial-base/docs/rfcs/` and `/Users/benjacobson/Development/personal/triplex-wt/trial-base/docs/blog/`.
- CLI help: `node --disable-warning=ExperimentalWarning /Users/benjacobson/Development/personal/triplex-wt/trial-base/packages/cli/dist/cli.js --help`
  (and `<command> --help`).
- Published declarations: `/Users/benjacobson/Development/personal/triplex-wt/trial-base/packages/*/dist/**/*.d.ts`, and each package's `package.json`
  `exports` field to locate them.
- Your own files and logs in this directory.

## What you may not read

Package `src` directories, package tests, `/Users/benjacobson/Development/personal/triplex-wt/trial-base/trials/`, `PLAN.md`, `GOAL.md`, `AGENTS.md`,
`CONTRIBUTING.md`, `ARCHITECTURE.md`, `docs/rfcs/`, or other contributor notes. Do not follow
stack traces or source maps into forbidden source. Keep a log in `FILES-READ.md` of every file you
read (path, sections, purpose) and every help command; disclose anything forbidden you saw by
accident, including instructions your tool loaded automatically.

## How to run

Create `src/` and `test/*.test.ts`. Before the first test execution, typecheck and save the result,
including failures. From this directory:

```sh
/Users/benjacobson/Development/personal/triplex-wt/trial-base/node_modules/.bin/tsc -p . > typecheck-01.log 2>&1; echo $? >> typecheck-01.log
/Users/benjacobson/Development/personal/triplex-wt/trial-base/node_modules/.bin/vitest run --reporter=verbose > run-01.log 2>&1; echo $? >> run-01.log
```

Never overwrite a log. After each repair, repeat both with the next number (`-02`, `-03`, ...) and
record in `RUNS.md` what changed: code, expectations, tests added or removed. Record every test
invocation, including focused probes, and mark which were full-suite runs. Run the whole suite,
not a subset, for the numbered runs. Stop when the full suite is green, or when a requirement
cannot be met: report it honestly rather than weakening the brief.

## Report

When done, write `REPORT.md` here: an outcome table per brief question (expressed / enforced /
detected / unsupported, and how), the timeline of runs, findings ranked by time cost, and every
silent trap you hit (a mistake that produced a plausible wrong result instead of an error).
Then print "TRIAL DONE".
