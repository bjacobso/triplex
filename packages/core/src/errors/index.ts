/**
 * Database error types.
 *
 * All error types used by the database package live here.
 * Database-layer errors extracted from the old monolithic package layout
 * are now owned by the database package.
 */

import { Data } from "effect";
import type { ViolationAt } from "../Constraint.js";
import type { EntityId, TransactionId, TripleId } from "../Branded.js";

// Write operation errors
export class WriteError extends Data.TaggedError("WriteError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DuplicateTripleError extends Data.TaggedError("DuplicateTripleError")<{
  readonly entityId: EntityId;
  readonly attribute: string;
  readonly message: string;
}> {}

export class InvalidTripleError extends Data.TaggedError("InvalidTripleError")<{
  readonly field: string;
  readonly value: unknown;
  readonly message: string;
}> {}

export class TransactionError extends Data.TaggedError("TransactionError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A transaction's compare-and-retract condition no longer matched.
 *
 * This is a normal concurrency outcome, not storage corruption. Callers may
 * reload the current facts and retry their command.
 */
export class TransactionConflictError extends Data.TaggedError("TransactionConflictError")<{
  readonly tripleId?: TripleId;
  readonly entityId?: EntityId;
  readonly message: string;
}> {}

/**
 * A command with this idempotency identity already committed.
 *
 * The original transaction remains the durable receipt. Callers should return
 * or inspect that result rather than execute the command again.
 */
export class CommandAlreadyCommittedError extends Data.TaggedError("CommandAlreadyCommittedError")<{
  readonly commandId: string;
  readonly transactionId: TransactionId;
  readonly message: string;
}> {}

/** A transaction would introduce or worsen a configured graph constraint violation. */
export class ConstraintViolationError extends Data.TaggedError("ConstraintViolationError")<{
  readonly violations: readonly ViolationAt[];
  readonly message: string;
}> {}

// Read operation errors
export class ReadError extends Data.TaggedError("ReadError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class EntityNotFoundError extends Data.TaggedError("EntityNotFoundError")<{
  readonly entityId: EntityId;
}> {}

export class TripleNotFoundError extends Data.TaggedError("TripleNotFoundError")<{
  readonly tripleId: TripleId;
}> {}

// Query errors
export class QueryError extends Data.TaggedError("QueryError")<{
  readonly message: string;
  readonly sql?: string;
  readonly cause?: unknown;
}> {}

export class InvalidPatternError extends Data.TaggedError("InvalidPatternError")<{
  readonly pattern: unknown;
  readonly message: string;
}> {}

// Parse errors (Datalog)
export class ParseError extends Data.TaggedError("ParseError")<{
  readonly message: string;
  readonly line: number;
  readonly column: number;
  readonly source?: string;
}> {}

export class UnexpectedTokenError extends Data.TaggedError("UnexpectedTokenError")<{
  readonly expected: string;
  readonly found: string;
  readonly line: number;
  readonly column: number;
}> {}

export class UndefinedVariableError extends Data.TaggedError("UndefinedVariableError")<{
  readonly variable: string;
  readonly line: number;
}> {}

// Schema/validation errors
export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly field: string;
  readonly message: string;
  readonly value?: unknown;
}> {}

// Datalog query errors
export class DatalogError extends Data.TaggedError("DatalogError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class UnboundVariableError extends Data.TaggedError("UnboundVariableError")<{
  readonly variable: string;
  readonly clause: unknown;
  readonly message: string;
}> {}

export class InvalidPredicateError extends Data.TaggedError("InvalidPredicateError")<{
  readonly predicate: unknown;
  readonly message: string;
}> {}

export class DatalogValidationError extends Data.TaggedError("DatalogValidationError")<{
  readonly message: string;
  readonly query: unknown;
  readonly cause?: unknown;
}> {}

/**
 * A paged-query cursor could not be decoded or does not belong to the query,
 * temporal snapshot, or database scope in which it was presented.
 */
export class PaginationCursorError extends Data.TaggedError("PaginationCursorError")<{
  readonly reason:
    | "malformed"
    | "unsupported_version"
    | "query_mismatch"
    | "scope_mismatch"
    | "basis_mismatch"
    | "invalid_ordering";
  readonly message: string;
  readonly cause?: unknown;
}> {}

// Migration errors
export class MigrationError extends Data.TaggedError("MigrationError")<{
  readonly version: number;
  readonly name: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

// Re-export database manager errors from Error.ts.
export { DatabaseNotFound, DatabaseAlreadyExists, InternalError } from "../Error.js";

// Error unions for convenience
export type WriteErrorUnion =
  | WriteError
  | DuplicateTripleError
  | InvalidTripleError
  | TransactionError
  | TransactionConflictError
  | CommandAlreadyCommittedError
  | ConstraintViolationError;

export type ReadErrorUnion = ReadError | EntityNotFoundError | TripleNotFoundError;

export type QueryErrorUnion = QueryError | InvalidPatternError;

export type ParseErrorUnion = ParseError | UnexpectedTokenError | UndefinedVariableError;

export type DatalogQueryError =
  | DatalogError
  | UnboundVariableError
  | InvalidPredicateError
  | DatalogValidationError;

export type DatalogErrorUnion = DatalogQueryError | PaginationCursorError;

export type TripleStoreError =
  | WriteErrorUnion
  | ReadErrorUnion
  | QueryErrorUnion
  | ParseErrorUnion
  | DatalogErrorUnion
  | ValidationError
  | MigrationError;
