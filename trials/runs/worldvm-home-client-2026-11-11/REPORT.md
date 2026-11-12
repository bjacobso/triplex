# WorldVM subject homes trial

**Portable outcome:** schema-bound implementation complete; typecheck passes; KV and SQLite suite passes **15 tests**, with **1 PostgreSQL test explicitly skipped**. This is a deterministic small synthetic trial, not certification for 100,000 subjects or 16 production runners. Triplex and WorldVM source/checkouts were not modified or inspected.

The application is in `src/model.ts`; tests in `test/homes.test.ts` cite BRIEF question numbers in every test title. All application writes use `@triplex-build/triplex/database`, with Effect and public exports only.

## Outcomes by brief question

| Brief question | Outcome | Evidence and boundary |
|---|---|---|
| Q1: one home per subject; selected world/home isolation | Expressed and enforced on KV/SQLite | Stable `home:<vault>:<subject>` IDs, required unique subject attribute, separate backend lifetime per world. Two subjects in world A; world B uses Alice's identical subject ID and command ID with independent state. Reads before creation in B are absent; reads after creation differ by world. Host-denied home/world reads and writes fail. Typed list in A returns exactly Alice and Bob. The host passes the trusted world identity and selects its matching runtime; these exported fixture helpers are not an authenticated network API. |
| Q2: facts, receipt, outgoing intents atomic and attributable | Enforced and detected on KV/SQLite; PostgreSQL untested | One `db.command` creates all effects. Receipt actor, command, correlation, release, fact entity IDs, and outbox append txId/position are checked. Host audit retrieves the typed home, persisted receipt and intent together in one Effect. Forced callback failure and commit-time cardinality violation both leave no Bob facts/history, receipt or intent. Audit reads are sequential after completion, not a new guarantee of a snapshot-consistent multi-read under concurrent writes. |
| Q3: duplicate commands and competing runners | Enforced and detected on KV/SQLite | 16 concurrent same-ID calls yield one txId, one status assertion, one journal command and one intent. A changed actor/payload callback is skipped and original receipt returned. Two synchronized different-ID commands both observe the same home before writes: exactly one succeeds, one returns `TransactionConflictError`, with no loser receipt or intent. Reload winner's source fact and retry loser with same ID: one subsequent commit; another retry is inert. These are in-process fibers against one runtime, not independent processes/pools. |
| Q4: exact historical commit position, including equal timestamps | Enforced and detected on KV/SQLite | All three command timestamps are asserted equal using a fixed `Date.now` in this test. Initial create, valid-time replacement at 10 and correction are distinct positions. At validAt 20, first cut is `ready`, second is `updated`, third is `corrected`; at validAt 5 the preserved past is `ready`. A timestamp cut intentionally includes the later equal-time correction, demonstrating why it cannot substitute for the saved position. |
| Q5: sealed sensitive values; authorized open; wrong keys | Enforced for tested host mapping; native vault/retention domains unsupported | Home fields `secret` and `archive` are sensitive. AES-GCM through Sensitive sits beneath the schema-bound client. Persisted fact reads, journal, typed reads and ordinary status query contain neither synthetic plaintext. Both sensitive facts are sealed; explicit `Sensitive.open` recovers exact fixture values. Projecting the sensitive variable in a query fails with `SensitiveQueryError`. Wrong vault and wrong retention key mappings each fail with `SensitiveValueError`. SQLite main/WAL/SHM bytes, when present after close, lack plaintext. This is not an exhaustive memory/index forensic audit. |
| Q6: restart discovery without exactly-once external delivery | Enforced and detected, with host delivery responsibilities | New stateless worker invocations discover identical pending entries; reading neither claims nor acknowledges. A host command acknowledges and retains append/ack provenance. SQLite runtime is disposed and rebuilt over the same file: receipt, home and pending intent survive. This simulates resource/runtime restart within one Node process, not an OS crash test. KV tests restart worker state while keeping the store alive; in-memory KV does not survive process restart. No real external delivery is attempted or claimed. |

## PostgreSQL status

No PG URL or host/database connection variables were supplied. `pg_isready` found no response at the default local socket `/tmp:5432`. Therefore PostgreSQL serializable isolation, independently competing pools/processes, physical database-per-world provisioning, and ambient host SQL transaction rollback are **UNTESTED**, not passed or contradicted. Existing tools alone do not establish an available service.

The public host-integration documentation describes `PgTriples.layerForDatabase` and `PgTriples.withTransaction` for a mapped database runtime and ambient transaction. This trial has no executable PostgreSQL adapter or ambient host-row fixture; the skip records that gap. Portable assertions never substitute for those PostgreSQL guarantees.

## Host duties and public-surface boundaries

- **Dispatch and authorization:** authenticate first; resolve a server-owned world-to-runtime mapping; check access to the home before supplying its runtime. The fixture `Principal` and `authorize` make that division explicit. Callers must not choose unchecked world strings or directly expose raw Database/Triples capabilities. Authorization also covers receipt/intents and explicit decryption. This is not a production auth implementation.
- **One transaction per command:** command IDs are scoped to the world database, not automatically to each home. Real ingress must choose stable IDs that cannot collide across different subjects/actions. The fixture intentionally reuses an ID across worlds to prove separate scopes. Reusing a committed ID for another payload returns its original receipt; payload identity validation is host work.
- **Key domains:** `SensitiveContext` exposes database, entity, attribute and value type, not native vault or retention-class fields. The public AES-GCM `subjectOf` extension supports a host mapping. Here the encoded key-subject tuple contains vault, attribute-selected retention class and home ID; database is also scoped by KeyProvider. Tests change one tuple domain while retaining ciphertext/context and show opening fails. There is no claim of a native per-vault retention key lifecycle or KMS integration. `KeyProvider.test` uses public deterministic synthetic keys and is suitable only for fixtures. No erasure schedule, rotation lifecycle, retention deletion or production key provider is implemented.
- **Outgoing work:** payloads hold only a synthetic subject identifier and refresh verb; no secrets. Attribute-sensitive sealing does not cover operational payloads. A real host must pre-encrypt sensitive payloads, authorize reads, retry delivery, arrange leases or destination idempotency, and acknowledge after success. An external success followed by a crash before acknowledgement can redeliver; no exactly-once guarantee is inferred. Unacknowledged intent after fact commit is expected.
- **Rejected attempts:** concurrent duplicate claim losers recover the winner's receipt and are not exposed as rejected calls by this client. Distinct-command conflicts are observable to the host (captured in tests); this fixture does not persist rejection telemetry. Adding an attempted-command audit must respect failed-command rollback and have an explicit separate host policy.
- **Replay:** fact reads support exact recorded positions. Operational entries do not appear in ordinary fact/Datalog history or `db.asOf`; no historical outbox reconstruction is claimed. Views retain the selected schema; the fixture uses a single release.

## Lower-level public APIs used and why

1. `ConfigStore` and `EntityType.nodesOf` publish the schema before client acquisition. Publishing is host-owned and absent from the client.
2. `KvTriples` and `SqliteTriples` compose the backing runtime. The client does not provision storage.
3. `Sensitive`, `ValueCodec` and `KeyProvider` supply encryption and explicit host decryption. The client delegates sensitivity rather than exposing key management.
4. `Triples.transactionByCommand`, `Triples.transactions`, `Triples.history` and `Triples.entity` inspect persisted receipts, journal and sealed source facts in audit/tests. The client returns a receipt on command but has no independent persisted receipt/journal/history lookup. Application temporal edits still use client `tx.get`, `tx.fact`, `tx.replace` and `tx.correct`, with source IDs from receipts.
5. `Outbox.get`, `Outbox.id` and `Outbox.pending` discover/read operational entries, which the client cannot read. Appends and acknowledgements use the client builder in commands. No primitive `Triples.transact` write is used.

No fallback timestamp replay, separate fact/receipt/intent commits, internal package imports, implementation patches or unsupported native sealing guarantees were introduced.

## Runs and repairs

Every run was the entire suite and had a saved typecheck first. All six numbered logs retain their appended process exit code; no log was overwritten and no focused tests were invoked.

| Run | Typecheck | Suite | Change/result |
|---|---|---|---|
| 01 | Exit 2 | Exit 1; no tests collected | Initial declaration chained `.required().unique()`. The returned use has a boolean `unique`, so both compiler and runtime rejected it. |
| 02 | Exit 0 | Exit 1; 14 pass, 1 fail, 1 skip | Repaired to `.required({ unique: true })`. SQLite replay exposed wrong source selection in the test fixture. |
| 03 | Exit 0 | Exit 0; 15 pass, 1 skip | Selected temporal assertion by containing valid interval. All business expectations unchanged. Stopped on green. |

See `RUNS.md` and `typecheck-01.log` through `typecheck-03.log`, `run-01.log` through `run-03.log`. Vitest logs show starts at 16:06:12, 16:06:26 and 16:06:45; suite durations were under one second each. These durations do not measure application authoring effort or production performance.

## Findings ranked by time cost

1. **Public API composition and boundary research — largest authoring cost.** Required separate schema publishing, storage lifetime, sensitivity codec and client layers; receipt/outbox inspection needs public primitives outside the client. Documentation covered these paths without inspecting implementation.
2. **Temporal fixture source selection — approximately 19 seconds between run 02 and 03 starts, plus diagnosis.** Receipt change order differs across backends. Selecting by first assertion corrected a different valid interval and gave a plausible incorrect result on SQLite. Selecting the assertion that contains validAt 20 repaired the fixture. No expected value was changed.
3. **Schema modifier ergonomics — approximately 14 seconds between run 01 and 02 starts.** The fluent-looking modifier chain was invalid; published declarations clarified that options combine requiredness and uniqueness. This was a loud failure caught by the required initial typecheck.
4. **PostgreSQL availability — brief check, unresolved environment gap.** No connection was configured and the default service was unavailable. No time was spent provisioning a database or claiming simulated serializable coverage.

## Silent traps actually encountered

**One actual plausible-result trap:** a temporal replacement receipt contains both a preserved past assertion and a new assertion. The initial fixture assumed the first status assertion was the new one. KV ordering happened to satisfy that assumption; SQLite ordering selected `[0,10)`, so correcting it left `updated` at validAt 20. The fixed helper tests the interval, including exclusive `validTo`, instead of receipt order. This corrected source selection, not a fixture expectation or the brief.

Additional semantic hazards explicitly exercised or bounded: equal timestamp replay includes later commits; duplicate IDs ignore new payloads; pending reads do not claim delivery; the unencrypted in-memory KV runtime is not durable across process restart; schema-sensitive policies do not protect outbox payloads. These are documented boundaries, not extra bugs observed in this trial.

## Read restrictions

`FILES-READ.md` records all consulted files, sections and purposes, own logs and temporary persisted-file byte reads. No help commands were invoked. No forbidden implementation/test contents or source maps were read. The initial filename inventory exposed a forbidden test filename only, and user-supplied AGENTS.md mapping instructions were automatically present in the conversation; both are disclosed there. No WorldVM checkout was read or modified. This directory is not a Git repository, so no diff/commit report is available.
