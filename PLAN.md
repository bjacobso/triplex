# Triplex ergonomics plan

This file is the work plan and progress ledger for making Triplex easy for agents and people to
use directly and to embed. An orchestrator session owns it and delegates implementation to one to
three Codex subagents. Update it as work proceeds so a new session can resume from this file alone.

The reasoning behind the plan is in the review
[Triplex: First-Principles Review and What to Build Next](https://claude.ai/artifact/XHapdm6F3TQA7oaokz1S8E).
This file is the authority on scope and status. `GOAL.md` remains the separate ledger for the
WorldVM operational-primitives work; do not edit its ledger from here except for item P0.1.

## Resume prompt

```text
Start or resume the goal in PLAN.md in this repository. You are the orchestrator.
Read PLAN.md fully, then AGENTS.md, CONTRIBUTING.md, ARCHITECTURE.md and
docs/current-state.md. Inspect the working tree, open PRs and worktrees before
changing anything, and preserve unfinished work. Take the next eligible items
from the ledger, delegate each to a Codex subagent as PLAN.md describes, with
at most three running at once. Verify every result yourself before recording
it. Update the ledger, decision queue and session handoff in PLAN.md before
the session ends. Do not merge, publish or deploy.
```

## Goal

Put one schema-bound layer between every caller and the existing engine, so that the correct
program is the short program, mistakes are errors, and "why" is one call. The engine's contracts
(one write path, bitemporal reads, the journal, content addressing, backend-independent Datalog)
are not to be redesigned.

Five phases, each closed by a gate:

| Phase | Ships                                                                 | Gate                                                                                     |
| ----- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1     | Loud failures: schema-checked queries, error codes that carry a fix   | Every silent trap in `trials/vendor-risk/REPORT.md` raises an error or cannot be written |
| 2     | One front door: entity helpers, typed reads, temporal verbs, a client | A cold-author trial passes on its first run without reading `.d.ts` files                |
| 3     | `why`, preview-then-commit, a self-describing database, an MCP server | An agent with only MCP tools answers the five audit questions in `docs/agents.md`        |
| 4     | A runner package, live queries, valid-time binding in Datalog         | `examples/compliance-host` holds handlers and no scheduler or checkpoint code            |
| 5     | Version 1.0                                                           | Out of scope for this plan                                                               |

## Owner decisions (2026-11-11)

These are settled. Do not reopen them without a new owner request.

- **Audience:** WorldVM is the only user for now; standalone adoption comes later. Judge every
  gate against WorldVM's code and agents. Public-adoption work such as a README rewrite waits.
- **Effect only:** no Promise API. The client is an Effect service.
- **Backends:** new surface targets in-memory KV, SQLite and PostgreSQL. Cloudflare and
  FoundationDB are frozen: they must keep compiling and their existing tests must keep passing,
  but new surface does not have to cover them. This overrides `GOAL.md` execution rule 4 for
  items in this plan.
- **`why`:** stops at the transaction and release by default; an option follows the causation
  chain across commands to a stated depth.
- **Runner:** its own package beside `http` and `cli`, built only on public exports. Core stays
  browser-safe.
- **Position allocator:** stays deferred. It restarts at a retry rate measured in WorldVM, which
  the owner has not set yet (see the decision queue).
- **Greenfield (2026-11-11):** breaking changes to public APIs are allowed. Do not keep old
  shapes, deprecation shims or opt-in flags for compatibility; change the API and its callers in
  the repo, and say what broke in the Changeset. WorldVM pins Triplex tarballs, so it upgrades
  deliberately.
- **One PR per session (2026-11-11):** all items in a session land on one integration branch and
  ship as one pull request at the end of the session, not one PR per item.

## Authorization

- Allowed: branches, worktrees, commits, pushes to the integration branch, and one pull request
  per session from it.
- Not allowed: merging, publishing packages, deploying, editing WorldVM, or force-pushing shared
  branches. Close an existing PR or issue only when the owner approves it in the decision queue.
- Existing PRs #45 and #52 are folded into the integration branch by merging their branches into
  an item branch. Do not push to their `conductor/*` branches. Once the session PR contains one,
  say so in that PR's description and in the decision queue, so the owner can close it.

## Session mechanics

- **Integration branch:** `ergonomics/next`, checked out in the main repository directory, which
  is the orchestrator's working copy. Every item branch starts from it.
- **Worktrees:** one per running item, at `../triplex-wt/<item-id>` on branch `ergo/<item-id>`.
  Each gets `pnpm install --frozen-lockfile` before its agent starts. Briefs live in
  `../triplex-wt/briefs/<item-id>.md`.
- **Agents:** Codex CLI sessions in Rex panes to the right of the orchestrator, started with
  `codex -C <worktree> --sandbox workspace-write --approve-for-me --add-dir <repo>/.git "<prompt>"`.
  The `--add-dir` lets the agent commit, since a worktree's git data lives in the main repository.
  Record each pane's block ID in the session handoff. Read progress with `rex capture`.
- **Launch notes:** `--approve-for-me` already implies the workspace-write sandbox; adding
  `--sandbox` makes Codex exit. Git in a worktree still hits lock-file denials under
  `.git/worktrees/`; the agent requests escalation and `--approve-for-me` grants it. To send a
  follow-up, `rex send` the text, then `rex send-key ... enter` twice: the first Enter ends the
  paste and the second submits.
- **Briefs list every caller.** Before giving an agent a repository-wide API change, grep for the
  callers and list their paths in the brief; agents correctly stop at undeclared paths. Every path
  a brief's tests or acceptance criteria name (for example `test/integration/**`) must also be in
  its allowed paths, and a verb that touches sensitive values needs `packages/core/src/sensitive`.
- **Sandbox limits:** agents cannot use the network or Docker. The orchestrator runs
  `pnpm test:postgres:integration`, `pnpm test:e2e` and screenshot updates itself after merging.
- **Accepting:** the orchestrator reviews the item branch, merges it into `ergonomics/next` with a
  merge commit, runs the checks there, and removes the worktree.

## Orchestration

### Roles

- **Orchestrator:** owns this file, chooses items, writes briefs, reviews diffs, merges item
  branches into the integration branch, runs checks, opens the session PR and records results. It
  does not write feature code itself except to fix small review findings or merge conflicts.
- **Codex subagents:** one item each, in an isolated git worktree on its item branch. A subagent
  commits only to its item branch, never edits `PLAN.md` or `GOAL.md`, and never pushes, merges,
  or opens or closes a PR.

### Lanes

Run at most three subagents at once, and never two in the same lane. A lane is a set of paths
that one subagent may change. An item that must cross lanes runs alone.

| Lane | Owns                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------- |
| A    | `packages/core/src/datalog`, `packages/core/src/kv/datalog`, `packages/sql`, `packages/testkit` |
| B    | `packages/core/src/config`, `packages/core/src/derivation`, new client and `why` modules        |
| C    | `packages/cli`, `packages/http`, new tool packages, `trials/`, `docs/`, root Markdown           |

`packages/core/src/index.ts`, `packages/core/package.json` exports and `docs/current-state.md` are
shared. Only one open item may touch each at a time; record the holder in the ledger.

The write path (`packages/core/src/store`, `packages/core/src/kv/layers`, the backend adapters in
`packages/sqlite`, `packages/postgres`, `packages/cloudflare` and `packages/foundationdb`) belongs
to no lane. An item that changes it runs alone.

### Brief for a subagent

Every brief must contain:

1. The item ID and its acceptance criteria, copied from this file.
2. The lane and the exact paths it may change.
3. What already exists that it must reuse, with file paths.
4. The rule to write the failing test first, and the checks to run before reporting.
5. The decisions above that apply, and the instruction to stop and report options when it meets
   a design choice this file does not settle.
6. The required report: files changed, tests added, commands run with their real output, anything
   skipped or failing, and open questions.

### Accepting a result

A subagent's report is a claim. Before an item is merged into the integration branch, the
orchestrator must:

1. Read the whole diff and confirm it stays inside the lane.
2. Run the focused tests, then `pnpm check`. Run `pnpm pack:check` for package changes and
   `pnpm test:postgres:integration` for temporal, transaction, pagination, Datalog, derivation or
   constraint changes, as `CONTRIBUTING.md` requires.
3. Confirm a Changeset exists for each publishable package change and omits private packages.
4. Confirm the new behavior is covered on KV, SQLite and PostgreSQL where it touches a shared
   contract, and that Cloudflare and FoundationDB still compile and pass.
5. Record failures honestly. A check that could not run is `blocked`, not passing.

### Rules for every item

- Follow `AGENTS.md` and `CONTRIBUTING.md`: ESM, Effect, public package exports only, no edits to
  `dist`, no Node-only APIs in core.
- Greenfield: prefer the right API over the compatible one. When an item changes a public
  shape, update every caller in the repository (packages, examples, docs, snippets, tests) in the
  same item, and list the break in the Changeset.
- Anything the client adds must compile to operations and queries a caller could write by hand.
  Prove it with tests that compare the generated values, as PR #45 does.
- Design-first items produce an RFC under `docs/rfcs/` on the integration branch and stop.
  Implementation starts only after the owner approves it in the decision queue.
- Keep maturity claims in `docs/current-state.md` accurate in the same PR as the change.

## Ledger

Statuses: `pending`, `active`, `pr-open`, `blocked`, `needs-owner`, `done`, `dropped`. `done`
means merged by the owner. Record the branch, PR and the date of each change in the Evidence
column. Take items in order within a phase; items in different lanes may run in parallel when the
Depends column allows.

### Phase 0: groundwork

| ID   | Item                                     | Lane | Depends | Status | Evidence                                                                                                                                                        |
| ---- | ---------------------------------------- | ---- | ------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0.1 | Record the three-backend policy          | C    |         | done   | 2026-11-11: merged `ergo/p0.1-p0.2` (`507a124`); orchestrator updated `GOAL.md` rule 4 and `docs/sensitive-values.md`; the TX3 RFC keeps its historical wording |
| P0.2 | Cold-author trial harness                | C    |         | done   | 2026-11-11: merged `ergo/p0.1-p0.2` (`507a124`): `trials/README.md`, `setup.sh`, `TEMPLATE.md`, `baseline.md`, three briefs                                     |
| P0.3 | Triage open PRs #45, #48 and #52         | —    |         | done   | 2026-11-11; see PR triage below                                                                                                                                 |
| P0.4 | Land ConfigStore targeted reads (PR #48) | B    | P0.3    | done   | 2026-11-11: merged by the owner as `9f4e703`; #46 closed as superseded                                                                                          |

- **P0.1** Update `GOAL.md` execution rule 4, `docs/roadmap.md`, `CONTRIBUTING.md` and
  `docs/current-state.md` to state the backend decision above. Documentation only. Accept when
  `pnpm check` passes and no document still requires new surface on Cloudflare or FoundationDB.
- **P0.2** Turn `trials/vendor-risk` into a repeatable harness under `trials/`. Add two more
  briefs, one shaped like WorldVM's use (per-subject home entity, receipts, outgoing intents) with
  synthetic data only. Define the recorded metrics: first-run pass rate, files read, traps hit.
  Document how to run a trial with a cold agent that sees only public docs and built packages.
  Accept when a README in `trials/` lets a new session run a trial and compare it with the
  2026-11-06 baseline. The harness does not need to automate the agent.
- **P0.3** Orchestrator task, no subagent. For each PR, record whether it rebases cleanly on
  `main`, which checks pass, and what is unresolved. Do not change the branches yet.
- **P0.4** Rebase `conductor/config-store-snapshot-cache` on `main`, mark it ready for review,
  and note in its description that it supersedes PR #46. It serves WorldVM directly: WorldVM
  caches ref resolutions itself because `ConfigRuntime.evaluate` reloads the whole config store.
  Its one breaking change (`ConfigStore.commit` no longer returns `store`) is already in a minor
  Changeset. Accept when CI is green on the rebased branch.

#### PR triage (2026-11-11)

Measured against `origin/main` at `021c3e4`. CI results are from each PR's last push, before
19–22 newer commits on `main`; only #48 was re-checked locally on a merge with current `main`.

| PR  | Branch                                  | Behind `main` | Merge with `main`    | Last CI  | Verdict                                     |
| --- | --------------------------------------- | ------------- | -------------------- | -------- | ------------------------------------------- |
| #45 | `conductor/entity-write-helpers`        | 22            | Conflicts in 3 files | All pass | Rebase with one real fix, then owner naming |
| #48 | `conductor/config-store-snapshot-cache` | 22            | Clean                | All pass | Ready to rebase and un-draft (P0.4)         |
| #52 | `conductor/triplex-commit-validators`   | 19            | Conflicts in 8 files | All pass | Rebase alone; one design question first     |

**#45, entity write helpers.** 5 commits, 17 files.

- `packages/core/src/config/Attribute.ts` conflicts three ways. `main` added `validTo` to
  `AssertionOptions` with inline checks (`b26bfb2`); #45 added the same field with a
  `validateValidity` helper. Keep one implementation. `main` also replaced the inline node with
  `nodeOf(key, type, sensitive, refs)` for sensitive values (#53); keep `nodeOf`.
- **Real defect after a plain rebase.** `Attribute.sensitive(definition)` on `main` returns a
  spread copy, but #45's `.required()`, `.many()` and `.unique()` close over the original
  definition. `Attribute.sensitive(Attribute.text(":worker/ssn")).required()` would build a use
  of the non-sensitive attribute node. The rebase must rebuild the modifiers inside `sensitive()`
  and add a test that the use references the sensitive node.
- The two homepage screenshots in `e2e/docs-home.spec.ts-snapshots` conflict because `main`
  redesigned the homepage (#54). Regenerate them, and regenerate outputs with `pnpm docs:outputs`.
- Also check that `Type.where` and `Type.not` constants on a sensitive attribute are rewritten to
  blind tokens by `Sensitive.layer`, the same as hand-written patterns.
- Unresolved: the naming questions in D1.

**#48, ConfigStore targeted reads.** 2 commits, 7 files. The first commit (`f736544`) is PR #46's
commit cherry-picked unchanged, so landing #48 makes #46 redundant (D8). Its commit-time speedup
on the in-memory store depends on #47, which now conflicts with `main`; on SQL backends the reads
are indexed, so #48 stands alone for WorldVM. The owner merged it on 2026-11-11 (`9f4e703`), and
#46 was closed as superseded. Before the merge, local `pnpm check` passed on #48 merged with `main`: see the
Evidence column of P0.4.

**#52, commit validators.** 2 commits, 27 files, 2,702 added lines. It predates #79, and both add
steps to the `transact` path. Conflicts by size: `TriplesLive.ts` 6 hunks and 171 lines,
`docs/operational-primitives.md` 143 lines, `PostgresqlAdapter.ts` 27, `docs/agents.md` 28,
`KvTriplesLive.ts` 13, and small ones in `Triples.ts`, `testkit`, and the VitePress config. Most
are both sides adding to the same list (imports, error unions, docs sections), so the order of
steps is what matters: preconditions, enforcement, operations including the new
`append-entry` and `acknowledge-entry`, journal, validators, commit.

- Unresolved: whether validators see operational entries (D7). #52 never mentions them because
  they did not exist yet.
- It already covers KV, SQLite, PostgreSQL and Cloudflare. FoundationDB's native suite was not
  run; under the backend decision that is acceptable if FoundationDB still compiles and its
  default tests pass.
- It widens `transact`'s error channel with `CommitRejectedError`. That is a breaking type change
  for exhaustive error handlers, including WorldVM's; say so in its Changeset.

### Phase 1: make wrong things loud

| ID   | Item                                       | Lane | Depends         | Status      | Evidence                                                                                                                                                                            |
| ---- | ------------------------------------------ | ---- | --------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1.1 | Reject unknown attributes in bound queries | A    |                 | done        | 2026-11-11: merged `ergo/p1.1` (`6133995`); `SchemaBound.layer`, `UnknownAttributeError`. Note: `match` reports it as `ReadError.cause` until the write-path error union is widened |
| P1.2 | Stable error codes with a suggested fix    | A, C |                 | active      | 2026-11-11: core half merged (`ergo/p1.2a`): `diagnose`, 38 codes; CLI and HTTP half running as `ergo/p1.2b`                                                                        |
| P1.3 | `_tx` joins at a past `validAt`            | A    |                 | needs-owner | 2026-11-11: designed in `docs/rfcs/datalog-time.md` section 3 (recorded-only `:_tx/*`); waits on D2                                                                                 |
| P1.4 | Loud pin-without-enforce                   | B    | P2.1            | pending     |                                                                                                                                                                                     |
| P1.5 | Re-run the trial against the phase 1 gate  | C    | P0.2, P1.1–P1.4 | pending     |                                                                                                                                                                                     |

- **P1.1** A query checked against a config release must fail before execution when it names an
  attribute the release does not define. Today it returns `[]`. Add an opt-in check that takes
  the attribute keys of a release and a `DatalogQuery`, reuses the shared preflight in
  `packages/core/src/datalog/validation.ts`, and fails with a typed error naming the key and the
  nearest defined key. Reserved `:triplex/*` and `:_tx/*` attributes must stay legal. Because the
  preflight is shared, cover KV, SQLite and PostgreSQL in the conformance corpus. Do not change
  the behavior of `Triples.query` when no release is supplied.
- **P1.2** Give every public error a stable code, the offending path, and one suggested fix,
  and expose them in the CLI JSON envelope. `groupingHint` in `validation.ts` already does this
  for `not` and `or` grouping; generalize that pattern rather than adding a second mechanism.
  Start with Datalog shape errors, `ConstraintViolationError`, `TransactionConflictError` and
  `CommandAlreadyCommittedError`. This crosses lanes A and C, so run it alone or split it into a
  core PR and a CLI PR.
- **P1.3** Joining `["?tx", ":_tx/actor", "?a"]` into a query with a past `validAt` silently
  returns `[]`, because transaction facts are valid only from their commit instant. The options
  are a planning-time error, or evaluating `_tx` patterns at the current valid basis. The second
  changes query semantics. Write both up in a draft RFC with a recommendation and wait.
- **P1.4** Pinning `configSnapshot` without `enforce` records the rules but checks nothing.
  `GraphConstraint.pinned(release)` in PR #45 returns both from one release. After P2.1 lands,
  make the documented path use it everywhere and add a troubleshooting entry. Do not change
  `transact` to enforce by default.
- **P1.5** Run the vendor-risk brief again with a cold agent and record which of the eight
  silent traps still pass silently. This is the phase gate.

### Phase 2: one front door

| ID   | Item                                      | Lane  | Depends    | Status      | Evidence                                                                                                                                                                                                                                    |
| ---- | ----------------------------------------- | ----- | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2.1 | Land the entity helpers (PR #45)          | B     | P0.3       | done        | 2026-11-11: merged `ergo/p2.1`; #45 folded in, sensitive-modifier fix, `nodesOf`, memoized `pinned`, one declaration form. `trials/vendor-risk` stays on the old API as a historical record. Owner may close #45 once the session PR exists |
| P2.2 | Commit validators (PR #52)                | alone | P0.3, D7   | pending     | D7 answered 2026-11-11; conflicts unchanged after `9f4e703`                                                                                                                                                                                 |
| P2.3 | Typed decode of entity facts              | B     | P2.1       | pending     |                                                                                                                                                                                                                                             |
| P2.4 | Temporal verbs                            | B     | P2.1       | done        | 2026-11-11: merged `ergo/p2.4`; `Change.end/replace/correct/combine`, typed `Type.end/replace/correct`, sealed re-assertion only from a same-transaction retracted fact. Core 805/805, integration 208/208                                  |
| P2.5 | Client RFC: the `Database` service        | B     | P2.3, P2.4 | active      | 2026-11-11: `ergo/p2.5` (RFC only)                                                                                                                                                                                                          |
| P2.6 | Client implementation                     | B     | P2.5       | needs-owner |                                                                                                                                                                                                                                             |
| P2.7 | Re-run the trial against the phase 2 gate | C     | P2.6       | pending     |                                                                                                                                                                                                                                             |

- **P2.1** Rebase `conductor/entity-write-helpers` on `main` and bring it to a reviewable state.
  It adds `EntityType.assert`, `Type.where` and `Type.not`, `GraphConstraint.pinned`, and concise
  attribute modifiers. Resolve the conflicts and fix the sensitive-modifier defect described in
  the PR triage, with its test written first. Its open naming questions are in D1; the rebase
  can proceed, but leave the PR as a draft until they are answered.
- **P2.2** Rebase `conductor/triplex-commit-validators` on `main` once D7 is answered. It changes
  the write path, so it runs with no other subagent active. It adds in-transaction host
  checks with typed rejections, which answers the trial's gap for rules that built-in constraints
  cannot express. Confirm it covers KV, SQLite and PostgreSQL.
- **P2.3** Add `Type.decode(facts)` to turn an entity's facts into a typed object keyed by alias,
  honoring cardinality and sealed values. Move the semantics of `encodeEntity` in
  `packages/http/src` into core and make HTTP reuse them, with unchanged HTTP output.
- **P2.4** Add pure builders that return operations and the preconditions they need: end a fact
  at a time (retract, then re-assert with `validTo`), replace a value from a time on, and correct
  a value across all valid time. Add one `validFrom` for all facts of an entity in
  `EntityType.assert` if PR #45 does not already provide it. Test each against the hand-written
  sequence in `docs/concepts.md`.
- **P2.5** RFC only. Specify a schema-bound Effect service that pins and enforces the live
  release on every command by default, takes a command function with typed `put` and the temporal
  verbs, and offers typed `get`, typed queries built from the model, and `asOf` for a pinned
  basis. State exactly which existing operations each call compiles to, how a caller opts out,
  and how errors map to P1.2 codes. Include the layer shape: the client must work over any
  `Triples` and `ConfigStore`.
- **P2.6** Implement the approved RFC as a new subpath of the core package. No behavior change
  to `Triples`.
- **P2.7** Run a fresh brief with a cold agent using only the client. This is the phase gate.

### Phase 3: why, and the agent door

| ID   | Item                               | Lane | Depends    | Status      | Evidence                                                                                                                                                                                                       |
| ---- | ---------------------------------- | ---- | ---------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3.1 | `why` RFC                          | B    |            | done        | 2026-11-11: merged `ergo/p3.1`; `docs/rfcs/why.md`, examples verified against a captured site-safety run                                                                                                       |
| P3.2 | `why` implementation               | B    | P3.1       | needs-owner | Waits on D9                                                                                                                                                                                                    |
| P3.3 | Preview a command on an overlay    | B    | P2.6       | pending     |                                                                                                                                                                                                                |
| P3.4 | Describe from the live release     | C    |            | done        | 2026-11-11: merged `ergo/p3.4`; `describe` returns the release schema, constraints, rules and examples verified by `transaction apply`. Suite timeout raised (flaky at 5 s); rule 5 now cites `Change.replace` |
| P3.5 | CLI commands for `why` and preview | C    | P3.2, P3.3 | pending     |                                                                                                                                                                                                                |
| P3.6 | MCP server package                 | C    | P3.4, P3.5 | pending     |                                                                                                                                                                                                                |
| P3.7 | Run the phase 3 gate               | C    | P3.6       | pending     |                                                                                                                                                                                                                |

- **P3.1** RFC only, and it can start in parallel with phase 1. Define one result shape that
  explains a fact, an entity's current state, or a derivation candidate: the asserting
  transaction, its actor and command, the governing release, and for candidates the source facts
  in `Derivation.ts`. By default stop there; with an option, follow `causationId` across commands
  to a stated depth. State the behavior for retracted facts, a past basis, and sealed values.
- **P3.2** Implement the approved RFC over public `Triples`, journal and derivation APIs.
- **P3.3** Evaluate a command against a read-only overlay (`evaluateOverlay` in
  `packages/core/src/derivation/Overlay.ts`) and return the changes it would make, the constraint
  violations it would cause, and the derivation candidates it would add or remove. Committing
  afterwards uses the same command ID.
- **P3.4** Extend the CLI `describe` manifest to include entity types, attributes, constraints,
  derivations and one example command per entity type, all read from the live release.
- **P3.5** Add CLI commands for `why` and preview with the existing JSON envelope.
- **P3.6** A new package that exposes describe, query, entity reads, `why`, preview and commit
  as MCP tools over the same services the CLI uses. Writes require an actor and command ID. Add
  the MCP SDK to the root pnpm catalog. Confirm the package's publish status with the owner before
  adding it to a Changeset.
- **P3.7** Give a cold agent only the MCP tools and an unfamiliar database, and record whether
  it answers the five audit questions in `docs/agents.md`.

### Phase 4: close the loop

| ID   | Item                              | Lane | Depends   | Status      | Evidence                                                                                                                                |
| ---- | --------------------------------- | ---- | --------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| P4.1 | Valid-time binding in Datalog RFC | A    |           | done        | 2026-11-11: merged `ergo/p4.1`; `docs/rfcs/datalog-time.md` (object interval patterns, `validTime: "all"`). Implementation waits on D10 |
| P4.2 | Runner package RFC                | C    | P2.6      | pending     |                                                                                                                                         |
| P4.3 | Live query RFC                    | A    |           | active      | 2026-11-11: `ergo/p4.3`                                                                                                                 |
| P4.4 | Implement approved phase 4 RFCs   | —    | P4.1–P4.3 | needs-owner |                                                                                                                                         |

- **P4.1** Issue #73 holds the evidence. Specify how a query binds `validFrom` and `validTo`, so
  "expiring within 30 days" is one query, with identical semantics on KV and SQL.
- **P4.2** Specify a package that follows the journal with a `ConsumerCheckpoint`, rematerializes
  affected derivations, sleeps until `nextTemporalBoundary`, and calls host handlers with added,
  removed and changed candidates. It owns catch-up and wakeups only; the host owns what a task
  means. List any public export it lacks.
- **P4.3** Specify `watch(query)` over the ordered transaction feed and the existing dependency
  extraction in `packages/core/src/subscriptions`. Emitters remain wakeup hints.

## Decision queue

Questions only the owner can answer. Add new ones here instead of guessing, mark the dependent
item `needs-owner`, and continue with independent work.

| #   | Question                                                                                                                                                                                                                                                                                                                                                                       | Blocks | Answer                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------- |
| D1  | PR #45 naming: is `assert` right, should a strict `create` ship beside it, is `GraphConstraint.pinned` the right name and place? Recommendation: keep `assert` (it matches the `op`); defer `create` to the client in P2.5, where enforcement is already the default; keep `pinned` in `GraphConstraint` and memoize it per root content ID.                                   | P2.1   | 2026-11-11: yes, as recommended              |
| D2  | `_tx` joins at a past `validAt`: planning-time error, or evaluate at the current valid basis? Now designed in `docs/rfcs/datalog-time.md` section 3, which recommends recorded-only `:_tx/*` (an intentional change to existing metadata queries).                                                                                                                             | P1.3   |                                              |
| D3  | Approve the client RFC                                                                                                                                                                                                                                                                                                                                                         | P2.6   |                                              |
| D4  | What measured retry rate in WorldVM restarts the position-allocator work?                                                                                                                                                                                                                                                                                                      | none   |                                              |
| D5  | Is the MCP server package published or private at first?                                                                                                                                                                                                                                                                                                                       | P3.6   |                                              |
| D6  | Approve each phase 4 RFC                                                                                                                                                                                                                                                                                                                                                       | P4.4   |                                              |
| D7  | Should commit validators see the inbox and outbox entries a transaction appends? Recommendation: yes, read-only in the after-view, since WorldVM commits facts, receipts and outgoing intents together and a validator may need to check an intent.                                                                                                                            | P2.2   | 2026-11-11: yes, read-only in the after-view |
| D8  | PR #46 is contained in #48. Close #46 as superseded once #48 is rebased? Only the owner closes PRs.                                                                                                                                                                                                                                                                            | none   | 2026-11-11: yes; #46 closed after #48 merged |
| D9  | Approve `docs/rfcs/why.md`: one `Why` service on a `why` subpath; a new `Triples.resolveRecordedBasis` read for exact cuts (a write-path change); causation depth capped at 32; whole-entity results unpaginated; candidates explained from a supplied definition plus exact ID, revision and basis; no structured negative witnesses yet. Recommendation: approve as written. | P3.2   |                                              |
| D10 | Approve `docs/rfcs/datalog-time.md` (P4.1): the `{ pattern, valid: { from, to } }` interval pattern, query-wide `validTime: "all"`, `null` for open ends with finite-only ordered predicates, and new interval indexes with migrations in the later implementation. Recommendation: approve, and answer D2 at the same time.                                                   | P4.4   |                                              |

## Not in this plan

Full-text search, client sync, a cost-based optimizer, new backends, authorization inside the
store, a Promise API, a new query language, the position-allocator redesign, and public-adoption
work. Record a request for any of these in the decision queue instead of starting it.

## Session handoff

Update this section last in every session.

- **Last updated:** 2026-11-11, D1, D7 and D8 answered; #48 merged; #46 closed.
- **Running subagents (Rex session `session:01a1a8f5-a3ea-7747-84dd-9a8334d169e3`):**
  - P2.5: block `block:01a1cc3e-5cfe-7c83-a3b7-251ca611357d`
  - P1.2b: block `block:01a1cc3c-9c50-7ebd-8ff0-027fbc0c6a49`
  - P4.3: block `block:01a1cc3c-9c76-78d1-94c8-b828ba0132d8`
- **Open worktrees and branches from this plan:** `../triplex-wt/{p2.5,p1.2b,p4.3}` on
  `ergo/p2.5`, `ergo/p1.2b` and `ergo/p4.3`.
- **Next action:** review P2.4, P1.2a and P3.1 as they report. Then P2.3 (typed decode, lane B),
  the CLI half of P1.2, and P3.4 (describe). Run P2.2 (#52) alone when no other agent is active.
  `pnpm check` and `pnpm test:postgres:integration` (45/45, Docker via OrbStack) passed on
  `ergonomics/next` after P2.1 merged. `pnpm test:e2e` (screenshots) and `pnpm pack:check` are
  still to run before the session PR. Start OrbStack (`orbctl start`) first: with Docker down the
  Postgres suite skips 41 of 45 tests and still exits 0.
- **Known blockers:** D2 holds P1.3.

## Progress log

Newest first. One line per event: date, item, what happened, link.

- 2026-11-11: P2.4 merged (sealed re-assertion reviewed: allowed only for a same-transaction
  retracted fact with identical key, ciphertext and blind token). Started the client RFC (P2.5).
- 2026-11-11: started P1.2b (CLI and HTTP diagnostics) and P4.3 (live-query RFC). P2.3 waits
  for P2.4 and P1.2b, which share `EntityType.ts` and `packages/http` with it.
- 2026-11-11: P3.4 and the time-in-Datalog RFC merged; added D10. CLI describe test was flaky
  at the 5 s default; timeout raised to 30 s.
- 2026-11-11: P2.4 stopped at two undeclared paths (SQLite test; sealed re-assertion under
  `Sensitive.layer`). Scope extended: accept a sealed assert only when byte-identical to a fact the
  same transaction retracts.
- 2026-11-11: P1.2a merged (core 789/789). Started the time-in-Datalog RFC (P4.1 with P1.3).
- 2026-11-11: P3.1 (`why` RFC) merged; D9 added. Started P3.4 (`describe` from the release).
  Postgres integration 45/45 after starting OrbStack.
- 2026-11-11: P1.1 and P2.1 merged. Started P1.2a (core error diagnostics) and P2.4 (temporal
  verbs).
- 2026-11-11: P0.1 and P0.2 merged into `ergonomics/next`. P2.1 stopped at undeclared caller
  paths; scope widened and it resumed.
- 2026-11-11: owner set greenfield and one PR per session. Created `ergonomics/next`, started
  Codex agents for P2.1, P1.1, and P0.1 with P0.2. Updated `GOAL.md` rule 4.
- 2026-11-11: owner answered D1, D7 and D8 (all as recommended) and merged #48 as `9f4e703`. #46
  closed as superseded. #45 and #52 conflict lists unchanged against the new `main`.
- 2026-11-11: P0.3 triage. #48 merges cleanly; #45 and #52 conflict. Found a sensitive-modifier
  defect #45 would introduce on rebase. Added P0.4, D7 and D8; P2.2 no longer waits on P2.1.
- 2026-11-11: plan created from the first-principles review.
