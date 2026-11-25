import type { SqlDialect } from "./types.js";

/**
 * DuckDB dialect for datalog compilation.
 *
 * Key differences from SQLite:
 * - No LIMIT required for OFFSET-only queries
 * - Native TRUE/FALSE boolean literals
 * - $1, $2, ... parameter placeholders (1-indexed)
 * - Native ILIKE / NOT ILIKE support
 */
export const DuckDbDialect: SqlDialect = {
  name: "duckdb",
  limitOffset: (limit, offset) => {
    const parts: string[] = [];
    if (limit !== undefined) parts.push(`LIMIT ${limit}`);
    if (offset !== undefined && offset > 0) parts.push(`OFFSET ${offset}`);
    return parts.join(" ");
  },
  castAsText: (expression) => `CAST(${expression} AS TEXT)`,
  booleanLiteral: (value) => (value ? "TRUE" : "FALSE"),
  paramPlaceholder: (index) => `$${index + 1}`,
  escapeLikePattern: (value) => value.replace(/[%_\\]/g, "\\$&"),
};
