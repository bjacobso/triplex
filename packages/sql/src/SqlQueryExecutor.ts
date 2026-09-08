/**
 * SqlQueryExecutor - SQL-based implementation of QueryExecutor
 *
 * Compiles Datalog queries to SQL and executes them via SqlClient.
 * This is the default executor for SQL backends (SQLite, PostgreSQL).
 *
 * Non-SQL backends (e.g., FoundationDB via kv-store) implement
 * QueryExecutor directly using index scans.
 */

import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  QueryExecutor,
  type QueryExecutorService,
  type QueryContext,
  type QueryExecutorMetrics,
  CurrentDialect,
  ReadError,
  DatalogValidationError,
  UnboundVariableError,
  compile,
  compileWithRules,
  compileWrapped,
  type CompiledQuery,
  type CompiledWrappedQuery,
  SqliteDialect,
} from "@bjacobso/triplex/internal";

// =============================================================================
// Result Row Type
// =============================================================================

type ResultRow = Record<string, unknown>;
type CompiledValueColumns =
  CompiledQuery["valueColumnMap"] extends Map<string, infer Columns> ? Columns : never;

const compilationFailure = (error: unknown, message: string) =>
  error instanceof DatalogValidationError || error instanceof UnboundVariableError
    ? error
    : new ReadError({ message: `${message}: ${String(error)}`, cause: error });

// =============================================================================
// Result Conversion
// =============================================================================

const toNumber = (value: unknown): number | null => {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    return Number.isNaN(number) ? null : number;
  }
  return null;
};

const decodeProjectedValue = (
  row: ResultRow,
  columns: CompiledValueColumns,
): QueryContext[string] => {
  const type = row[columns.type];
  switch (type) {
    case "string": {
      const value = row[columns.string];
      return value === null || value === undefined ? null : String(value);
    }
    case "number":
      return toNumber(row[columns.number]);
    case "boolean": {
      const value = row[columns.boolean];
      return value === true || value === 1 || value === 1n || value === "1";
    }
    default:
      return null;
  }
};

const rowToContext = (
  row: ResultRow,
  columnMap: Map<string, string>,
  valueColumnMap: Map<string, CompiledValueColumns>,
  numericColumns: Set<string>,
  constantColumns: Map<string, string | number | boolean>,
): QueryContext => {
  const context: Record<string, string | number | boolean | null> = {};

  for (const [colName, varName] of columnMap) {
    if (constantColumns.has(colName)) {
      context[varName] = constantColumns.get(colName)!;
      continue;
    }
    const valueColumns = valueColumnMap.get(colName);
    if (valueColumns) {
      context[varName] = decodeProjectedValue(row, valueColumns);
      continue;
    }

    const value = row[colName];

    if (value === null || value === undefined) {
      context[varName] = null;
      continue;
    }

    if (numericColumns.has(colName)) {
      context[varName] = toNumber(value);
    } else if (typeof value === "string") {
      context[varName] = value;
    } else if (typeof value === "number") {
      context[varName] = value;
    } else if (typeof value === "boolean") {
      context[varName] = value;
    } else if (typeof value === "bigint") {
      context[varName] = Number(value);
    } else {
      context[varName] = String(value);
    }
  }

  return context;
};

// =============================================================================
// Query Plan Builder
// =============================================================================

interface QueryPlan {
  readonly backend: string;
  readonly steps: ReadonlyArray<{
    readonly label: string;
    readonly query: string;
    readonly params?: readonly unknown[];
  }>;
}

interface QueryDebugInfo {
  readonly metrics: QueryExecutorMetrics;
  readonly executionTimeMs: number;
  readonly resultCount: number;
  readonly queryPlan?: QueryPlan;
  readonly generatedSql?: string;
  readonly params?: readonly unknown[];
}

type QueryResult = readonly QueryContext[];

const buildQueryPlan = (
  dialectName: string,
  mainSql: string,
  mainParams: readonly unknown[],
  countSql?: string | null,
  countParams?: readonly unknown[],
): QueryPlan => {
  const steps: Array<{ label: string; query: string; params?: readonly unknown[] }> = [
    { label: "main", query: mainSql, params: [...mainParams] },
  ];
  if (countSql) {
    steps.push({ label: "count", query: countSql, params: countParams ? [...countParams] : [] });
  }
  return { backend: dialectName, steps };
};

// =============================================================================
// Layer Implementation
// =============================================================================

/**
 * SQL-based QueryExecutor implementation.
 * Compiles Datalog -> SQL and executes via SqlClient.
 */
export const SqlQueryExecutorLive = Layer.effect(
  QueryExecutor,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Resolve dialect from context (optional -- defaults to SQLite)
    const dialectOpt = yield* Effect.serviceOption(CurrentDialect);
    const dialect = dialectOpt._tag === "Some" ? dialectOpt.value : SqliteDialect;

    const execute: QueryExecutorService["execute"] = (q, debug = false, basis) =>
      Effect.gen(function* () {
        // 1. Compile to SQL. Recursive rules go through the CTE compiler.
        let compiled: CompiledQuery;
        try {
          compiled = q.rules?.length
            ? compileWithRules(q, dialect, debug, basis === undefined ? {} : { basis })
            : compile(q, dialect, debug, basis === undefined ? {} : { basis });
        } catch (error) {
          return yield* Effect.fail(compilationFailure(error, "Failed to compile Datalog query"));
        }

        // 2. Execute SQL
        const execStart = performance.now();
        const rows = yield* sql.unsafe<ResultRow>(compiled.sql, compiled.params).pipe(
          Effect.mapError(
            (error) =>
              new ReadError({
                message: `Failed to execute Datalog query SQL: ${String(error)}`,
                cause: error,
              }),
          ),
        );
        const execTime = performance.now() - execStart;

        // 3. Convert rows to QueryContext objects
        const results: QueryContext[] = rows.map((row) =>
          rowToContext(
            row,
            compiled.columnMap,
            compiled.valueColumnMap,
            compiled.numericColumns,
            compiled.constantColumns,
          ),
        );

        // 4. Return with optional debug info
        if (debug && compiled.metrics) {
          const debugInfo: QueryDebugInfo = {
            metrics: compiled.metrics as QueryExecutorMetrics,
            executionTimeMs: execTime,
            resultCount: results.length,
            generatedSql: compiled.sql,
            params: compiled.params,
            queryPlan: buildQueryPlan(dialect.name, compiled.sql, compiled.params),
          };
          return { results: results as QueryResult, debug: debugInfo };
        }

        return { results: results as QueryResult };
      });

    const executePage: QueryExecutorService["executePage"] = (
      q,
      debug = false,
      basis,
      cursorValues,
    ) =>
      Effect.gen(function* () {
        // 1. Compile to SQL with CTE wrapper
        let compiled: CompiledWrappedQuery;
        try {
          compiled = compileWrapped(q, dialect, {
            ...(basis === undefined ? {} : { basis }),
            ...(cursorValues === undefined ? {} : { cursorValues }),
          });
        } catch (error) {
          return yield* Effect.fail(compilationFailure(error, "Failed to compile wrapped query"));
        }

        // 2. Execute main query
        const execStart = performance.now();
        const rows = yield* sql.unsafe<ResultRow>(compiled.sql, [...compiled.params]).pipe(
          Effect.mapError(
            (error) =>
              new ReadError({
                message: `Failed to execute wrapped query SQL: ${String(error)}`,
                cause: error,
              }),
          ),
        );
        const execTime = performance.now() - execStart;

        // 3. Execute count query if requested
        let totalCount: number | undefined;
        let countExecutionTimeMs: number | undefined;
        if (compiled.countSql) {
          const countStart = performance.now();
          const countRows = yield* sql
            .unsafe<{ total: number }>(compiled.countSql, [...compiled.countParams])
            .pipe(
              Effect.mapError(
                (error) =>
                  new ReadError({
                    message: `Failed to execute count query SQL: ${String(error)}`,
                    cause: error,
                  }),
              ),
            );
          // PostgreSQL returns COUNT(*) as int8 text while SQLite returns a
          // number. Keep the public result identical across both backends.
          totalCount = toNumber(countRows[0]?.total) ?? 0;
          countExecutionTimeMs = performance.now() - countStart;
        }

        // 4. Convert rows to QueryContext objects
        const results: QueryContext[] = rows.map((row) =>
          rowToContext(
            row,
            compiled.columnMap,
            compiled.valueColumnMap,
            compiled.numericColumns,
            compiled.constantColumns,
          ),
        );

        // 5. Build result. The Triples boundary owns the opaque cursor envelope.
        const debugInfo: QueryDebugInfo | undefined = debug
          ? {
              metrics: compiled.metrics,
              executionTimeMs: execTime + (countExecutionTimeMs ?? 0),
              ...(countExecutionTimeMs === undefined ? {} : { countExecutionTimeMs }),
              resultCount: results.length,
              generatedSql: compiled.sql,
              params: [...compiled.params],
              queryPlan: buildQueryPlan(
                dialect.name,
                compiled.sql,
                compiled.params,
                compiled.countSql,
                compiled.countParams,
              ),
            }
          : undefined;

        return {
          results: results as QueryResult,
          ...(totalCount !== undefined && { totalCount }),
          ...(debugInfo !== undefined && { debug: debugInfo }),
        };
      });

    const explain: QueryExecutorService["explain"] = (q) =>
      Effect.gen(function* () {
        let compiled: CompiledQuery;
        try {
          compiled = q.rules?.length
            ? compileWithRules(q, dialect, true)
            : compile(q, dialect, true);
        } catch (error) {
          return yield* Effect.fail(compilationFailure(error, "Failed to compile Datalog query"));
        }

        return {
          queryPlan: buildQueryPlan(dialect.name, compiled.sql, compiled.params),
          ...(compiled.metrics && { metrics: compiled.metrics as QueryExecutorMetrics }),
        };
      });

    const explainPage: QueryExecutorService["explainPage"] = (q) =>
      Effect.gen(function* () {
        let compiled: CompiledWrappedQuery;
        try {
          compiled = compileWrapped(q, dialect);
        } catch (error) {
          return yield* Effect.fail(compilationFailure(error, "Failed to compile wrapped query"));
        }

        return {
          queryPlan: buildQueryPlan(
            dialect.name,
            compiled.sql,
            compiled.params,
            compiled.countSql,
            compiled.countParams,
          ),
        };
      });

    return {
      execute,
      executePage,
      explain,
      explainPage,
    } satisfies QueryExecutorService;
  }),
);
