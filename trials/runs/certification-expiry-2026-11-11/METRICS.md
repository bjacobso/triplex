# Certification-expiry trial, 2026-11-11 (P1.9)

Facilitated by the orchestrator after P1.8 made `docs/agents.md` and `docs/getting-started.md` lead
with the `Database` client. The author's own report is [REPORT.md](REPORT.md).

## Setup

- Packages and docs: `ergonomics/next` at `61958d6`, pinned in a separate worktree.
- Author: a fresh Codex CLI session (`gpt-6.1-sol`, medium effort), started with only "Read
  INSTRUCTIONS.md in this directory and follow it." Run directory outside the repository; the
  user-level `~/.codex/AGENTS.md` loaded automatically and was disclosed.
- Handoff 22:03:42 UTC; report written by 22:09:28 UTC.

## Metrics

| Metric | This run | Vendor-risk run, same day |
| --- | --- | --- |
| First-run test pass rate | 17/17 (100%); first typecheck failed (exit 2, sealed-value narrowing) | 11/15 (73%) |
| Final pass rate | 17/17 | 17/17 |
| Runs to green (type-clean) | 2 full-suite runs, no probes | 2 |
| Silent traps hit | 0 wrong results observed | 0 |
| Wall-clock time | about 5 minutes 46 seconds | about 5 minutes 22 seconds |

## Finding: the docs change did not reach the author

The author read `README.md`, then the pages the README links for its problem (`derivations.md`,
`datalog.md`), and the published declarations. It never opened `agents.md`, `getting-started.md` or
`database.md`, so the P1.8 change that leads those pages with the client had no effect. Its model
uses raw `Triples`, Datalog and derivations; no entity types, no release, no `SchemaBound`, no
client. The README leads with the raw `Triples` quick start. The README is the real entry point for
cold authors; see decision D12 in `PLAN.md`.

Other findings: sealed-value narrowing again cost one typecheck repair (as in the vendor-risk run),
and the author kept connected-interval union in host code because derivation provenance supports
only patterns, predicates and negation.
