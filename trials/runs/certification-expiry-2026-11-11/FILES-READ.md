# Read audit

- Local `INSTRUCTIONS.md`: entire file; trial constraints and procedure.
- Local `BRIEF.md`: entire file; business requirements and six questions.
- Local `package.json`, `tsconfig.json`, `vitest.config.ts`: entire files; execution and dependency configuration.
- `/Users/benjacobson/Development/personal/triplex-wt/trial-base/README.md`: entire file; public overview and documentation links.
- Listed local filenames and documentation filenames using `rg --files`; no contributor content read.

## Automatically supplied material
The conversation supplied user AGENTS.md instructions (Compound Codex tool mapping), environment details and general agent/runtime instructions before this trial's restriction was known. No on-disk AGENTS.md was opened. No forbidden Triplex implementation or contributor files intentionally read.
- Triplex docs `derivations.md`, `datalog.md`: entire pages; exact provenance, temporal wakeups, freshness, query syntax and temporal cuts.
- Attempted nonexistent `packages/triplex/package.json` and its dist listing; no content obtained.
- `packages/sqlite/package.json` and local `node_modules/@triplex-build/triplex/package.json`: package metadata/exports (full output); locate public declarations. Metadata outside exports was incidentally printed; no implementation read.
- Attempted nonexistent relative Effect package.json; no content obtained.
- `packages/sqlite/dist/SqliteTriples.d.ts`: entire declaration; backend layer.
- Core public dist declarations: `derivation/index.d.ts`, `derivation/Derivation.d.ts`, `derivation/Materialization.d.ts`, `Temporal.d.ts`, `Value.d.ts`, `store/Triples.d.ts`, `Triple.d.ts`, `index.d.ts`: entire declarations; API types and transaction guards.
- Documentation filename listing accidentally included forbidden blog/RFC filenames because absolute-path glob exclusions did not apply. No file contents were read from those directories.
- Local `src/fixtures.ts`, `src/model.ts`, `test/certification.test.ts`: authored content reviewed while writing/editing; fixtures, host normalization/lifecycle and portable tests. No external example implementation used.
- Local `typecheck-01.log`, `run-01.log`, `typecheck-02.log`, `run-02.log`: entire files; evaluate both numbered full-suite runs and typechecks. Stack-trace/source-map navigation was unnecessary.
- Local `RUNS.md`, `REPORT.md`, `FILES-READ.md`: authored/reviewed content; execution timeline, outcomes, limitations and audit.
- `Triple.d.ts` output was truncated by the output budget; precondition declarations and exports were visible, not all intermediate generated schema repetition. `index.d.ts` export surface was visible.
- No help commands executed. No forbidden file content opened beyond the automatically supplied AGENTS.md-style user instructions disclosed above. Full allowed package.json reads also printed contributor script metadata incidentally; only exports/package location were used.
