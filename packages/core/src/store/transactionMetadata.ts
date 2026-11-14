import type { TransactionMeta } from "./Triples.js";

export { transactionChangeFromTriple } from "./journal.js";

export const livePreconditionIds = (meta?: TransactionMeta): ReadonlySet<string> =>
  new Set(
    meta?.preconditions?.flatMap((condition) =>
      condition._tag === "TripleLive" ? [condition.id] : [],
    ) ?? [],
  );

export const entityStatePreconditions = (meta?: TransactionMeta) =>
  meta?.preconditions?.filter((condition) => condition._tag === "EntityState") ?? [];

export const invalidCommandId = (meta?: TransactionMeta): string | undefined => {
  const commandId = meta?.commandId;
  return commandId !== undefined && (commandId.length === 0 || commandId.length > 1_024)
    ? commandId
    : undefined;
};

export const validatePreconditions = (
  operations: readonly { readonly op: string; readonly id?: string }[],
  meta?: TransactionMeta,
): string | undefined => {
  const retractIds = new Set(
    operations.flatMap((operation) =>
      operation.op === "retract" && operation.id !== undefined ? [operation.id] : [],
    ),
  );
  const invalid = meta?.preconditions?.find(
    (condition) => condition._tag === "TripleLive" && !retractIds.has(condition.id),
  );
  return invalid?._tag === "TripleLive" ? invalid.id : undefined;
};
