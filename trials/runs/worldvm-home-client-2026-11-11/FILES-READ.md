# Read audit

All paths below are read for this trial only. `BASE` means `/Users/benjacobson/Development/personal/triplex-wt/trial-base`. `node_modules/@triplex-build/triplex` resolves to BASE/packages/core; triplex-sqlite resolves to BASE/packages/sqlite.

| File | Sections | Purpose |
|---|---|---|
| INSTRUCTIONS.md | all | Trial rules |
| BRIEF.md | all | Fixed business requirements Q1–Q6 |
| package.json, tsconfig.json, vitest.config.ts | all | Local execution configuration |
| BASE/docs/database.md | all | Required schema-bound client |
| BASE/docs/agents.md | all | Modeling and host responsibilities |
| BASE/docs/sensitive-values.md | attempted full read (tool output truncated) | Encryption, codec and key-domain contract |
| BASE/docs/operational-primitives.md | attempted full read (truncated), lines 423–505 explicitly | Outbox atomicity, recovery and attribution |
| BASE/docs/host-integration.md | full output visible | World isolation and ambient PG transactions |
| BASE/packages/core/package.json, BASE/packages/sqlite/package.json | all (exports used; full manifests displayed) | Public export locations |
| core/dist/database/index.d.ts | all | Client types |
| core/dist/operational/index.d.ts, Mailbox.d.ts, Entry.d.ts | all | Outbox reads and identifiers |
| core/dist/sensitive/ValueCodec.d.ts, KeyProvider.d.ts, Sensitive.d.ts | all | Public host codec composition |
| core/dist/store/Triples.d.ts | lines 1–115; targeted signature search | Receipts and raw audit reads |
| core/dist/store/CommitValidation.d.ts | all | Assess forced rollback hooks (not used) |
| core/dist/index.d.ts | targeted export search | Public types and runtime |
| sqlite/dist/index.d.ts, SqliteTriples.d.ts | all | SQLite runtime |

No CLI help commands invoked. A package path and two guessed declaration paths did not exist. Directory inventories listed filenames only. An overly broad `rg --files` inventory included the forbidden filename `packages/cloudflare/test/workerd-env.d.ts`; no contents were read. No package implementation, package tests, WorldVM checkout, or source maps were opened. User supplied AGENTS.md instructions were automatically present in the conversation (tool mapping block); no filesystem AGENTS.md was read.

Environment checks: only named PG connection variables were searched (none present); `pg_isready` returned `/tmp:5432 - no response`. `psql` and `pg_isready` executables exist. No PostgreSQL service was provisioned or existing data modified.

## Additional reads during implementation and verification

| File | Sections | Purpose |
|---|---|---|
| BASE/docs/custom-runtimes.md | targeted clock search; lines 1–72 and 168–205 | Assess deterministic test clocks; no custom runtime ultimately used |
| core/dist/runtime/index.d.ts | all | Assess public deterministic runtime surface |
| core/dist/kv/layers/KvTriplesLive.d.ts | all | Scoped KV convenience runtime |
| core/dist/config/Attribute.d.ts | targeted `unique`, `required`, `Use` lines | Repair invalid modifier chain |
| src/model.ts | own code read by repair scripts | Correct declaration and avoid spreading fixture-only vault metadata into typed values |
| test/homes.test.ts | own code read by repair script | Select correction source by valid interval |
| typecheck-01.log, typecheck-02.log, typecheck-03.log | all | Record compiler failures/success |
| run-01.log, run-02.log | all / tail (run 02 tail contained entire output) | Diagnose suite failures without following package source frames |
| run-03.log | final 12 lines; generated full log retained | Verify full suite green |
| temporary `os.tmpdir()/triplex-home-trial-*/world.sqlite` and any sibling WAL/SHM files | raw byte buffers, programmatic plaintext search only | SQLite at-rest plaintext check; fixtures deleted after test |

The tests execute public package exports and the test runner normally; no implementation files were manually inspected. New local files are authored trial artifacts. No additional CLI help commands, external websites, or connected services were consulted.
