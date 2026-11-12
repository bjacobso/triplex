/** Shared CLI/MCP wire schema for stored and derivation subjects. */
import { DatalogQuery, EntityId, TripleId } from "@triplex-internal/core";
import { TypeExpr } from "@triplex-internal/core/config";
import { ContentId } from "@triplex-internal/core/content";
import type { WhySubject as Subject } from "@triplex-internal/core/why";
import { Schema } from "effect";

const Definition = Schema.Struct({
  name: Schema.String,
  query: DatalogQuery,
  identity: Schema.Array(Schema.String),
  output: Schema.Array(Schema.String),
  configSnapshot: Schema.String,
  resultType: Schema.optionalKey(TypeExpr.TypeExprSchema),
  dependencies: Schema.Struct({
    attributes: Schema.Array(Schema.String),
    entityTypes: Schema.Array(Schema.String),
    boundEntityIds: Schema.Array(Schema.String),
    hasDynamicAttributes: Schema.Boolean,
  }),
  id: ContentId.ContentIdSchema,
});
export const WhySubject: Schema.Codec<Subject, unknown> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("fact"), tripleId: TripleId }),
  Schema.Struct({
    kind: Schema.Literal("attribute"),
    entityId: EntityId,
    attribute: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("entity"), entityId: EntityId }),
  Schema.Struct({
    kind: Schema.Literal("candidate"),
    definition: Definition,
    candidateId: ContentId.ContentIdSchema,
    revision: ContentId.ContentIdSchema,
  }),
]);
export const WhyInput = Schema.Struct({
  subject: WhySubject,
  basis: Schema.optionalKey(
    Schema.Struct({
      validAt: Schema.optionalKey(Schema.Number),
      recordedAt: Schema.optionalKey(Schema.Number),
      recordedPosition: Schema.optionalKey(Schema.Number),
    }),
  ),
  causationDepth: Schema.optionalKey(Schema.Number),
});
