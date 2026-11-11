import { Effect } from "effect";
import type { TransactionMeta } from "./Triples.js";
import type { TripleValue } from "../Value.js";
import { ReadError, WriteError, TransactionConflictError } from "../errors/index.js";
import * as CanonicalJson from "../content/CanonicalJson.js";

const identity = (value: TripleValue) =>
  value.type === "sealed" && value.blind !== undefined
    ? CanonicalJson.encodeOrThrow(["sealed", value.valueType, value.blind])
    : CanonicalJson.encodeOrThrow(value as unknown as CanonicalJson.CanonicalValue);

/** All guards observe the same pre-state, inside the existing serialized write boundary. */
export const checkCheapPreconditions = (
  meta: TransactionMeta | undefined,
  load: (
    entityId: string,
    attribute: string | undefined,
    limit: 1 | 2,
  ) => Effect.Effect<readonly TripleValue[], ReadError>,
) =>
  Effect.gen(function* () {
    for (const condition of meta?.preconditions ?? []) {
      if (
        condition._tag !== "AttributeValue" &&
        condition._tag !== "AttributeAbsent" &&
        condition._tag !== "EntityAbsent"
      )
        continue;
      const values = yield* load(
        condition.entityId,
        condition._tag === "EntityAbsent" ? undefined : condition.attribute,
        condition._tag === "AttributeValue" ? 2 : 1,
      );
      const matches =
        condition._tag === "AttributeValue"
          ? values.length === 1 &&
            (yield* Effect.try({
              try: () => identity(values[0]!) === identity(condition.value),
              catch: (cause) =>
                new WriteError({ message: "Invalid attribute-value precondition", cause }),
            }))
          : values.length === 0;
      if (!matches)
        return yield* new TransactionConflictError({
          entityId: condition.entityId,
          message:
            condition._tag === "AttributeValue"
              ? "Expected exactly one live fact with the supplied attribute value"
              : "Expected no live facts in the guarded entity or attribute",
        });
    }
  });
