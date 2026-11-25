/**
 * @triplex-build/triplex-duckdb
 *
 * DuckDB Datalog query execution, cold Parquet compaction, and tiered routing
 * for Triplex.
 */

export { DuckDbDialect } from "@triplex-internal/core/internal";
export {
  makeDuckDbQueryExecutor,
  makeDuckDbQueryExecutorLayer,
  makeDuckDbStatementRunner,
  openDuckDbConnection,
  type DuckDbHandle,
  type DuckDbStatementRunner,
} from "./DuckDbQueryExecutor.js";
export * from "./compaction/index.js";
export * from "./tiered/index.js";
