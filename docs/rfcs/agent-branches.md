# RFC: copy-on-write writable branches for speculative agent workflows

Status: **proposed; owner decisions required; no implementation**. This RFC changes no package
source or public exports.

## 1. Problem and motivation

Autonomous agents frequently perform **multi-step speculative work**: planning a remediation across
dozens of entities, running simulated tool calls, checking whether graph constraints and
derivations stabilize, or exploring competing hypotheses in parallel before asking a human (or
verifier agent) to approve and apply the changes.

Triplex already has two partial building blocks:

- `transaction preview` — previews a single atomic command without committing.
- `Derivation.Overlay` (`packages/core/src/derivation/Overlay.ts`)
  — evaluates temporary assertions/retractions for one read-only derivation run by copying fixed
  attributes into a fresh in-memory KV store.

Neither supports **multi-transaction, writable, isolated branches** over a database with millions
of entities:

- Copying attributes into an in-memory KV store does not scale to millions of entities.
- `transaction preview` cannot span multiple agent turns, tool calls, or subagent handoffs.

## 2. Recommendation

Introduce **O(1) copy-on-write writable branches** forked at an exact `basePosition`
(`recorded_position`), exposed as a standard `Triples` (and `Database`) layer so existing Datalog,
graph constraints, commit validators, `why`, derivations, CLI, and MCP tools work unchanged inside
a branch.

All TypeScript snippets below are proposed contract fragments (ordinary `ts` fences).

## 3. Lifecycle and API sketch

```ts
export interface BranchHandle {
  readonly branchId: BranchId;
  readonly basePosition: number;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly actor: string;
  readonly status: "open" | "merged" | "discarded" | "expired";
}

export interface BranchService {
  readonly create: (options: {
    readonly actor: string;
    readonly basePosition?: number; // defaults to currentPosition()
    readonly ttlMs?: number;
    readonly label?: string;
  }) => Effect.Effect<BranchHandle, WriteError>;

  /** Provide a Triples layer scoped to this branch (reads basePosition + branch deltas). */
  readonly layer: (branchId: BranchId) => Layer.Layer<Triples, BranchError>;

  /** Compute exact net assertions, retractions, and conflicts against current head (or base). */
  readonly diff: (
    branchId: BranchId,
    options?: { readonly against?: "base" | "head" },
  ) => Effect.Effect<BranchDiff, BranchError>;

  /** Atomically apply net branch changes onto main with optimistic concurrency checks. */
  readonly merge: (
    branchId: BranchId,
    options: {
      readonly actor: string;
      readonly commandId: string;
      readonly strategy?: "fail-on-conflict" | "squash-atomic";
    },
  ) => Effect.Effect<TransactionResult, BranchMergeError>;

  readonly discard: (branchId: BranchId) => Effect.Effect<void, BranchError>;
}
```

## 4. Storage model (O(1) fork, delta-only writes)

Forking never copies rows from `triples`. A branch stores only its **metadata** and **delta
mutations**:

1. `triplex_branches(branch_id, base_position, created_at, expires_at, actor, label, status,
merged_tx_id, merged_at)`
2. `triplex_branch_triples`: same schema as `triples` plus `branch_id TEXT NOT NULL`, holding only
   facts asserted inside the branch (with branch-local monotonic `recorded_position > base_position`).
3. `triplex_branch_retractions(branch_id, triple_id, retracted_at, retracted_position,
retract_tx_id)`: records retractions of **base** facts (facts with `recorded_position <=
base_position` in `triples`). Retracting a branch-asserted fact updates its row in
   `triplex_branch_triples` directly.
4. `triplex_branch_transactions` / `triplex_branch_transaction_entities`: branch-local journal so
   `why`, `transactions`, `commandId` idempotency, and `entityHistory` work inside the branch
   without polluting the main journal or advancing main's `triplex_commit_position`.

### Memory and cold-tier interaction

- Because a branch pins `base_position`, any cold-tier compaction watermark
  ([cold-tier-duckdb.md](cold-tier-duckdb.md)) must either stay below active open branches'
  `base_position` (for fast hot-only branch reads) or allow branched reads to federate with cold
  Parquet when a long-lived branch falls behind `W`.
- `expires_at` enables automatic garbage collection of abandoned agent branches (e.g., default TTL
  of 24 hours for ephemeral agent runs).

## 5. Query and read semantics inside a branch

For a branch forked at `base_position = B`, the logical fact relation at branch position `P` is:

```sql
-- Conceptual branched view (compiled by BranchedQueryExecutor)
SELECT t.* FROM triples t
WHERE t.recorded_position <= $base_position
  AND (t.retracted_position IS NULL OR t.retracted_position > $base_position)
  AND NOT EXISTS (
    SELECT 1 FROM triplex_branch_retractions r
    WHERE r.branch_id = $branch_id
      AND r.triple_id = t.id
      AND r.retracted_position <= $branch_cut
  )
UNION ALL
SELECT bt.* FROM triplex_branch_triples bt
WHERE bt.branch_id = $branch_id
  AND bt.recorded_position <= $branch_cut
  AND (bt.retracted_position IS NULL OR bt.retracted_position > $branch_cut)
```

- **No double-cost when no branch is active**: Ordinary main-line queries never touch
  `triplex_branch_*` tables.
- **SQL & KV parity**: On SQLite/PostgreSQL/DuckDB, `BranchedQueryExecutor` rewrites the compiled
  `triples` table reference to a CTE over `triples` + branch deltas. On KV, `BranchedKvBackend`
  overlays a branch-local ordered map over a base snapshot cut.
- **Constraints and commit validators**: Run identically inside the branch against the branched
  `before`/`after` views, so agents get real constraint and policy feedback on every speculative
  step.

## 6. Diffing, conflict detection, and atomic merge

When an agent calls `branch.merge(branchId, { actor, commandId })`:

1. **Compute net operations**:
   - Retract every base `triple_id` present in `triplex_branch_retractions` (still live in base).
   - Assert every still-live fact in `triplex_branch_triples` (skipping facts asserted and later
     retracted within the same branch).
2. **Generate automatic preconditions**:
   - Every base `triple_id` retracted in the branch becomes a `TripleLive` precondition.
   - Every entity whose state was read (`tx.get`) or mutated in the branch can carry an
     `EntityState` precondition (or attribute-level check) verifying that no concurrent main-line
     commit mutated those entities between `basePosition` and current head.
3. **Commit atomically to main**:
   - Submit the net operations, preconditions, pinned `configSnapshot`, `enforce` constraints, and
     runtime-wide `CommitValidation` validators as **one atomic `Triples.transact`** on main.
   - Record branch provenance in transaction metadata (e.g., `correlationId` / `causationId` or a
     dedicated branch-merge reference) so `why` can trace merged facts back to the agent branch.
   - Atomically mark the branch row `status = 'merged'` and `merged_tx_id = result.txId`.
4. **Conflict handling**:
   - If main moved in a conflicting way, `merge` fails with a typed `BranchConflictError` detailing
     the conflicting entities/triple IDs, leaving the branch open so the agent can inspect
     `branch.diff({ against: "head" })`, rebase/repair, or discard.

## 7. MCP and CLI surface

Add first-class tools to `@triplex-build/triplex/mcp` and `triplex` CLI:

- `branch_create`, `branch_list`, `branch_diff`, `branch_merge`, `branch_discard`
- Optional `branchId` parameter on `entity_get`, `query_run`, `why`, `transaction_preview`, and
  `transaction_apply`.

This gives coding and operational agents a clean **"fork → experiment → verify → review diff →
merge"** loop out of the box.

## 8. Open questions & decision gates

1. **Nested branches (branch-from-branch)**: Defer in v1; require branches to fork from a main
   `recorded_position` to keep query compilation to a single delta overlay.
2. **Merge granularity**: Should v1 support only **squash-atomic merge** (one main transaction with
   net changes) or also **replay merge** (preserving individual branch commits in the main journal)?
   Recommend squash-atomic first for simplicity and atomic constraint enforcement.
3. **Read-set tracking for optimistic merge**: Decide whether `merge` checks conflicts only on
   _written/retracted_ entities (fast, lower false conflicts) or also on _read_ entities (stricter
   serializability, requires recording read sets during branch execution).
