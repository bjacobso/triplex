import { Schema } from "effect";

export const Page = Schema.Literals([
  "overview",
  "entities",
  "forms",
  "query",
  "journal",
  "config",
]);
export type Page = typeof Page.Type;

export const FactView = Schema.Struct({
  id: Schema.String,
  attribute: Schema.String,
  value: Schema.String,
  valueType: Schema.String,
  rawValue: Schema.String,
  validFrom: Schema.Number,
  validTo: Schema.NullOr(Schema.Number),
  recordedAt: Schema.Number,
  txId: Schema.NullOr(Schema.String),
});
export type FactView = typeof FactView.Type;

export const EntityView = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  name: Schema.String,
  facts: Schema.Array(FactView),
});
export type EntityView = typeof EntityView.Type;

export const EntityTypeSummary = Schema.Struct({
  name: Schema.String,
  entityCount: Schema.Number,
  attributeCount: Schema.Number,
});
export type EntityTypeSummary = typeof EntityTypeSummary.Type;

export const EntityAttributeView = Schema.Struct({
  attribute: Schema.String,
  label: Schema.String,
  valueType: Schema.String,
  valueCount: Schema.Number,
  referenceTarget: Schema.NullOr(Schema.String),
});
export type EntityAttributeView = typeof EntityAttributeView.Type;

export const EntityTypePageView = Schema.Struct({
  entityType: Schema.String,
  columns: Schema.Array(Schema.String),
  attributes: Schema.Array(EntityAttributeView),
  entities: Schema.Array(EntityView),
  totalCount: Schema.Number,
  nextCursor: Schema.NullOr(Schema.String),
});
export type EntityTypePageView = typeof EntityTypePageView.Type;

export const EntityAttributeDraft = Schema.Struct({
  attribute: Schema.String,
  label: Schema.String,
  valueType: Schema.String,
  value: Schema.String,
  cleared: Schema.Boolean,
  touched: Schema.Boolean,
  multiple: Schema.Boolean,
  referenceTarget: Schema.NullOr(Schema.String),
  referenceSearch: Schema.String,
});
export type EntityAttributeDraft = typeof EntityAttributeDraft.Type;

export const ChangeView = Schema.Struct({
  op: Schema.Literals(["assert", "retract"]),
  tripleId: Schema.String,
  entityId: Schema.String,
  entityType: Schema.NullOr(Schema.String),
  attribute: Schema.String,
  value: Schema.String,
  valueType: Schema.NullOr(Schema.String),
  validFrom: Schema.NullOr(Schema.Number),
  validTo: Schema.NullOr(Schema.Number),
});
export type ChangeView = typeof ChangeView.Type;

export const TransactionView = Schema.Struct({
  id: Schema.String,
  position: Schema.Number,
  instant: Schema.Number,
  actor: Schema.NullOr(Schema.String),
  commandId: Schema.NullOr(Schema.String),
  correlationId: Schema.NullOr(Schema.String),
  configSnapshot: Schema.NullOr(Schema.String),
  changes: Schema.Array(ChangeView),
});
export type TransactionView = typeof TransactionView.Type;

export const ConfigRevisionView = Schema.Struct({
  revisionId: Schema.String,
  sequence: Schema.Number,
  contentId: Schema.String,
  closureContentId: Schema.String,
  parentRevisionId: Schema.NullOr(Schema.String),
  body: Schema.String,
  releases: Schema.Array(Schema.String),
});
export type ConfigRevisionView = typeof ConfigRevisionView.Type;

export const ConfigObjectView = Schema.Struct({
  kind: Schema.String,
  key: Schema.String,
  active: Schema.Boolean,
  revisionId: Schema.String,
  contentId: Schema.String,
  dependencies: Schema.Array(Schema.String),
  history: Schema.Array(ConfigRevisionView),
});
export type ConfigObjectView = typeof ConfigObjectView.Type;

export const ConfigReleaseView = Schema.Struct({
  snapshotId: Schema.String,
  sequence: Schema.Number,
  label: Schema.String,
  rootContentId: Schema.String,
  parentSnapshotId: Schema.NullOr(Schema.String),
  revisionCount: Schema.Number,
  refs: Schema.Array(Schema.String),
});
export type ConfigReleaseView = typeof ConfigReleaseView.Type;

export const ConfigRefView = Schema.Struct({
  name: Schema.String,
  snapshotId: Schema.String,
});
export type ConfigRefView = typeof ConfigRefView.Type;

export const ConfigView = Schema.Struct({
  label: Schema.String,
  snapshotId: Schema.String,
  rootContentId: Schema.String,
  sequence: Schema.Number,
  objectCount: Schema.Number,
  revisionCount: Schema.Number,
  releaseCount: Schema.Number,
  refs: Schema.Array(ConfigRefView),
  releases: Schema.Array(ConfigReleaseView),
  objects: Schema.Array(ConfigObjectView),
});
export type ConfigView = typeof ConfigView.Type;

export const FormFieldView = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  label: Schema.String,
  description: Schema.String,
  input: Schema.Literals(["text", "textarea", "select"]),
  required: Schema.Boolean,
  options: Schema.Array(Schema.String),
});
export type FormFieldView = typeof FormFieldView.Type;

export const FormView = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  description: Schema.String,
  submitLabel: Schema.String,
  fields: Schema.Array(FormFieldView),
});
export type FormView = typeof FormView.Type;

export const BindingView = Schema.Struct({
  variable: Schema.String,
  value: Schema.String,
});
export type BindingView = typeof BindingView.Type;

export const CandidateView = Schema.Struct({
  id: Schema.String,
  revision: Schema.String,
  definitionId: Schema.String,
  bindings: Schema.Array(BindingView),
  sourceCount: Schema.Number,
  sourceTransactionCount: Schema.Number,
});
export type CandidateView = typeof CandidateView.Type;

export const MetricView = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  detail: Schema.String,
  tone: Schema.Literals(["blue", "violet", "green", "amber"]),
});
export type MetricView = typeof MetricView.Type;

export const QueryView = Schema.Struct({
  nextCursor: Schema.NullOr(Schema.String),
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Schema.String)),
  resultCount: Schema.Number,
  executionTimeMs: Schema.Number,
  plan: Schema.Array(Schema.String),
});
export type QueryView = typeof QueryView.Type;

export const DashboardData = Schema.Struct({
  source: Schema.String,
  generatedAt: Schema.Number,
  position: Schema.Number,
  basis: Schema.Struct({
    recordedAt: Schema.NullOr(Schema.Number),
    validAt: Schema.Number,
  }),
  metrics: Schema.Array(MetricView),
  entities: Schema.Array(EntityView),
  entityTypes: Schema.Array(EntityTypeSummary),
  transactions: Schema.Array(TransactionView),
  config: ConfigView,
  forms: Schema.Array(FormView),
  candidates: Schema.Array(CandidateView),
});
export type DashboardData = typeof DashboardData.Type;

export const Model = Schema.Struct({
  page: Page,
  data: Schema.NullOr(DashboardData),
  selectedEntityId: Schema.NullOr(Schema.String),
  selectedEntityHistory: Schema.Array(TransactionView),
  entityEditor: Schema.Literals(["closed", "create", "edit"]),
  entityEditorFormat: Schema.Literals(["form", "json"]),
  entityAttributeDrafts: Schema.Array(EntityAttributeDraft),
  entityDraftId: Schema.String,
  entityDraftType: Schema.String,
  entityDraftFacts: Schema.String,
  selectedEntityType: Schema.NullOr(Schema.String),
  entityTypePage: Schema.NullOr(EntityTypePageView),
  entityTypeCursor: Schema.NullOr(Schema.String),
  entityTypeBackStack: Schema.Array(Schema.NullOr(Schema.String)),
  selectedFormKey: Schema.NullOr(Schema.String),
  formValues: Schema.Record(Schema.String, Schema.String),
  selectedConfigObject: Schema.NullOr(Schema.String),
  selectedConfigRevisionId: Schema.NullOr(Schema.String),
  configEditor: Schema.Literals(["closed", "create", "edit", "remove"]),
  configDraftKind: Schema.String,
  configDraftKey: Schema.String,
  configDraftAttrs: Schema.String,
  configDraftRefs: Schema.String,
  configDraftLabel: Schema.String,
  configTargetRef: Schema.String,
  entitySearch: Schema.String,
  queryPreset: Schema.String,
  queryText: Schema.String,
  queryResult: Schema.NullOr(QueryView),
  temporalPanelOpen: Schema.Boolean,
  recordedAt: Schema.NullOr(Schema.Number),
  validAt: Schema.NullOr(Schema.Number),
  recordedAtDraft: Schema.String,
  recordedAtDraftExact: Schema.NullOr(Schema.Number),
  validAtDraft: Schema.String,
  busy: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  notice: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;
