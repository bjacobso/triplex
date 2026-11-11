import { describe, expect, it } from "vitest";
import { SqlError, SerializationError, DeadlockError, SqlSyntaxError } from "effect/sql/SqlError";
import { TransactionConflictError, WriteError } from "@triplex-build/triplex";
import { transactionConflict } from "../src/TransactionConflict.js";

describe("Postgres transaction conflicts", () => {
  it.each([
    [new SerializationError({ cause: { code: "40001" } }), "serialization"],
    [new DeadlockError({ cause: { code: "40P01" } }), "deadlock"],
  ] as const)(
    "classifies structured %s failures through arbitrary wrapper depth",
    (reason, kind) => {
      let error: unknown = new SqlError({ reason });
      for (let depth = 0; depth < 12; depth++)
        error = new WriteError({ message: "wrapped", cause: error });
      const conflict = transactionConflict(error);
      expect(conflict).toBeInstanceOf(TransactionConflictError);
      expect(conflict).toMatchObject({ reason: kind, isRetryable: true, cause: error });
      expect(conflict).not.toBeInstanceOf(WriteError);
    },
  );

  it("does not infer conflicts from message text or raw unclassified codes", () => {
    expect(transactionConflict(new Error("40001 serialization failure"))).toBeUndefined();
    expect(transactionConflict({ code: "40001" })).toBeUndefined();
    expect(
      transactionConflict(
        new SqlError({ reason: new SqlSyntaxError({ cause: { code: "42601" } }) }),
      ),
    ).toBeUndefined();
  });

  it("terminates on cyclic causes and preserves existing conflicts", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(transactionConflict(cyclic)).toBeUndefined();
    const conflict = new TransactionConflictError({ message: "stale entity" });
    expect(transactionConflict(conflict)).toBe(conflict);
    expect(conflict.isRetryable).toBe(true);
  });
});
