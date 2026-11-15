/**
 * The explorer's wire contract, shared by the host and the browser. Requests are
 * Schema-decoded on the host; responses are plain JSON produced by the host.
 */
import { Schema } from "effect";

/** Omitted fields mean "now": the latest commit, and the current instant. */
export const Basis = Schema.Struct({
  recordedPosition: Schema.optional(Schema.Number),
  validAt: Schema.optional(Schema.Number),
});
export type Basis = typeof Basis.Type;

export const FilterOp = Schema.Literals([
  "contains",
  "=",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "empty",
  "not-empty",
]);
export type FilterOp = typeof FilterOp.Type;

export const Filter = Schema.Struct({
  attribute: Schema.String,
  op: FilterOp,
  value: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
});
export type Filter = typeof Filter.Type;

export const Sort = Schema.Struct({
  attribute: Schema.String,
  direction: Schema.Literals(["asc", "desc"]),
});
export type Sort = typeof Sort.Type;

export const WireValue = Schema.Union([
  Schema.Struct({ type: Schema.Literal("string"), value: Schema.String }),
  Schema.Struct({ type: Schema.Literal("number"), value: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("boolean"), value: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("datetime"), value: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("ref"), value: Schema.String }),
]);
export type WireValue = typeof WireValue.Type;

export const WhySubject = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("fact"), tripleId: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("attribute"),
    entityId: Schema.String,
    attribute: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("entity"), entityId: Schema.String }),
]);
export type WhySubject = typeof WhySubject.Type;

export const SaveValue = Schema.Struct({
  attribute: Schema.String,
  /** The attribute's complete new value set; empty ends or removes it. */
  values: Schema.Array(WireValue),
});

export const ExplorerRequest = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Describe") }),
  Schema.Struct({
    _tag: Schema.Literal("Rows"),
    entityType: Schema.String,
    basis: Basis,
    sort: Schema.optional(Sort),
    filters: Schema.Array(Filter),
    cursor: Schema.optional(Schema.String),
    limit: Schema.Number,
  }),
  Schema.Struct({ _tag: Schema.Literal("Record"), entityId: Schema.String, basis: Basis }),
  Schema.Struct({
    _tag: Schema.Literal("Why"),
    subject: WhySubject,
    basis: Basis,
  }),
  Schema.Struct({ _tag: Schema.Literal("References"), entityId: Schema.String, basis: Basis }),
  Schema.Struct({
    _tag: Schema.Literal("Journal"),
    before: Schema.optional(Schema.Number),
    limit: Schema.Number,
  }),
  Schema.Struct({ _tag: Schema.Literal("Transaction"), txId: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("Save"),
    entityId: Schema.String,
    entityType: Schema.String,
    mode: Schema.Literals(["create", "edit"]),
    /** `replace` changes values from `effectiveFrom` on; `correct` rewrites the whole interval. */
    change: Schema.Literals(["replace", "correct"]),
    effectiveFrom: Schema.optional(Schema.Number),
    actor: Schema.String,
    values: Schema.Array(SaveValue),
  }),
]);
export type ExplorerRequest = typeof ExplorerRequest.Type;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** A stored value. Sealed, JSON and blob values arrive as their own shapes. */
export type Value =
  | WireValue
  | { readonly type: "json"; readonly value: unknown }
  | { readonly type: "blob"; readonly value: string; readonly mimeType?: string }
  | { readonly type: "sealed"; readonly valueType: string };

export interface Fact {
  readonly id: string;
  readonly entityId: string;
  readonly attribute: string;
  readonly value: Value;
  readonly validFrom: number;
  readonly validTo: number | null;
  readonly recordedAt: number;
  readonly retractedAt: number | null;
  readonly txId: string | null;
  readonly retractTxId: string | null;
}

export type ValueKind =
  | "text"
  | "number"
  | "integer"
  | "boolean"
  | "date"
  | "instant"
  | "enum"
  | "ref"
  | "other";

export interface AttributeView {
  readonly key: string;
  readonly kind: ValueKind;
  /** A readable value type, such as `text`, `ref Site` or `enum a | b`. */
  readonly type: string;
  readonly enumValues: readonly string[];
  readonly required: boolean;
  readonly cardinality: "one" | "many";
  readonly unique: boolean;
  readonly ref: string | null;
  readonly sensitive: boolean;
}

export interface TypeView {
  readonly name: string;
  readonly attributes: readonly AttributeView[];
  /**
   * A required attribute only this type uses. Sorted and filtered tables find the
   * type's members through it; without one they show only entities that have the
   * sorted or filtered value.
   */
  readonly anchor: string | null;
  /** Other types that point at this one, as `Type :attribute`. */
  readonly referencedBy: readonly { readonly type: string; readonly attribute: string }[];
}

export interface Description {
  readonly database: string;
  readonly head: number;
  readonly readOnly: boolean;
  readonly release: {
    readonly id: string;
    readonly label: string;
    readonly rootContentId: string;
  } | null;
  readonly types: readonly TypeView[];
}

export interface ResolvedBasis {
  readonly recordedPosition: number;
  readonly validAt: number;
}

export interface Row {
  readonly id: string;
  readonly facts: readonly Fact[];
}

export interface RowsPage {
  readonly entityType: string;
  readonly basis: ResolvedBasis;
  readonly rows: readonly Row[];
  readonly nextCursor: string | null;
  readonly totalCount: number | null;
  /** `entities` pages the exact type by ID; `query` pages a sorted or filtered Datalog window. */
  readonly source: "entities" | "query";
  readonly anchor: string | null;
  /** Display labels of referenced entities, by ID. */
  readonly labels: Readonly<Record<string, string>>;
  readonly durationMs: number;
}

export interface Change {
  readonly op: "assert" | "retract";
  readonly tripleId: string;
  readonly entityId: string;
  readonly entityType: string | null;
  readonly attribute: string;
  readonly value: Value | null;
  readonly validFrom: number | null;
  readonly validTo: number | null;
}

export interface Transaction {
  readonly txId: string;
  readonly position: number;
  readonly instant: number;
  readonly actor: string | null;
  readonly commandId: string | null;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly release: { readonly id: string; readonly label: string | null } | null;
  readonly changes: readonly Change[];
}

export interface EntityRecord {
  readonly entityId: string;
  readonly entityType: string | null;
  readonly basis: ResolvedBasis;
  /** Facts visible at the basis. */
  readonly facts: readonly Fact[];
  /** Every assertion ever recorded for the entity, retracted ones included. */
  readonly history: readonly Fact[];
  /** Transactions that changed the entity, newest first. */
  readonly transactions: readonly Transaction[];
  readonly moreTransactions: boolean;
  readonly labels: Readonly<Record<string, string>>;
  readonly label: string;
}

export interface Reference {
  readonly source: string;
  readonly sourceType: string | null;
  readonly attribute: string;
  readonly label: string;
}

export interface References {
  readonly entityId: string;
  readonly references: readonly Reference[];
  readonly total: number | null;
  readonly truncated: boolean;
}

export interface JournalPage {
  readonly head: number;
  /** Newest first. */
  readonly transactions: readonly Transaction[];
  readonly nextBefore: number | null;
}

export interface Saved {
  readonly txId: string;
  readonly position: number;
}

/** One line of the live stream, newest commit last. */
export type LiveEvent =
  | {
      readonly type: "head";
      readonly position: number;
      readonly nextTemporalBoundary: number | null;
    }
  | { readonly type: "tx"; readonly transaction: Transaction }
  | { readonly type: "error"; readonly message: string };

/** Why explanations are passed through from core's `Why` service. */
export interface Explanation {
  readonly version: 1;
  readonly basis: { readonly validAt: number; readonly recordedPosition: number };
  readonly facts: readonly {
    readonly tripleId: string;
    readonly entityId: string;
    readonly entityType: string | null;
    readonly attribute: string;
    readonly value: Value;
    readonly valid: { readonly from: number; readonly to: number | null };
    readonly recorded: { readonly from: number; readonly to: number | null };
    readonly visible: boolean;
    readonly assertion: string | null;
    readonly retraction: string | null;
  }[];
  readonly transactions: readonly {
    readonly txId: string;
    readonly position: number;
    readonly instant: number;
    readonly actor: string | null;
    readonly commandId: string | null;
    readonly correlationId: string | null;
    readonly causationId: string | null;
    readonly release:
      | { readonly status: "unpinned" }
      | { readonly status: "missing"; readonly id: string }
      | { readonly status: "found"; readonly id: string; readonly label: string };
  }[];
  readonly causation: {
    readonly maxDepth: number;
    readonly traces: readonly {
      readonly start: string;
      readonly ancestors: readonly string[];
      readonly stop: { readonly reason: string; readonly commandId?: string };
    }[];
  };
  readonly gaps: readonly { readonly kind: string; readonly tripleId: string }[];
}
