import {
  DatalogQuery,
  EntityId,
  TemporalBasis,
  TransactRequest,
  TripleValue,
  Triples,
  WrappedQuery,
  diagnose,
} from "@triplex-build/triplex";
import { WhyInput, execute, type ExecuteOptions } from "@triplex-build/triplex-cli";
import { ContentId } from "@triplex-build/triplex/content";
import { ConfigStore } from "@triplex-build/triplex/config";
import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";

const Diagnostic = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  path: Schema.optional(Schema.String),
  fix: Schema.optional(Schema.String),
  retryable: Schema.Boolean,
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const tool = <const Name extends string, Fields extends Schema.Struct.Fields>(
  name: Name,
  description: string,
  fields: Fields,
) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct(fields),
    success: Schema.Unknown,
    failure: Diagnostic,
  });

const basis = Schema.optional(TemporalBasis);
const debug = Schema.optional(Schema.Boolean);
const limit = Schema.optional(
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
);
const meta = Schema.required(TransactRequest.fields.meta);
const Variable = Schema.Struct({ _tag: Schema.Literal("Variable"), name: Schema.String });
export const TransactionInput = Schema.Struct({
  ...TransactRequest.fields,
  meta: Schema.Struct({ ...meta.fields, actor: Schema.String, commandId: Schema.String }),
});

export const tools = Toolkit.make(
  tool("describe", "Describe the live release schema, rules and transaction examples.", {
    ref: Schema.optional(Schema.String),
  }),
  Tool.make("status", {
    description: "Read database position and configuration counts.",
    success: Schema.Unknown,
    failure: Diagnostic,
  }),
  tool("entity_types", "List entity types, counts and attributes.", {
    includeSystem: Schema.optional(Schema.Boolean),
  }),
  tool("entity_get", "Read an entity at an optional temporal basis.", {
    entityId: EntityId,
    basis,
  }),
  tool("entity_facts", "Read all historical facts for an entity.", { entityId: EntityId }),
  tool("entity_history", "Page an entity's transaction history.", {
    entityId: EntityId,
    limit,
    snapshotPosition: Schema.optional(Schema.Number),
    beforePosition: Schema.optional(Schema.Number),
  }),
  tool("fact_match", "Match facts using typed values or pattern variables.", {
    pattern: Schema.Struct({
      entityId: Schema.optionalKey(Schema.Union([EntityId, Variable])),
      attribute: Schema.optionalKey(Schema.Union([Schema.String, Variable])),
      value: Schema.optionalKey(Schema.Union([TripleValue, Variable])),
      entityType: Schema.optionalKey(Schema.String),
    }),
    basis,
  }),
  tool("query_run", "Run a bounded Datalog query; reuse its cursor for subsequent pages.", {
    query: DatalogQuery,
    cursor: Schema.optionalKey(Schema.String),
    pageSize: Schema.optionalKey(Schema.required(limit)),
    basis,
    debug,
  }),
  tool("query_page", "Run a wrapped Datalog query.", { query: WrappedQuery, basis, debug }),
  tool("query_explain", "Explain a Datalog query.", { query: DatalogQuery }),
  tool("journal_list", "Page the transaction journal.", {
    after: Schema.optional(Schema.Number),
    limit,
  }),
  tool("journal_receipt", "Find the receipt for a command ID before retrying a write.", {
    commandId: Schema.String,
  }),
  tool("config_release", "Read a configuration release by snapshot ID or ref.", {
    snapshotId: Schema.optional(ContentId.ContentIdSchema),
    ref: Schema.optional(Schema.String),
  }),
  tool(
    "why",
    "Explain a fact, attribute, entity or derivation candidate at an exact cut.",
    WhyInput.fields,
  ),
  Tool.make("transaction_preview", {
    description:
      "Preview transaction changes and constraint violations without committing. Advisory; does not reserve state or run commit validators.",
    parameters: TransactionInput,
    success: Schema.Unknown,
    failure: Diagnostic,
  }),
  Tool.make("transaction_apply", {
    description:
      "Apply one atomic command. Requires actor and unique commandId; pin configSnapshot and enforce constraints from describe.",
    parameters: TransactionInput,
    success: Schema.Unknown,
    failure: Diagnostic,
  }),
);

/** Registration layer shared by stdio and in-process MCP clients. Supply Triples and ConfigStore. */
export const registrations = McpServer.toolkit(tools).pipe(
  Layer.provide(
    tools.toLayer(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const config = yield* ConfigStore.ConfigStore;
        const run = (options: ExecuteOptions) =>
          execute(options).pipe(
            Effect.mapError(diagnose),
            Effect.provideService(Triples, triples),
            Effect.provideService(ConfigStore.ConfigStore, config),
          );
        return {
          describe: ({ ref }) => run({ _tag: "describe", ref: ref ?? "live" }),
          status: () => run({ _tag: "status" }),
          entity_types: ({ includeSystem }) =>
            run({ _tag: "entity-types", includeSystem: includeSystem ?? false }),
          entity_get: (input) => run({ _tag: "entity-get", ...input }),
          entity_facts: (input) => run({ _tag: "entity-facts", ...input }),
          entity_history: (input) =>
            run({ _tag: "entity-history", ...input, limit: input.limit ?? 100 }),
          fact_match: (input) => run({ _tag: "fact-match", ...input }),
          query_run: (input) => run({ _tag: "query-run", ...input, debug: input.debug ?? false }),
          query_page: (input) => run({ _tag: "query-page", ...input, debug: input.debug ?? false }),
          query_explain: (input) => run({ _tag: "query-explain", ...input }),
          journal_list: (input) =>
            run({ _tag: "journal-list", after: input.after ?? 0, limit: input.limit ?? 100 }),
          journal_receipt: (input) => run({ _tag: "journal-receipt", ...input }),
          config_release: (input) => run({ _tag: "config-release", ...input }),
          why: (input) => run({ _tag: "why", ...input }),
          transaction_preview: (request) => run({ _tag: "transaction-preview", request }),
          transaction_apply: (request) => run({ _tag: "transaction-apply", request }),
        } satisfies Toolkit.HandlersFrom<typeof tools.tools>;
      }),
    ),
  ),
);
