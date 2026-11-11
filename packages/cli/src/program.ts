import {
  makePostgresqlBackend,
  PgTriples,
  type PostgresqlConfig,
} from "@triplex-build/triplex-postgres";
import { DatabaseManagerLive, DatabaseRegistryLive } from "@triplex-build/triplex-sql";
import { makeSqliteBackend, SqliteTriples } from "@triplex-build/triplex-sqlite";
import {
  diagnose,
  type Diagnostic,
  DatalogQuery,
  DatabaseId,
  EntityId,
  QueryRequest,
  TemporalBasis,
  TransactionId,
  TransactRequest,
  WrappedQuery,
  queryToPattern,
} from "@triplex-build/triplex";
import { RuntimeServicesLive, TripleStoreRuntimeLayer } from "@triplex-build/triplex/internal";
import { ConfigStore } from "@triplex-build/triplex/config";
import { ContentId } from "@triplex-build/triplex/content";
import {
  Cause,
  Console,
  Data,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  References,
  Schema,
  SchemaIssue,
  Stdio,
  Stream,
} from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import {
  execute,
  executeDatabase,
  type ExecuteDatabaseOptions,
  type ExecuteOptions,
} from "./operations.js";

import { invocation, invocationOptions, makeCommand } from "./invocation.js";

declare const __TRIPLEX_CLI_VERSION__: string;

const pretty = Flag.Boolean("pretty").pipe(
  Flag.withDescription("Pretty-print JSON output"),
  Flag.withDefault(false),
);

const sqlite = Flag.String("sqlite").pipe(
  Flag.withDescription("Standalone SQLite file path; defaults to ./triplex.sqlite"),
  Flag.withDefault("./triplex.sqlite"),
);

const dataDir = Flag.String("data-dir").pipe(
  Flag.withDescription("Directory for managed SQLite databases"),
  Flag.withDefault("./data"),
);

const postgresUrl = Flag.String("postgres-url").pipe(
  Flag.withDescription("PostgreSQL URL; prefer TRIPLEX_POSTGRES_URL to avoid shell history"),
  Flag.optional,
);

const databaseId = Flag.String("database-id").pipe(
  Flag.withDescription("Managed database to use for data commands"),
  Flag.withSchema(DatabaseId),
  Flag.optional,
);

const debug = Flag.Boolean("debug").pipe(
  Flag.withDescription("Include failure causes and backend query diagnostics"),
  Flag.withDefault(false),
);

const sharedFlags = { pretty, debug, sqlite, dataDir, postgresUrl, databaseId };

export const rootCommand = Command.make("triplex").pipe(
  Command.withSharedFlags(sharedFlags),
  Command.annotate(invocationOptions, sharedFlags),
  Command.withDescription(
    "Pre-1.0 CLI: explore and operate a Triplex database with stable JSON output",
  ),
);

const input = Flag.String("input").pipe(
  Flag.withAlias("i"),
  Flag.withDescription("JSON input file, or - for stdin"),
  Flag.withDefault("-"),
);

const limit = Flag.Int("limit").pipe(
  Flag.withAlias("n"),
  Flag.withDescription("Page size (1-1000)"),
  Flag.withSchema(
    Schema.Number.pipe(
      Schema.check(Schema.isGreaterThanOrEqualTo(1)),
      Schema.check(Schema.isLessThanOrEqualTo(1_000)),
    ),
  ),
  Flag.withDefault(100),
);

const includeSystem = Flag.Boolean("include-system").pipe(
  Flag.withDescription("Include Triplex-owned system entities"),
  Flag.withDefault(false),
);

const validAt = Flag.Int("valid-at").pipe(
  Flag.withDescription("Business-time basis as epoch milliseconds"),
  Flag.withSchema(Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  Flag.optional,
);

const recordedAt = Flag.Int("recorded-at").pipe(
  Flag.withDescription("Knowledge-time basis as epoch milliseconds"),
  Flag.withSchema(Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  Flag.optional,
);

const optionValue = <A>(option: Option.Option<A>): A | undefined => Option.getOrUndefined(option);

const basisOf = (
  valid: Option.Option<number>,
  recorded: Option.Option<number>,
): typeof TemporalBasis.Type | undefined => {
  const validValue = optionValue(valid);
  const recordedValue = optionValue(recorded);
  return validValue === undefined && recordedValue === undefined
    ? undefined
    : {
        ...(validValue === undefined ? {} : { validAt: validValue }),
        ...(recordedValue === undefined ? {} : { recordedAt: recordedValue }),
      };
};

class CliFailure extends Data.TaggedError("CliFailure")<Diagnostic> {}

const invalidArguments = (message: string, path = "$args") =>
  new CliFailure({
    code: "cli.arguments",
    message,
    path,
    fix: "Correct the arguments using triplex <command> --help.",
    retryable: false,
  });

const readJson = (
  path: string,
): Effect.Effect<unknown, CliFailure, FileSystem.FileSystem | Stdio.Stdio> =>
  Effect.gen(function* () {
    const source = yield* (
      path === "-"
        ? (yield* Stdio.Stdio).stdin.pipe(
            Stream.decodeText,
            Stream.runFold(
              () => "",
              (all: string, chunk: string) => all + chunk,
            ),
          )
        : (yield* FileSystem.FileSystem).readFileString(path)
    ).pipe(
      Effect.mapError(
        () =>
          new CliFailure({
            code: "cli.input-read",
            message: "Could not read JSON input",
            path: "$",
            fix: "Supply a readable --input file or pipe JSON to stdin.",
            retryable: false,
          }),
      ),
    );
    return yield* Effect.try({
      try: () => JSON.parse(source) as unknown,
      catch: () =>
        new CliFailure({
          code: "cli.input-json",
          message: "Input must be valid JSON",
          path: "$",
          fix: "Correct the JSON syntax in the input.",
          retryable: false,
        }),
    });
  });

const readWith = <A>(schema: Schema.Codec<A, unknown>, path: string) =>
  readJson(path).pipe(
    Effect.flatMap((input) =>
      Schema.decodeUnknownEffect(schema)(input).pipe(
        Effect.mapError((error) => {
          const keys =
            SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues[0]?.path ?? [];
          const location = keys.reduce<string>(
            (path, key) => (typeof key === "number" ? `${path}[${key}]` : `${path}.${String(key)}`),
            "$",
          );
          return new CliFailure({
            code: "cli.input-schema",
            message: "Input does not match the command schema",
            path: location,
            fix: "Correct the input field using the command's documented JSON schema.",
            retryable: false,
          });
        }),
      ),
    ),
  );

const postgresConfig = (source: string): PostgresqlConfig => {
  const url = new URL(source);
  return {
    database: url.pathname.slice(1),
    ...(url.hostname === "" ? {} : { host: url.hostname }),
    ...(url.port === "" ? {} : { port: Number.parseInt(url.port, 10) }),
    ...(url.username === "" ? {} : { username: decodeURIComponent(url.username) }),
    ...(url.password === "" ? {} : { password: Redacted.make(decodeURIComponent(url.password)) }),
    ...(url.searchParams.get("ssl") === "true" ? { ssl: true } : {}),
  };
};

const databaseLayer = Effect.fn(function* () {
  const root = yield* rootCommand;
  const fromFlag = optionValue(root.postgresUrl);
  const url = fromFlag ?? process.env["TRIPLEX_POSTGRES_URL"];
  const triplesLayer =
    url === undefined
      ? Option.match(root.databaseId, {
          onNone: () => SqliteTriples.layer({ filename: root.sqlite }),
          onSome: (id) => SqliteTriples.layer({ filename: `${root.dataDir}/${id}.db` }),
        })
      : Option.match(root.databaseId, {
          onNone: () => PgTriples.layerFromUrl(url),
          onSome: (id) => PgTriples.layerForDatabaseMigrated(postgresConfig(url), id),
        });
  return ConfigStore.layer.pipe(Layer.provideMerge(triplesLayer));
});

const databaseManagerLayer = Effect.fn(function* () {
  const root = yield* rootCommand;
  const url = optionValue(root.postgresUrl) ?? process.env["TRIPLEX_POSTGRES_URL"];
  const backend =
    url === undefined
      ? makeSqliteBackend({ dataDir: root.dataDir })
      : makePostgresqlBackend(postgresConfig(url));

  return DatabaseManagerLive.pipe(
    Layer.provide(DatabaseRegistryLive),
    Layer.provide(backend),
    Layer.provide(RuntimeServicesLive),
    Layer.provide(TripleStoreRuntimeLayer),
  );
});

const emit = (command: string, operation: ExecuteOptions) =>
  Effect.gen(function* () {
    const root = yield* rootCommand;
    const layer = yield* databaseLayer();
    const data = yield* execute(operation).pipe(
      Effect.provide(layer),
      Effect.provideService(References.MinimumLogLevel, "None"),
    );
    yield* Console.log(JSON.stringify({ ok: true, command, data }, null, root.pretty ? 2 : 0));
  });

const emitDatabase = (command: string, operation: ExecuteDatabaseOptions) =>
  Effect.gen(function* () {
    const root = yield* rootCommand;
    const layer = yield* databaseManagerLayer();
    const data = yield* executeDatabase(operation).pipe(
      Effect.provide(layer),
      Effect.provideService(References.MinimumLogLevel, "None"),
    );
    yield* Console.log(JSON.stringify({ ok: true, command, data }, null, root.pretty ? 2 : 0));
  });

const status = makeCommand("status", {}, () => emit("status", { _tag: "status" })).pipe(
  Command.withDescription("Show the commit position and configuration store counts"),
);

const entityTypes = makeCommand("types", { includeSystem }, ({ includeSystem }) =>
  emit("entity.types", { _tag: "entity-types", includeSystem }),
).pipe(Command.withDescription("Discover entity types and their attributes"));

const entityList = makeCommand(
  "list",
  {
    type: Flag.String("type").pipe(Flag.withDescription("Filter by entity type"), Flag.optional),
    limit,
    after: Flag.String("after").pipe(
      Flag.withDescription("Continue after this entity ID"),
      Flag.withSchema(EntityId),
      Flag.optional,
    ),
    includeSystem,
    validAt,
    recordedAt,
  },
  ({ type, limit, after, includeSystem, validAt, recordedAt }) =>
    emit("entity.list", {
      _tag: "entity-list",
      limit,
      includeSystem,
      ...(optionValue(type) === undefined ? {} : { entityType: optionValue(type) }),
      ...(optionValue(after) === undefined ? {} : { after: optionValue(after) }),
      ...(basisOf(validAt, recordedAt) === undefined
        ? {}
        : { basis: basisOf(validAt, recordedAt) }),
    }),
).pipe(Command.withDescription("List reflected entities in deterministic ID order"));

const entityGet = makeCommand(
  "get",
  {
    entityId: Argument.String("entity-id").pipe(Argument.withSchema(EntityId)),
    validAt,
    recordedAt,
  },
  ({ entityId, validAt, recordedAt }) =>
    emit("entity.get", {
      _tag: "entity-get",
      entityId,
      ...(basisOf(validAt, recordedAt) === undefined
        ? {}
        : { basis: basisOf(validAt, recordedAt) }),
    }),
).pipe(Command.withDescription("Read one entity at a bitemporal basis"));

const entityFacts = makeCommand(
  "facts",
  { entityId: Argument.String("entity-id").pipe(Argument.withSchema(EntityId)) },
  ({ entityId }) => emit("entity.facts", { _tag: "entity-facts", entityId }),
).pipe(
  Command.withDescription("Read the complete assertion/retraction fact history for an entity"),
);

const entityHistory = makeCommand(
  "history",
  {
    entityId: Argument.String("entity-id").pipe(Argument.withSchema(EntityId)),
    limit,
    snapshotPosition: Flag.Int("snapshot-position").pipe(
      Flag.withSchema(Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
      Flag.optional,
    ),
    beforePosition: Flag.Int("before-position").pipe(
      Flag.withSchema(Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
      Flag.optional,
    ),
  },
  ({ entityId, limit, snapshotPosition, beforePosition }) =>
    emit("entity.history", {
      _tag: "entity-history",
      entityId,
      limit,
      ...(optionValue(snapshotPosition) === undefined
        ? {}
        : { snapshotPosition: optionValue(snapshotPosition) }),
      ...(optionValue(beforePosition) === undefined
        ? {}
        : { beforePosition: optionValue(beforePosition) }),
    }),
).pipe(Command.withDescription("Page newest-first causal transactions for one entity"));

const entity = Command.make("entity").pipe(
  Command.withDescription("Explore entities and their causal history"),
  Command.withSubcommands([entityTypes, entityList, entityGet, entityFacts, entityHistory]),
);

const factMatch = makeCommand(
  "match",
  { input, validAt, recordedAt },
  ({ input, validAt, recordedAt }) =>
    Effect.gen(function* () {
      const pattern = yield* readWith(QueryRequest, input);
      return yield* emit("fact.match", {
        _tag: "fact-match",
        pattern: queryToPattern(pattern),
        ...(basisOf(validAt, recordedAt) === undefined
          ? {}
          : { basis: basisOf(validAt, recordedAt) }),
      });
    }),
).pipe(Command.withDescription("Match facts using a JSON triple pattern"));

const fact = Command.make("fact").pipe(
  Command.withDescription("Inspect low-level facts"),
  Command.withSubcommands([factMatch]),
);

const queryRun = makeCommand(
  "run",
  { input, validAt, recordedAt, limit, cursor: Flag.String("cursor").pipe(Flag.optional) },
  ({ input, validAt, recordedAt, limit, cursor }) =>
    Effect.gen(function* () {
      const query = yield* readWith(DatalogQuery, input);
      return yield* emit("query.run", {
        _tag: "query-run",
        pageSize: limit,
        ...Option.match(cursor, { onNone: () => ({}), onSome: (cursor) => ({ cursor }) }),
        query,
        debug: (yield* rootCommand).debug,
        ...(basisOf(validAt, recordedAt) === undefined
          ? {}
          : { basis: basisOf(validAt, recordedAt) }),
      });
    }),
).pipe(Command.withDescription("Execute one bounded Datalog page from JSON"));

const queryPage = makeCommand(
  "page",
  { input, validAt, recordedAt },
  ({ input, validAt, recordedAt }) =>
    Effect.gen(function* () {
      const query = yield* readWith(WrappedQuery, input);
      return yield* emit("query.page", {
        _tag: "query-page",
        query,
        debug: (yield* rootCommand).debug,
        ...(basisOf(validAt, recordedAt) === undefined
          ? {}
          : { basis: basisOf(validAt, recordedAt) }),
      });
    }),
).pipe(Command.withDescription("Execute a cursor-paginated wrapped Datalog query"));

const queryExplain = makeCommand("explain", { input }, ({ input }) =>
  Effect.gen(function* () {
    const query = yield* readWith(DatalogQuery, input);
    return yield* emit("query.explain", { _tag: "query-explain", query });
  }),
).pipe(Command.withDescription("Compile and explain a Datalog query without running it"));

const query = Command.make("query").pipe(
  Command.withDescription("Run and explain raw Datalog"),
  Command.withSubcommands([queryRun, queryPage, queryExplain]),
);

const transactionApply = makeCommand("apply", { input }, ({ input }) =>
  Effect.gen(function* () {
    const request = yield* readWith(TransactRequest, input);
    if (request.meta?.actor === undefined || request.meta.commandId === undefined) {
      return yield* Effect.fail(
        invalidArguments("transaction input must include meta.actor and meta.commandId", "$.meta"),
      );
    }
    return yield* emit("transaction.apply", { _tag: "transaction-apply", request });
  }),
).pipe(Command.withDescription("Atomically apply attributed assertion/retraction operations"));

const transaction = Command.make("transaction").pipe(
  Command.withAlias("tx"),
  Command.withDescription("Apply atomic, idempotent transactions"),
  Command.withSubcommands([transactionApply]),
);

const journalList = makeCommand(
  "list",
  {
    after: Flag.Int("after").pipe(
      Flag.withSchema(Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
      Flag.withDefault(0),
    ),
    limit,
  },
  ({ after, limit }) => emit("journal.list", { _tag: "journal-list", after, limit }),
).pipe(Command.withDescription("Page the global transaction journal in commit order"));

const journalReceipt = makeCommand(
  "receipt",
  { commandId: Argument.String("command-id") },
  ({ commandId }) => emit("journal.receipt", { _tag: "journal-receipt", commandId }),
).pipe(Command.withDescription("Find an idempotent transaction receipt by command ID"));

const journalTransaction = makeCommand(
  "transaction",
  {
    transactionId: Argument.String("transaction-id").pipe(Argument.withSchema(TransactionId)),
  },
  ({ transactionId }) =>
    emit("journal.transaction", { _tag: "journal-transaction", transactionId }),
).pipe(Command.withDescription("Read one transaction envelope by transaction ID"));

const journal = Command.make("journal").pipe(
  Command.withDescription("Inspect the causal transaction journal"),
  Command.withSubcommands([journalList, journalReceipt, journalTransaction]),
);

const configRefs = makeCommand("refs", {}, () => emit("config.refs", { _tag: "config-refs" })).pipe(
  Command.withDescription("List moving configuration refs"),
);

const configReleases = makeCommand("releases", {}, () =>
  emit("config.releases", { _tag: "config-releases" }),
).pipe(Command.withDescription("List immutable configuration releases newest first"));

const configRelease = makeCommand(
  "release",
  {
    snapshotId: Flag.String("snapshot").pipe(
      Flag.withSchema(ContentId.ContentIdSchema),
      Flag.optional,
    ),
    ref: Flag.String("ref").pipe(Flag.optional),
  },
  ({ snapshotId, ref }) => {
    if (Option.isNone(snapshotId) === Option.isNone(ref)) {
      return Effect.fail(invalidArguments("provide exactly one of --snapshot or --ref"));
    }
    return emit("config.release", {
      _tag: "config-release",
      ...(optionValue(snapshotId) === undefined ? {} : { snapshotId: optionValue(snapshotId) }),
      ...(optionValue(ref) === undefined ? {} : { ref: optionValue(ref) }),
    });
  },
).pipe(Command.withDescription("Inspect a release and every pinned revision"));

const configObjects = makeCommand(
  "objects",
  {
    kind: Flag.String("kind").pipe(Flag.optional),
    activeOnly: Flag.Boolean("active-only").pipe(Flag.withDefault(false)),
  },
  ({ kind, activeOnly }) =>
    emit("config.objects", {
      _tag: "config-objects",
      activeOnly,
      ...(optionValue(kind) === undefined ? {} : { kind: optionValue(kind) }),
    }),
).pipe(Command.withDescription("List logical config identities and version counts"));

const configObject = makeCommand(
  "object",
  {
    kind: Argument.String("kind"),
    key: Argument.String("key"),
  },
  ({ kind, key }) => emit("config.object", { _tag: "config-object", kind, key }),
).pipe(Command.withDescription("Inspect the complete immutable history of one config object"));

const configSetRef = makeCommand(
  "set-ref",
  {
    name: Argument.String("name"),
    snapshotId: Argument.String("snapshot-id").pipe(Argument.withSchema(ContentId.ContentIdSchema)),
  },
  ({ name, snapshotId }) => emit("config.set-ref", { _tag: "config-set-ref", name, snapshotId }),
).pipe(Command.withDescription("Atomically move a configuration ref to an existing release"));

const configImpact = makeCommand(
  "impact",
  { kind: Argument.String("kind"), key: Argument.String("key") },
  ({ kind, key }) => emit("config.impact", { _tag: "config-impact", kind, key }),
).pipe(Command.withDescription("Query reverse dependencies and deploy-impact candidates"));

const config = Command.make("config").pipe(
  Command.withDescription("Inspect configuration objects, revisions, releases, refs, and impact"),
  Command.withSubcommands([
    configRefs,
    configReleases,
    configRelease,
    configObjects,
    configObject,
    configSetRef,
    configImpact,
  ]),
);

const managedDatabaseName = Argument.String("name").pipe(Argument.withSchema(DatabaseId));

const databaseCreate = makeCommand(
  "create",
  {
    name: managedDatabaseName,
    description: Flag.String("description").pipe(
      Flag.withAlias("d"),
      Flag.withDescription("Human-readable database description"),
      Flag.optional,
    ),
  },
  ({ name, description }) =>
    emitDatabase("db.create", {
      _tag: "database-create",
      name,
      ...(optionValue(description) === undefined ? {} : { description: optionValue(description) }),
    }),
).pipe(Command.withDescription("Create and migrate a managed database"));

const databaseList = makeCommand("list", {}, () =>
  emitDatabase("db.list", { _tag: "database-list" }),
).pipe(Command.withDescription("List managed databases"));

const databaseGet = makeCommand("get", { name: managedDatabaseName }, ({ name }) =>
  emitDatabase("db.get", { _tag: "database-get", name }),
).pipe(Command.withDescription("Show one managed database"));

const databaseUpdate = makeCommand(
  "update",
  {
    name: managedDatabaseName,
    description: Flag.String("description").pipe(
      Flag.withAlias("d"),
      Flag.withDescription("New human-readable database description"),
    ),
  },
  ({ name, description }) =>
    emitDatabase("db.update", { _tag: "database-update", name, description }),
).pipe(Command.withDescription("Update managed database metadata"));

const yes = Flag.Boolean("yes").pipe(
  Flag.withAlias("y"),
  Flag.withDescription("Confirm the destructive operation"),
  Flag.withDefault(false),
);

const requireConfirmation = <A, E, R>(confirmed: boolean, operation: Effect.Effect<A, E, R>) =>
  confirmed
    ? operation
    : Effect.fail(
        invalidArguments("This operation is destructive; pass --yes to confirm", "$args.yes"),
      );

const databaseClear = makeCommand("clear", { name: managedDatabaseName, yes }, ({ name, yes }) =>
  requireConfirmation(yes, emitDatabase("db.clear", { _tag: "database-clear", name })),
).pipe(Command.withDescription("Delete all data while preserving the managed database"));

const databaseDelete = makeCommand("delete", { name: managedDatabaseName, yes }, ({ name, yes }) =>
  requireConfirmation(yes, emitDatabase("db.delete", { _tag: "database-delete", name })),
).pipe(Command.withDescription("Delete a managed database and its storage"));

const database = Command.make("db").pipe(
  Command.withAlias("database"),
  Command.withDescription("Create and manage isolated databases"),
  Command.withSubcommands([
    databaseCreate,
    databaseList,
    databaseGet,
    databaseUpdate,
    databaseClear,
    databaseDelete,
  ]),
);

const describe = makeCommand(
  "describe",
  {
    ref: Flag.String("ref").pipe(
      Flag.withDefault("live"),
      Flag.withDescription("Configuration release ref"),
    ),
  },
  ({ ref }) => emit("describe", { _tag: "describe", ref }),
).pipe(Command.withDescription("Describe CLI capabilities and the schema from a release"));

export const command = rootCommand.pipe(
  Command.withSubcommands([
    status,
    describe,
    database,
    entity,
    fact,
    query,
    transaction,
    journal,
    config,
  ]),
);

export const reportFailure = (
  cause: Cause.Cause<unknown>,
  options: { readonly command?: string; readonly debug?: boolean } = {},
) => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  const diagnostic =
    error instanceof CliFailure
      ? {
          code: error.code,
          message: error.message,
          path: error.path,
          fix: error.fix,
          retryable: error.retryable,
        }
      : CliError.isCliError(error)
        ? {
            code: "cli.arguments",
            message: "Invalid command arguments",
            path: "$args",
            fix: "Correct the arguments using triplex <command> --help.",
            retryable: false,
          }
        : diagnose(error);
  return Console.error(
    JSON.stringify({
      ok: false,
      command: options.command ?? "triplex",
      error: diagnostic,
      ...(options.debug ? { cause: Cause.pretty(cause) } : {}),
    }),
  ).pipe(Effect.andThen(Effect.failCause(cause)));
};

export const run = Effect.gen(function* () {
  const { args } = yield* Stdio.Stdio;
  const argv = yield* args;
  return yield* Command.run(command, {
    version: __TRIPLEX_CLI_VERSION__,
    renderErrors: false,
  }).pipe(Effect.catchCause((cause) => reportFailure(cause, invocation(command, argv))));
});
