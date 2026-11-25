import { Context } from "effect";

export interface SqlDialect {
  readonly name: "sqlite" | "postgresql" | "mysql" | "duckdb";
  readonly limitOffset: (limit: number | undefined, offset: number | undefined) => string;
  readonly castAsText: (expression: string) => string;
  readonly booleanLiteral: (value: boolean) => string;
  readonly paramPlaceholder: (index: number) => string;
  readonly escapeLikePattern: (value: string) => string;
}

export class CurrentDialect extends Context.Service<CurrentDialect, SqlDialect>()(
  "CurrentDialect",
) {}
