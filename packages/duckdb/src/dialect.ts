import type { SqlDialect } from "@bjacobso/triplex/internal";

export const DuckdbDialect: SqlDialect = {
  name: "duckdb",
  limitOffset: (limit, offset) =>
    [
      ...(limit === undefined ? [] : [`LIMIT ${limit}`]),
      ...(offset === undefined || offset === 0 ? [] : [`OFFSET ${offset}`]),
    ].join(" "),
  castAsText: (expression) => `CAST(${expression} AS VARCHAR)`,
  booleanLiteral: (value) => (value ? "TRUE" : "FALSE"),
  paramPlaceholder: (index) => `$${index + 1}`,
  escapeLikePattern: (value) => value.replace(/[%_\\]/g, "\\$&"),
};
