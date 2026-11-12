# WorldVM-home trial through the client, 2026-11-11 (P2.7, phase 2 gate)

Facilitated by the orchestrator. Unlike the earlier two trials, the author was told to write the
application through `@triplex-build/triplex/database`, so this measures the client's ergonomics, not
whether a newcomer finds it. The author's report is [REPORT.md](REPORT.md).

## Setup

- Packages and docs: `ergonomics/next-2` at `d632605`, pinned in a separate worktree.
- Author: a fresh Codex CLI session (`gpt-6.1-sol`, medium effort). Run directory outside the
  repository; the user-level `~/.codex/AGENTS.md` loaded automatically and was disclosed.
- Handoff 00:02:21 UTC (Nov 12); report written by 00:08:45 UTC.
- No PostgreSQL was configured, so the PostgreSQL requirements were explicitly skipped.

## Metrics

| Metric | This run |
| --- | --- |
| First-run test pass rate | 0 collected (module load failed); first typecheck exit 2 |
| Final pass rate | 15/15 KV and SQLite, 1 PostgreSQL test skipped |
| Runs to green | 3 full-suite runs, no probes |
| Silent traps hit | 1 (receipt change order differs between KV and SQLite) |
| Wall-clock time | about 6 minutes 24 seconds |
| Client use | every application write through `db.command`; lower-level reads for receipts, journal, history and outbox |

## Findings

1. **Receipt change order differs by backend (silent wrong result).** A `tx.replace` receipt
   holds the preserved past assertion and the new one. KV and SQLite return them in different
   orders; code that took the first one corrected the wrong interval on SQLite only. Item P2.9.
2. **Use modifiers do not chain.** `.required().unique()` fails at type and run time; the working
   form is `.required({ unique: true })`. Item P2.8.
3. **Client gaps.** No receipt, journal or history lookup and no outbox read through the client;
   the author used `Triples` and `Outbox` directly. Item P2.10.
4. Key domains for sealed values (vault, retention class) need a host mapping through
   `subjectOf`; see the TX3 host-sealed-values RFC. Not a new item.
