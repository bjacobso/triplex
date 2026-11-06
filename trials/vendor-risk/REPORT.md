# Cold-author trial: vendor risk review on Triplex

Brief (verbatim source for all code here): vendor risk review for a 200-person SaaS company. Vendors
touching customer data need a security review before contract signature (completed questionnaire +
current SOC 2 Type II or approved exception); reviews expire after 12 months; high-risk vendors
(processing customer personal data) also need a DPA; exceptions are CISO-only, need a reason, and
expire after 6 months; procurement must not mark a vendor active while its review is incomplete or
expired. Synthetic data only; illustrative, not compliance advice.

## Run it

```sh
export PATH=/opt/node24/bin:$PATH            # default node here was 22.23.4; 24 also works
cd <repo> && corepack enable && pnpm install --frozen-lockfile
pnpm turbo run build --filter=@triplex-build/triplex-sqlite... --filter=@triplex-build/triplex-cli...
cd trials/vendor-risk && ./setup.sh          # symlinks built packages + effect into node_modules
../../node_modules/.bin/tsc -p .             # typecheck
../../node_modules/.bin/vitest run --reporter=verbose
```

Final output (2026-11-06):

```
 ✓ brief queries > Q1: vendors that need a review now
 ✓ brief queries > Q2: active vendors with incomplete or expired review, as of a date
 ✓ brief queries > Q3: exceptions expiring within 30 days (two-basis Datalog and match/validTo agree)
 ✓ brief queries > Q4: review state on a past date, and who asserted it (valid-time travel + provenance)
 ✓ brief queries > Q4b: recorded-time travel across a correction, with who corrected it
 ✓ enforcement > built-in constraint: an exception without a reason is rejected (required)
 ✓ enforcement > host guard blocks activation while review is incomplete; allows it when complete
 ✓ enforcement > GAP: a direct write bypasses the guard; only the detection query catches it
 ✓ enforcement > GAP: time alone makes a compliant active vendor non-compliant; no write ever happens
 ✓ silent traps > joining :_tx/actor in a past-validAt query silently returns [] (journal facts are valid from commit time)
 ✓ silent traps > a typo'd attribute returns [] instead of an error
 ✓ silent traps > Attribute.assertion() silently drops validTo when the options object is not a literal
 ✓ silent traps > missing value is not false: without enforce, a vendor with no customer-data flag is invisible to Q1
 ✓ silent traps > cardinality: a second status assertion without a retract — enforced vs not
 ✓ silent traps > same-millisecond commits (probe; did not reproduce: { same: false, seesB: false })
 ✓ silent traps > duplicate commandId fails instead of re-applying
 ✓ SQLite parity > Q1/Q2/Q3 give the same answers on SqliteTriples
 Test Files  1 passed (1)   Tests  17 passed (17)
```

Files: `src/model.ts` (schema), `src/seed.ts` (release + synthetic facts), `src/queries.ts`
(queries + activation guard), `test/vendor-risk.test.ts`, `probes/*.ts` (syntax/error probes run with
`../../node_modules/.bin/tsx probes/<file>.ts`).

## Outcome

| Brief item | Status | How |
| --- | --- | --- |
| Schema for vendors, reviews, evidence, exceptions, people | **Expressed + passing** | `EntityType`/`Attribute` DSL, committed as release `vendor-risk-2026.1`, every write pinned + `enforce`d |
| Review = questionnaire + (SOC 2 or exception) | **Expressed + passing** | Datalog `not` with multi-clause conjunction; one query per failure reason, unioned in host code (`or` can't take conjunctive branches) |
| Reviews expire after 12 months | **Expressed + passing** | Valid time `[completedAt, completedAt+12mo)`; expiry falls out of `validAt` |
| High-risk vendors need a DPA | **Expressed + passing** | `missing-dpa` reason query |
| Exceptions CISO-only | **Expressed (as a query) + passing** | Exception only counts if `approved-by → role "ciso"`. Not *enforced*: a procurement-approved exception can be written; it just doesn't count. Built-in constraints can't express "ref target has role X". |
| Exceptions must give a reason | **Expressed + enforced + passing** | `required: true` + `enforce` → `ConstraintViolationError` |
| Exceptions expire after 6 months | **Expressed + passing** | Valid time `[approvedAt, +6mo)` |
| Q1 vendors needing review now | **Passing** | `vendorsNeedingReview({validAt})` → beta (missing DPA), eta (non-CISO exception), gamma (expired), zeta (no review) |
| Q2 active vendors incomplete/expired as of date | **Passing** | Today: beta, gamma. 2026-12-02: + delta (exception lapsed) |
| Q3 exceptions expiring within 30 days | **Passing** | No way to read `validTo` in Datalog, so: visible at `t` AND not visible at `t+30d` (two queries). Cross-checked with `match` + `Triple.validTo` |
| Q4 past review state + who asserted it | **Partial → passing with a workaround** | Valid-time state is one query; provenance needs a **second** query at the current basis (see trap 1). Recorded-time travel works but recorded time can't be backdated |
| "Must not mark active while review incomplete/expired" | **Partial** | No declarative rule. Host guard (`activateVendor`) checks the detection query then writes with an `EntityState` precondition. A direct `transact` bypasses it (test proves it), and time alone expires reviews of already-active vendors, so the **detection query (Q2) is the real control** |
| SQLite (recommended durable adapter) | **Passing** | Q1–Q3 identical on `SqliteTriples.layer({ filename: ":memory:" })` |

## Timeline

1. **Read Phase 1 docs** (list below). README + agents.md give a clear mental model. Build
   needed: `packages/*/dist` did not exist; README only says `pnpm turbo run build` in the CLI section.
2. **Import from `trials/`**: `trials/` is not in `pnpm-workspace.yaml`. The docs' own way of running
   snippets (`docs/snippets/tsconfig.json`) maps imports to **`packages/*/src`**, which is not
   the public path. Instead I built dist with turbo and symlinked `packages/core`, `packages/sqlite`
   and core's `effect` into `trials/vendor-risk/node_modules` (`setup.sh`). Worked first time.
3. **Datalog syntax probe** (`probes/syntax.ts`): the docs show single-clause `not` and `or` only.
   `["not", c1, c2]` works (conjunctive). `["not", ["and", …]]`, `["or", [[c1, c2], [c3]]]` and
   `["or", [["and", …], …]]` all fail with `Invalid Datalog query shape: Expected PredicateOp at
   ["where"][1][0] … Expected IdentityTerm …` (a long list of union-member mismatches that doesn't
   say "or branches must be single clauses"). Switched to one query per failure reason.
4. **Typecheck**: `Attribute.date` is typed `string` → switched to `instant`. `AssertionOptions` has
   only `validFrom`, so `validTo` passed through it is dropped (trap 2). `Triple.validTo` is
   `Option<number>`, but `validFrom` is a plain `number`. Retract op is `{op:"retract", id}`, which I learned
   from the type error, not the docs.
5. **First run: 16/16 fail** with `ConstraintViolationError: Transaction would introduce or worsen 12
   graph constraint violations`. The message gives no rule; dumping the error (`probes/violation.ts`)
   showed a rich `violations[]` with `validAt` per violation. Cause: **required and reference-target
   constraints are checked at every valid-time edge of the entity.** My vendor's `status` had
   `validFrom: 2026-03-15` while `name` defaulted to commit time, so on 2026-03-15 a Vendor existed
   without a name. Then a review dated 2026-03-01 referenced a vendor/person whose facts started later.
6. **Remodeled time**: every fact of an entity shares its interval; people valid from 2020; vendors
   from 2025-01-01; status = `prospect [known, since)` + `active [since, ∞)`. 11/16 passed.
7. **Remaining failures**: (a) provenance join empty at past `validAt` (trap 1), split into two
   queries; (b) activation = retract + assert left a `required` gap in the vendor's past, so the guard now
   re-asserts the old status with `validTo` (no "close interval" op exists); (c) my own fixture
   expectation (acme's SOC 2 also expired). 17/17 pass.

## Findings (ranked by time cost)

1. **Constraints are evaluated across valid time; this is undocumented and it cost the most time.**
   `required` / reference-target are checked at every valid-time edge, so an entity's facts must
   share intervals and referenced entities must be valid earlier. The error message only gives a
   count. *Wish:* "Graph constraints hold at every valid instant of the entity: give all of an
   entity's facts the same `validFrom`, and make referenced entities valid at least as early;
   inspect `error.violations` for `validAt`."
2. **No documented way to import packages outside the workspace; doc snippets resolve to `src/`.**
   *Wish:* "To try Triplex from a source checkout outside the workspace, build with
   `pnpm turbo run build --filter=@triplex-build/triplex-sqlite...` and link `packages/core` (and its
   `effect`) into your project's `node_modules`."
3. **`or`/`not` grammar is only shown for single clauses.** Conjunctive `not` works but is undocumented.
   Conjunctive `or` branches seem unsupported, and the error is a schema union dump. *Wish:* "`not`
   accepts several clauses (`["not", c1, c2]`); each `or` branch is one clause. Use `not` or rules
   for conjunctive alternatives."
4. **Changing a state field over time is undocumented.** agents.md says "retract and assert"
   for corrections. But to change a status from a date on (prospect → active), retracting the open
   assertion erases its past. You must retract and re-assert it with a `validTo`. *Wish:* "To end a
   fact at time T without rewriting its past, retract it and re-assert the same value with
   `validTo: T` in the same transaction."
5. **No public way to read an assertion's valid interval in Datalog** (Q3 needs it). Workaround:
   two-basis difference, or `match` + `Triple.validTo` (an `Option`). *Wish:* "Datalog can't bind
   `validFrom`/`validTo`; compare visibility at two `validAt`s, or read them from `match`."
6. **`EntityState` precondition exists only in `.d.ts`.** operational-primitives.md says only
   `TripleLive` exists and "there is no generic public 'assert when no value exists' precondition".
   `TransactionMeta.preconditions` also accepts `{ _tag: "EntityState", entityId, tripleIds }`.
   *Wish:* document it as the check-then-write guard primitive.
7. **Recorded time can't be set**, so historical loads can't say "we learned this in March".
   Recorded-time travel can only be tested with wall-clock instants captured during the test
   (I used `Date.now()` + 5 ms sleeps). *Wish:* "Recorded time is the commit clock and can't be
   backdated. Model 'when we learned it' as data if you need to import history."
8. **Value types:** `Attribute.date` is a `string` (so `<`/`>` don't work on it), and the docs list
   `date` and `instant` without saying which to compare. *Wish:* "Use `instant` for anything you
   compare or expire; `date` is a calendar string."
9. **Retract op shape** (`{ op: "retract", id }`) and `Triple` field shapes (`validTo: Option`,
   `validFrom: number`, `value` union incl. `sealed`) are only discoverable from types.
10. CLI help says "**Splunk** configuration objects…" (typo for "Inspect"?), and every CLI run prints
   `ExperimentalWarning: SQLite is an experimental feature` unless you pass `--disable-warning`. I did
   not use the CLI further; the API was enough.
11. Stack traces point into `packages/core/src/...` through source maps. This is harmless, but an outside
    author debugging an error is drawn to the forbidden source.

### Files read

**Phase 1** (user-facing docs, help output, and published types):
- `README.md`. It is the entry point.
- `docs/getting-started.md`, `docs/agents.md`, `docs/troubleshooting.md`, `docs/datalog.md`. All four are linked in
  the README documentation table.
- `docs/concepts.md`: only the section "Recorded time and valid time", via grep.
- `docs/operational-primitives.md`: only the "precondition" sections, via grep.
- `docs/snippets/home/site-safety/app.ts`. agents.md embeds it with `<<<`, so it is part of the rendered page.
- `docs/snippets/tsconfig.json`. The README run command passes it.
- `packages/core/package.json` (`exports` field only), to locate the published entry points.
- Published `.d.ts` files: `packages/core/dist/store/Triples.d.ts`, `dist/Triple.d.ts`,
  `dist/config/Attribute.d.ts`, `dist/config/EntityType.d.ts`.
- `node packages/cli/dist/cli.js --help`.
- Disclosure: the harness auto-loaded the repo's contributor `AGENTS.md` into context. It contains no API detail I used.

**Phase 2:** none opened. **Forbidden:** none opened. Stack traces showed `src` paths, and I did not follow them.

## Silent traps

1. **Provenance join + past `validAt` → `[]`.** `["?r", attr, v, "?tx"], ["?tx", ":_tx/actor", "?a"]`
   with `basis: { validAt: <past> }` returns nothing, even though the review was valid then. `_tx`
   facts are valid only from commit time. Fix: resolve `?tx` provenance in a second query at the current basis.
2. **`handle.assertion(v, { validFrom, validTo })` drops `validTo`** when the options object isn't an
   inline literal, because TypeScript's excess-property check only fires on literals. The review then never
   expires. This is caught only by a test reading `Triple.validTo`.
3. **Typo'd attribute → `[]`.** `":vendor/staus"` returns an empty result with no warning, even with a
   committed release that knows every attribute. A compliance query that returns "no violations"
   is indistinguishable from a typo.
4. **Missing ≠ false.** Without `enforce`, a vendor lacking `:vendor/touches-customer-data` is
   invisible to Q1, so it is never flagged. Only `enforce` + `required` prevents this. The pin
   (`configSnapshot`) alone does not.
5. **Cardinality only exists under `enforce`.** With enforce, a second `status` is rejected. Without
   it, gamma becomes both `active` and `offboarded`, and Q2 still reports it as active.
6. **Expiry is silent by design.** An active vendor becomes non-compliant when valid time passes, and
   no write or error occurs. Any write guard is insufficient; you must schedule Q2 (or a
   `Derivation` + `nextTemporalBoundary`, which I did not try).
7. **Default `validFrom` = commit time.** Facts written without `validFrom` don't exist "earlier" in
   valid time. This interacts with trap 1 and finding 1.
8. **Same-millisecond recorded time** (troubleshooting.md warns about it). The probe did not reproduce
   (`same: false`), so the test only asserts when it happens.

## Draft GETTING-STARTED / AUTHORING outline

1. **Install & import.** npm path; source-checkout path: build with turbo and link packages into your
   project (not the `src`-mapped snippet tsconfig). One `effect` copy.
2. **Model.** EntityType/Attribute; value-type table with *comparable?* column (`instant` yes, `date`
   no); `.attributes.x.assertion(v)` returns `{attribute, value, validFrom?}`; spread `validFrom` and
   `validTo` onto the op.
3. **Time, first.** Valid vs recorded. Default `validFrom` = commit time. Give all of an entity's facts
   one interval. Referenced entities must be valid earlier. Changing state from T: retract + re-assert with
   `validTo: T` + assert the new value. Recorded time can't be backdated.
4. **Write.** One command = one transact; actor/commandId; `configSnapshot` + `enforce`; reading
   `ConstraintViolationError.violations` (with `validAt`).
5. **Query.** Clause shapes incl. 4-element tx binding; `not` with several clauses; `or` single-clause
   branches; typo'd attributes return `[]`, so validate keys against your model constants; provenance
   joins and valid time.
6. **Rules that aren't constraints.** Detection query + host guard + `EntityState` precondition +
   scheduled re-check (or Derivation + `nextTemporalBoundary`). Worked example: "no X active while Y expired".
7. **Expiry questions.** "Expiring within N days" = two-basis difference or `match` + `validTo`.
8. **Audit.** `transactionsForEntity`, `transactionByCommand`, recordedAt+validAt together.
9. **Troubleshooting index** keyed by the exact error strings above.
