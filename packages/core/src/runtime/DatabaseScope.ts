import { Schema } from "effect";

const ScopeSchema = Schema.String.pipe(Schema.brand("DatabaseScope"));

/** Opaque cursor identity. Construct through `make` or `test`, never from request input. */
export type DatabaseScope = typeof ScopeSchema.Type;

export interface DatabaseIdentity {
  readonly env: string;
  readonly tenant: string;
  readonly database: string;
  readonly generation: number;
}

const nonempty = (value: string, field: string) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`DatabaseScope.${field} must be a nonempty string`);
  }
};

const make = ({ env, tenant, database, generation }: DatabaseIdentity): DatabaseScope => {
  nonempty(env, "env");
  nonempty(tenant, "tenant");
  nonempty(database, "database");
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError("DatabaseScope.generation must be a nonnegative safe integer");
  }
  // A versioned tuple avoids delimiter collisions and object property-order ambiguity.
  return Schema.decodeSync(ScopeSchema)(
    JSON.stringify(["triplex-scope-v1", env, tenant, database, generation]),
  );
};

export const DatabaseScope = {
  make,
  /** Repeatable identity for an isolated test fixture; not globally unique. */
  test: (name: string): DatabaseScope =>
    make({ env: "test", tenant: "test", database: name, generation: 0 }),
} as const;

/** Validate JavaScript callers too; a TypeScript cast must not restore a default scope. */
export const validateDatabaseScope = (scope: DatabaseScope): void => {
  let value: unknown;
  try {
    value = JSON.parse(scope);
  } catch {
    throw new TypeError("Invalid DatabaseScope");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    value[0] !== "triplex-scope-v1" ||
    typeof value[1] !== "string" ||
    typeof value[2] !== "string" ||
    typeof value[3] !== "string" ||
    typeof value[4] !== "number" ||
    make({ env: value[1], tenant: value[2], database: value[3], generation: value[4] }) !== scope
  ) {
    throw new TypeError("Invalid DatabaseScope");
  }
};
