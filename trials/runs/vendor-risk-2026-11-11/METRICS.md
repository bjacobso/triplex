# Vendor-risk trial, 2026-11-11 (phase 1 gate, P1.5)

Facilitated by the orchestrator. The author's own report is [REPORT.md](REPORT.md); its runs are
in [RUNS.md](RUNS.md) and the numbered logs.

## Setup

- Packages and docs: `ergonomics/next` at `52a6c97`, pinned in a separate worktree so later merges
  could not change them mid-trial. Built with `pnpm turbo run build` for SQLite and the CLI.
- Author: a fresh Codex CLI session (model `gpt-6.1-sol`, reasoning effort medium) with no prior
  context, started with only "Read INSTRUCTIONS.md in this directory and follow it."
- The run directory was outside the repository, so the contributor `AGENTS.md` did not load. The
  user-level `~/.codex/AGENTS.md` loaded automatically; the author disclosed it in `FILES-READ.md`.
- Handoff 21:38:06 UTC; `TRIAL DONE` observed by 21:43:28 UTC.

## Metrics

| Metric | This run | 2026-11-06 baseline |
| --- | --- | --- |
| First-run test pass rate | 11/15 (73%); first typecheck failed (exit 2) | 0/16 (0%) |
| Final pass rate | 17/17 (100%) | 17/17 (100%) |
| Runs to green | 2 full-suite runs, no probes | not recorded (0/16, 11/16, 17/17 stated) |
| Files read | see `FILES-READ.md` | not recorded |
| Silent traps hit | 0 observed; T1 (past `_tx` join), T4 (missing is not false) and T6 (expiry without writes) avoided from the docs | T1 to T7 observed |
| Wall-clock time | about 5 minutes 22 seconds | not recorded |

## What this does and does not show

- **Not a like-for-like comparison.** The baseline author was a different model. Part of the
  improvement may be the author, not the API.
- **The schema-bound path was not used.** The author wrote no `EntityType`, no release, no
  `GraphConstraint` and no `SchemaBound` layer; it modeled with raw facts, Datalog and a commit
  validator. The phase 1 protections against silent traps (unknown attributes, cardinality and
  requiredness only under enforcement) were therefore never exercised. A misspelled attribute in
  this model would still return `[]`. The gate "every silent trap raises an error or cannot be
  written" is not demonstrated by this run.
- **Findings that are API problems:**
  1. `CommitValidation.View.query` returns the binding array, while `Triples.query` and
     `queryAll` return `{ results }`. One repair cycle and four failures.
  2. `SqliteTriples.layer` outputs `StorageAdapter`, `SqlClient`, `CurrentDialect` and other
     internals beside `Triples`, so a test parameterized over KV and SQLite cannot share one layer
     type.
  3. Every read of a fact value needs narrowing because the value union includes sealed values;
     `Type.decode` solves this but was not discovered.
- **Docs worked.** The author avoided three documented traps because `docs/agents.md` and
  `docs/concepts.md` warned about them, and used `Change.correct` for its correction.
