/**
 * TieredQueryExecutor — watermark-aware routing between hot SQL and federated DuckDB.
 *
 * Implements §5 of `docs/rfcs/cold-tier-duckdb.md`:
 * - Live / recent cuts (`recordedPosition > W` or latest, without `:_tx/*` or variable
 *   attributes and without `recordedAt` predating the watermark) route 100% to hot SQL.
 * - Historical cuts (`recordedPosition <= W`), journal-scanning queries when `W > 0`,
 *   or analytical queries when `preferAnalyticalCold` is enabled route through the
 *   federated DuckDB `QueryExecutorService`.
 * - Opaque pagination cursors (`executePage`) pass through unchanged because both
 *   executors share the exact same canonical keyset ordering and scalar-family rules.
 */

import { Effect, Layer } from "effect";
import {
  QueryExecutor,
  isNotClause,
  isOrClause,
  isPatternClause,
  type Clause,
  type DatalogQuery,
  type PatternClause,
  type QueryExecutorService,
  type ReadError,
  type WrappedQuery,
} from "@triplex-internal/core/internal";

// =============================================================================
// Routing Policy & Decision Types
// =============================================================================

export type TierTarget = "hot" | "federated";

export type TierRoutingReason =
  | "no-cold-data"
  | "live-above-watermark"
  | "recent-above-watermark"
  | "historical-at-or-below-watermark"
  | "recorded-at-cut"
  | "journal-attributes"
  | "variable-attribute"
  | "prefer-analytical-cold";

export interface TierRoutingDecision {
  readonly target: TierTarget;
  readonly reason: TierRoutingReason;
  readonly watermark: number;
  readonly recordedPosition?: number;
  readonly recordedAt?: number;
}

export interface TierRoutingPolicy {
  /** Current durable compaction watermark `W` (0 when no cold segments exist). */
  readonly watermark: Effect.Effect<number, ReadError>;
  /**
   * Optional upper bound on `recorded_at` / `retracted_at` of compacted rows at or
   * below `W`. When provided, queries carrying `basis.recordedAt >= watermarkInstant`
   * alongside `recordedPosition > W` (including normal paginated `Triples.query` calls)
   * safely stay on the hot path.
   */
  readonly watermarkInstant?: Effect.Effect<number | undefined, ReadError>;
  /** Prefer routing analytical / Datalog queries through the federated DuckDB executor. */
  readonly preferAnalyticalCold?: boolean;
  /** Optional hook invoked with every routing decision (useful for metrics and tests). */
  readonly onRoute?: (decision: TierRoutingDecision) => void;
}

export interface QueryRoutingInspection {
  readonly readsJournal: boolean;
  readonly hasVariableAttribute: boolean;
}

// =============================================================================
// Query Inspection
// =============================================================================

const isIntervalPatternClause = (clause: unknown): clause is { readonly pattern: PatternClause } =>
  typeof clause === "object" && clause !== null && !Array.isArray(clause) && "pattern" in clause;

const inspectAttributeTerm = (
  term: unknown,
  acc: { readsJournal: boolean; hasVariableAttribute: boolean },
): void => {
  if (typeof term !== "string") return;
  if (term.startsWith("?")) {
    acc.hasVariableAttribute = true;
  } else if (term.startsWith(":_tx/")) {
    acc.readsJournal = true;
  }
};

const visitClause = (
  clause: Clause,
  acc: { readsJournal: boolean; hasVariableAttribute: boolean },
): void => {
  if (isNotClause(clause)) {
    for (let i = 1; i < clause.length; i++) {
      visitClause(clause[i] as Clause, acc);
    }
    return;
  }
  if (isOrClause(clause)) {
    const alternatives = clause[1];
    if (Array.isArray(alternatives)) {
      for (const alt of alternatives) {
        if (Array.isArray(alt) && alt.length > 0 && Array.isArray(alt[0])) {
          for (const inner of alt as unknown as readonly Clause[]) {
            visitClause(inner, acc);
          }
        } else {
          visitClause(alt as Clause, acc);
        }
      }
    }
    return;
  }
  if (isIntervalPatternClause(clause)) {
    inspectAttributeTerm(clause.pattern[1], acc);
    return;
  }
  if (isPatternClause(clause)) {
    inspectAttributeTerm(clause[1], acc);
  }
};

/** Inspect a Datalog query for `:_tx/*` or variable-attribute patterns that touch the journal. */
export const inspectDatalogQueryForRouting = (query: DatalogQuery): QueryRoutingInspection => {
  const acc = { readsJournal: false, hasVariableAttribute: false };
  for (const clause of query.where) {
    visitClause(clause, acc);
  }
  if (query.rules) {
    for (const rule of query.rules) {
      for (const clause of rule.body) {
        visitClause(clause as Clause, acc);
      }
    }
  }
  if (query.optionalProjection) {
    for (const field of query.optionalProjection.fields) {
      inspectAttributeTerm(field.attribute, acc);
    }
  }
  return acc;
};

// =============================================================================
// Pure Routing Decision
// =============================================================================

export interface TierRouteInput {
  readonly query: DatalogQuery;
  readonly watermark: number;
  readonly watermarkInstant?: number | undefined;
  readonly basis?: {
    readonly recordedPosition?: number | undefined;
    readonly recordedAt?: number | undefined;
  };
  readonly preferAnalyticalCold?: boolean | undefined;
}

/**
 * Pure routing function deciding whether a Datalog query can be served strictly
 * from hot SQL or must be routed through federated DuckDB (hot + cold Parquet).
 */
export const decideTierRoute = (input: TierRouteInput): TierRoutingDecision => {
  const { query, watermark, watermarkInstant, basis, preferAnalyticalCold } = input;
  const base = {
    watermark,
    ...(basis?.recordedPosition === undefined ? {} : { recordedPosition: basis.recordedPosition }),
    ...(basis?.recordedAt === undefined ? {} : { recordedAt: basis.recordedAt }),
  };

  if (preferAnalyticalCold) {
    return { target: "federated", reason: "prefer-analytical-cold", ...base };
  }

  // No cold segments have been published yet; hot holds 100% of facts and journal rows.
  if (watermark <= 0) {
    return { target: "hot", reason: "no-cold-data", ...base };
  }

  // Queries that read `:_tx/*` or scan variable attributes (which union `triplex_journal_facts`)
  // may reference compacted journal entries at position <= W even on a live cut.
  const inspection = inspectDatalogQueryForRouting(query);
  if (inspection.readsJournal) {
    return { target: "federated", reason: "journal-attributes", ...base };
  }
  if (inspection.hasVariableAttribute) {
    return { target: "federated", reason: "variable-attribute", ...base };
  }

  const recordedPosition = basis?.recordedPosition;
  const recordedAt = basis?.recordedAt;

  // Explicit historical position cut at or below watermark W must read federated hot + cold.
  if (recordedPosition !== undefined && recordedPosition <= watermark) {
    return { target: "federated", reason: "historical-at-or-below-watermark", ...base };
  }

  // If a `recordedAt` timestamp is present, facts retracted at `retracted_position <= W`
  // could still be visible if `retracted_at > recordedAt`. Only stay on hot if we know
  // `recordedAt >= watermarkInstant`.
  if (recordedAt !== undefined) {
    if (watermarkInstant === undefined || recordedAt < watermarkInstant) {
      return { target: "federated", reason: "recorded-at-cut", ...base };
    }
  }

  if (recordedPosition === undefined) {
    return { target: "hot", reason: "live-above-watermark", ...base };
  }

  return { target: "hot", reason: "recent-above-watermark", ...base };
};

// =============================================================================
// TieredQueryExecutor Construction
// =============================================================================

export interface TieredQueryExecutorOptions {
  readonly hot: QueryExecutorService;
  readonly federated: QueryExecutorService;
  readonly policy: TierRoutingPolicy;
}

/**
 * Construct a `QueryExecutorService` that routes live/recent cuts to `hot`
 * and historical / journal-spanning / analytical queries to `federated`.
 */
export const makeTieredQueryExecutor = (
  options: TieredQueryExecutorOptions,
): QueryExecutorService => {
  const { hot, federated, policy } = options;

  const resolveExecutor = (
    query: DatalogQuery,
    basis?: {
      readonly recordedPosition?: number | undefined;
      readonly recordedAt?: number | undefined;
    },
  ): Effect.Effect<QueryExecutorService, ReadError> =>
    Effect.gen(function* () {
      const watermark = yield* policy.watermark;
      const needsWatermarkInstant =
        policy.watermarkInstant !== undefined &&
        !policy.preferAnalyticalCold &&
        watermark > 0 &&
        basis?.recordedAt !== undefined;
      const watermarkInstant = needsWatermarkInstant ? yield* policy.watermarkInstant! : undefined;
      const decision = decideTierRoute({
        query,
        watermark,
        watermarkInstant,
        ...(basis === undefined ? {} : { basis }),
        preferAnalyticalCold: policy.preferAnalyticalCold,
      });
      policy.onRoute?.(decision);
      return decision.target === "hot" ? hot : federated;
    });

  const execute: QueryExecutorService["execute"] = (query, debug = false, basis) =>
    resolveExecutor(query, basis).pipe(
      Effect.flatMap((executor) => executor.execute(query, debug, basis)),
    );

  const executePage: QueryExecutorService["executePage"] = (
    query: WrappedQuery,
    debug = false,
    basis,
    cursorValues,
  ) =>
    resolveExecutor(query.inner, basis).pipe(
      Effect.flatMap((executor) => executor.executePage(query, debug, basis, cursorValues)),
    );

  const explain: QueryExecutorService["explain"] = (query) =>
    resolveExecutor(query).pipe(Effect.flatMap((executor) => executor.explain(query)));

  const explainPage: QueryExecutorService["explainPage"] = (query) =>
    resolveExecutor(query.inner).pipe(Effect.flatMap((executor) => executor.explainPage(query)));

  return {
    execute,
    executePage,
    explain,
    explainPage,
  } satisfies QueryExecutorService;
};

/** Layer constructor for `TieredQueryExecutor`. */
export const makeTieredQueryExecutorLayer = (options: TieredQueryExecutorOptions) =>
  Layer.succeed(QueryExecutor, makeTieredQueryExecutor(options));
