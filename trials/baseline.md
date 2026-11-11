# Vendor-risk baseline — 2026-11-06

Source: [the original report](vendor-risk/REPORT.md), preserved verbatim. This is a historical
measurement, not a rerun against today's API. Its tests include demonstrations of gaps and silent
traps; passing them does not establish that every brief requirement was enforced.

| Metric | Recorded value | Evidence / qualification |
| --- | --- | --- |
| First-run test pass rate | 0/16 (0%) | Timeline step 5: “First run: 16/16 fail” |
| Final pass rate | 17/17 (100%) | Final output and Timeline step 7; the suite grew from 16 to 17 |
| Number of runs to green | not recorded (total) | Timeline steps 5–7 record 0/16, 11/16, then 17/17, but do not state an exhaustive run count |
| Files read | not recorded (total) | “Files read” lists paths and partial sections; some declaration paths are abbreviated and no total is stated |
| Silent traps hit | T1–T7 observed; total not recorded | “Silent traps” lists eight entries; T8's same-millisecond probe did not reproduce (`same: false`) |
| Wall-clock time | not recorded | No duration or start/end times stated |

The run used KV and checked Q1–Q3 on SQLite. The report does not state a source revision or exact
elapsed time. Its Phase 1 inventory includes README, user-facing docs and snippets, package exports,
published declarations and CLI help. Contributor `AGENTS.md` was automatically loaded; the author
disclosed this and said no API detail from it was used. Phase 2 and forbidden source reads: none
reported. Preserve those qualifications when comparing with a cleaner isolated session.

Trap IDs T1–T8 follow the original **Silent traps** order in [TEMPLATE.md](TEMPLATE.md).
The assertion-options trap T2 was subsequently fixed in the executable fixture; the dated report
still records the original failure. Later reports must distinguish resolved traps from untested
ones and compare requirement coverage as well as pass rates.
