/** Stable, transport-independent diagnostics. Only explicitly selected fields leave an error. */
import * as Errors from "./index.js";

export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly fix?: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

// Exhaustive over the public error module, including its re-exported manager errors.
const defaults = {
  WriteError: ["write.failed", "Check the write input and storage availability."],
  OperationalEntryConflictError: [
    "operational.entry-conflict",
    "Read the existing inbox or outbox entry for this idempotency key.",
  ],
  DuplicateTripleError: ["triple.duplicate", "Read the existing fact before asserting it again."],
  InvalidTripleError: ["triple.invalid", "Correct the named field and submit the fact again."],
  TransactionError: [
    "transaction.failed",
    "Inspect the transaction input and storage availability before resubmitting.",
  ],
  TransactionConflictError: [
    "transaction.conflict.precondition",
    "Reload current facts and retry the whole command.",
  ],
  CommandAlreadyCommittedError: [
    "transaction.command-already-committed",
    "Read the original receipt with `transactionByCommand`.",
  ],
  ConstraintViolationError: [
    "constraint.violation",
    "Correct the violated constraints and ensure all of an entity's facts share one valid-time interval.",
  ],
  ReadError: ["read.failed", "Check the read input and storage availability."],
  EntityNotFoundError: ["entity.not-found", "Check the entity ID and temporal basis."],
  TripleNotFoundError: ["triple.not-found", "Reload the entity and use a current fact ID."],
  QueryError: ["query.failed", "Check the query and storage availability."],
  InvalidPatternError: ["query.invalid-pattern", "Supply a valid triple match pattern."],
  ParseError: ["datalog.parse", "Correct the query syntax at the reported line and column."],
  UnexpectedTokenError: [
    "datalog.unexpected-token",
    "Replace the unexpected token with the expected token.",
  ],
  UndefinedVariableError: [
    "datalog.undefined-variable",
    "Define the variable before referencing it.",
  ],
  ValidationError: ["validation.failed", "Correct the named input field."],
  UnknownAttributeError: [
    "schema.unknown-attribute",
    "Use an attribute defined in the bound release.",
  ],
  DatalogError: ["datalog.failed", "Correct the Datalog query before submitting it again."],
  UnboundVariableError: [
    "datalog.unbound-variable",
    "Bind the variable in a positive pattern or rule application before using it.",
  ],
  InvalidPredicateError: [
    "datalog.invalid-predicate",
    "Use a supported predicate with bound operands and numeric ordered comparisons.",
  ],
  DatalogValidationError: [
    "datalog.invalid-shape",
    "Supply a query matching the Datalog query schema.",
  ],
  SensitiveQueryError: [
    "sensitive.query",
    "Use blind-index equality for sensitive values and open them explicitly with Sensitive.open.",
  ],
  SensitiveValueError: [
    "sensitive.value",
    "Check the sensitive attribute policy and codec key availability.",
  ],
  PaginationCursorError: [
    "pagination.invalid-cursor",
    "Restart pagination without a cursor using the intended query and database.",
  ],
  MigrationError: [
    "migration.failed",
    "Inspect the failed migration and repair its prerequisites before rerunning it.",
  ],
  DatabaseNotFound: [
    "database.not-found",
    "Use an existing database name or create the database first.",
  ],
  DatabaseAlreadyExists: [
    "database.already-exists",
    "Use the existing database or choose a different name.",
  ],
  InternalError: [
    "database.internal",
    "Inspect the database logs and resolve the underlying failure.",
  ],
} satisfies Record<keyof typeof Errors, readonly [string, string]>;

/** Diagnose a public Triplex error without copying queries, values, SQL or causes. */
export const diagnose = (error: unknown): Diagnostic => {
  if (!Object.values(Errors).some((ErrorClass) => error instanceof ErrorClass)) {
    return { code: "internal", message: "Unknown internal error", retryable: false };
  }
  const known = error as InstanceType<(typeof Errors)[keyof typeof Errors]>;
  const [code, fix] = defaults[known._tag];
  const base: Diagnostic = { code, message: known.message || known._tag, fix, retryable: false };
  if (known instanceof Errors.TransactionConflictError) {
    return {
      ...base,
      code: `transaction.conflict.${known.reason ?? "precondition"}`,
      retryable: true,
    };
  }
  if (known instanceof Errors.UnknownAttributeError) {
    return {
      ...base,
      path: known.path,
      fix:
        known.suggestion === undefined ? fix : `Use ${known.suggestion} instead of ${known.key}.`,
    };
  }
  if (known instanceof Errors.ConstraintViolationError) {
    return {
      ...base,
      ...(known.violations?.[0] === undefined ? {} : { path: known.violations[0].path }),
      details: {
        violations: (known.violations ?? []).map(({ constraintKey, subject, validAt }) => ({
          constraintKey,
          subject,
          validAt,
        })),
      },
    };
  }
  if (
    known instanceof Errors.DatalogValidationError ||
    known instanceof Errors.UnboundVariableError ||
    known instanceof Errors.InvalidPredicateError
  ) {
    return {
      ...base,
      code: known.code ?? code,
      ...(known.path === undefined ? {} : { path: known.path }),
      fix: known.fix ?? fix,
    };
  }
  if (known instanceof Errors.InvalidTripleError || known instanceof Errors.ValidationError)
    return { ...base, path: known.field };
  return base;
};
