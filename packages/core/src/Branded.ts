import { Schema } from "effect";

const TripleIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9A-Z]{26}$/)),
  Schema.brand("TripleId"),
);
export const TripleId = Object.assign(TripleIdSchema, {
  decode: (s: string) => Schema.decodeEffect(TripleIdSchema)(s),
});
export type TripleId = typeof TripleIdSchema.Type;

const EntityIdSchema = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("EntityId"),
);
export const EntityId = Object.assign(EntityIdSchema, {
  decode: (s: string) => Schema.decodeEffect(EntityIdSchema)(s),
});
export type EntityId = typeof EntityIdSchema.Type;

export const Attribute = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^:[a-zA-Z_][a-zA-Z0-9_-]*\/[a-zA-Z][a-zA-Z0-9_-]*$/)),
  Schema.brand("Attribute"),
  Schema.annotate({
    identifier: "Attribute",
    description: "Namespaced attribute name in format :namespace/attribute",
  }),
);
export type Attribute = typeof Attribute.Type;

const DatabaseIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/)),
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
  Schema.brand("DatabaseId"),
);
export const DatabaseId = Object.assign(DatabaseIdSchema, {
  decode: (s: string) => Schema.decodeEffect(DatabaseIdSchema)(s),
});
export type DatabaseId = typeof DatabaseIdSchema.Type;

const TransactionIdSchema = EntityId.pipe(
  Schema.check(Schema.isPattern(/^_tx\/[0-9A-Z]{26}$/)),
  Schema.brand("TransactionId"),
);
export const TransactionId = Object.assign(TransactionIdSchema, {
  decode: (s: string) => Schema.decodeEffect(TransactionIdSchema)(s),
});
export type TransactionId = typeof TransactionIdSchema.Type;

export const decode = {
  tripleId: TripleId.decode,
  entityId: EntityId.decode,
  attribute: (s: string) => Schema.decodeEffect(Attribute)(s),
  databaseId: DatabaseId.decode,
  transactionId: TransactionId.decode,
};

export const unsafe = {
  tripleId: (s: string) => TripleId.make(s),
  entityId: (s: string) => EntityId.make(s),
  attribute: (s: string) => Schema.decodeSync(Attribute)(s),
  databaseId: (s: string) => DatabaseId.make(s),
  transactionId: (s: string) => TransactionId.make(s),
};
