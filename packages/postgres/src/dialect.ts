import type { SqlDialect } from "@triplex-build/triplex/internal";

export const PostgresqlDialect: SqlDialect = {
  name: "postgresql",
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
