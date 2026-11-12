import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";
import { TransactionConflictError } from "@triplex-internal/core";

/** Normalize structured SQL reasons, retaining the original failure for diagnostics. */
export const transactionConflict = (cause: unknown): TransactionConflictError | undefined => {
  if (cause instanceof TransactionConflictError) return cause;
  const seen = new Set<object>();
  let current = cause;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if (isSqlError(current)) {
      const reason =
        current.reason._tag === "SerializationError"
          ? "serialization"
          : current.reason._tag === "DeadlockError"
            ? "deadlock"
            : undefined;
      if (reason !== undefined)
        return new TransactionConflictError({
          reason,
          cause,
          message: `PostgreSQL transaction ${reason} conflict; reload state and retry the entire outer transaction`,
        });
    }
    // Domain errors may wrap SQL failures. Do not invoke arbitrary cause getters
    // on unrelated caller errors, and do not infer retryability from message text.
    const descriptor = Object.getOwnPropertyDescriptor(current, "cause");
    current = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  }
  return undefined;
};

/** Include host statements and outer-commit failures in the same typed boundary. */
export const withPostgresqlTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql
      .withTransaction(effect)
      .pipe(Effect.mapError((error) => transactionConflict(error) ?? error));
  });
