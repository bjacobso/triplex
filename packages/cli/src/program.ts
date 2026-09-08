import { PgTriples, type PostgresqlConfig } from "@bjacobso/triplex-postgres";
import { SqliteTriples } from "@bjacobso/triplex-sqlite";
import {
  DatalogQuery,
  DatabaseId,
  EntityId,
  QueryRequest,
  TemporalBasis,
  TransactionId,
  TransactRequest,
  WrappedQuery,
  queryToPattern,
} from "@bjacobso/triplex";
import { ConfigStore } from "@bjacobso/triplex/config";
import { ContentId } from "@bjacobso/triplex/content";
import {
  Cause,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schema,
  Stdio,
  Stream,
} from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { execute, type ExecuteOptions } from "./operations.js";

declare const __TRIPLEX_CLI_VERSION__: string;

const pretty = Flag.boolean("pretty").pipe(
  Flag.withDescription("Pretty-print JSON output"),
  Flag.withDefault(false),
);

const sqlite = Flag.string("sqlite").pipe(
  Flag.withDescription("SQLite file path; defaults to ./triplex.sqlite"),
  Flag.withDefault("./triplex.sqlite"),
);

const postgresUrl = Flag.string("postgres-url").pipe(
  Flag.withDescription("PostgreSQL URL; prefer TRIPLEX_POSTGRES_URL to avoid shell history"),
  Flag.optional,
);

const databaseId = Flag.string("database-id").pipe(
  Flag.withDescription("Validated logical database for PostgreSQL schema isolation"),
  Flag.withSchema(DatabaseId),
  Flag.optional,
);

export const rootCommand = Command.make("triplex").pipe(
  Command.withSharedFlags({ pretty, sqlite, postgresUrl, databaseId }),
  Command.withDescription("Explore and operate a Triplex database with stable JSON output"),
);

const input = Flag.string("input").pipe(
  Flag.withAlias("i"),
  Flag.withDescription("JSON input file, or - for stdin"),
  Flag.withDefault("-"),
);

const debug = Flag.boolean("debug").pipe(
  Flag.withDescription("Include backend query diagnostics"),
  Flag.withDefault(false),
);

const limit = Flag.integer("limit").pipe(
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

const includeSystem = Flag.boolean("include-system").pipe(
  Flag.withDescription("Include Triplex-owned system entities"),
  Flag.withDefault(false),
);

const validAt = Flag.integer("valid-at").pipe(
  Flag.withDescription("Business-time basis as epoch milliseconds"),
  Flag.withSchema(Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  Flag.optional,
);

const recordedAt = Flag.integer("recorded-at").pipe(
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

const readJson = (
  path: string,
): Effect.Effect<unknown, unknown, FileSystem.FileSystem | Stdio.Stdio> =>
  Effect.gen(function* () {
    const source =
      path === "-"
        ? yield* (yield* Stdio.Stdio).stdin.pipe(
            Stream.decodeText,
            Stream.runFold(
              () => "",
              (all: string, chunk: string) => all + chunk,
            ),
          )
        : yield* (yield* FileSystem.FileSystem).readFileString(path);
    return yield* Effect.try({
      try: () => JSON.parse(source) as unknown,
      catch: (cause) => new Error(`Invalid JSON from ${path}: ${String(cause)}`),
    });
  });

const readWith = <A>(schema: Schema.Codec<A, unknown>, path: string) =>
  readJson(path).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));

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
      ? SqliteTriples.layer({ filename: root.sqlite })
      : Option.match(root.databaseId, {
          onNone: () => PgTriples.layerFromUrl(url),
          onSome: (id) => PgTriples.layerForDatabaseMigrated(postgresConfig(url), id),
        });
  return ConfigStore.layer.pipe(Layer.provideMerge(triplesLayer));
});

const emit = (command: string, operation: ExecuteOptions) =>
  Effect.gen(function* () {
    const root = yield* rootCommand;
    const layer = yield* databaseLayer();
    const data = yield* execute(operation).pipe(Effect.provide(layer));
    yield* Console.log(JSON.stringify({ ok: true, command, data }, null, root.pretty ? 2 : 0));
  });

const status = Command.make("status", {}, () => emit("status", { _tag: "status" })).pipe(
  Command.withDescription("Show the commit position and configuration store counts"),
);

const entityTypes = Command.make("types", { includeSystem }, ({ includeSystem }) =>
  emit("entity.types", { _tag: "entity-types", includeSystem }),
).pipe(Command.withDescription("Discover entity types and their attributes"));

const entityList = Command.make(
  "list",
  {
    type: Flag.string("type").pipe(Flag.withDescription("Filter by entity type"), Flag.optional),
    limit,
    after: Flag.string("after").pipe(
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

const entityGet = Command.make(
  "get",
  {
    entityId: Argument.string("entity-id").pipe(Argument.withSchema(EntityId)),
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

const entityFacts = Command.make(
  "facts",
  { entityId: Argument.string("entity-id").pipe(Argument.withSchema(EntityId)) },
  ({ entityId }) => emit("entity.facts", { _tag: "entity-facts", entityId }),
).pipe(
  Command.withDescription("Read the complete assertion/retraction fact history for an entity"),
);

const entityHistory = Command.make(
  "history",
  {
    entityId: Argument.string("entity-id").pipe(Argument.withSchema(EntityId)),
    limit,
    snapshotPosition: Flag.integer("snapshot-position").pipe(
      Flag.withSchema(Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
      Flag.optional,
    ),
    beforePosition: Flag.integer("before-position").pipe(
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

const factMatch = Command.make(
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

const queryRun = Command.make(
  "run",
  { input, debug, validAt, recordedAt, limit, cursor: Flag.string("cursor").pipe(Flag.optional) },
  ({ input, debug, validAt, recordedAt, limit, cursor }) =>
    Effect.gen(function* () {
      const query = yield* readWith(DatalogQuery, input);
      return yield* emit("query.run", {
        _tag: "query-run",
        pageSize: limit,
        ...Option.match(cursor, { onNone: () => ({}), onSome: (cursor) => ({ cursor }) }),
        query,
        debug,
        ...(basisOf(validAt, recordedAt) === undefined
          ? {}
          : { basis: basisOf(validAt, recordedAt) }),
      });
    }),
).pipe(Command.withDescription("Execute one bounded Datalog page from JSON"));

const queryPage = Command.make(
  "page",
  { input, debug, validAt, recordedAt },
  ({ input, debug, validAt, recordedAt }) =>
    Effect.gen(function* () {
      const query = yield* readWith(WrappedQuery, input);
      return yield* emit("query.page", {
        _tag: "query-page",
        query,
        debug,
        ...(basisOf(validAt, recordedAt) === undefined
          ? {}
          : { basis: basisOf(validAt, recordedAt) }),
      });
    }),
).pipe(Command.withDescription("Execute a cursor-paginated wrapped Datalog query"));

const queryExplain = Command.make("explain", { input }, ({ input }) =>
  Effect.gen(function* () {
    const query = yield* readWith(DatalogQuery, input);
    return yield* emit("query.explain", { _tag: "query-explain", query });
  }),
).pipe(Command.withDescription("Compile and explain a Datalog query without running it"));

const query = Command.make("query").pipe(
  Command.withDescription("Run and explain raw Datalog"),
  Command.withSubcommands([queryRun, queryPage, queryExplain]),
);

const transactionApply = Command.make("apply", { input }, ({ input }) =>
  Effect.gen(function* () {
    const request = yield* readWith(TransactRequest, input);
    if (request.meta?.actor === undefined || request.meta.commandId === undefined) {
      return yield* Effect.fail(
        new Error("transaction input must include meta.actor and meta.commandId"),
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

const journalList = Command.make(
  "list",
  {
    after: Flag.integer("after").pipe(
      Flag.withSchema(Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
      Flag.withDefault(0),
    ),
    limit,
  },
  ({ after, limit }) => emit("journal.list", { _tag: "journal-list", after, limit }),
).pipe(Command.withDescription("Page the global transaction journal in commit order"));

const journalReceipt = Command.make(
  "receipt",
  { commandId: Argument.string("command-id") },
  ({ commandId }) => emit("journal.receipt", { _tag: "journal-receipt", commandId }),
).pipe(Command.withDescription("Find an idempotent transaction receipt by command ID"));

const journalTransaction = Command.make(
  "transaction",
  {
    transactionId: Argument.string("transaction-id").pipe(Argument.withSchema(TransactionId)),
  },
  ({ transactionId }) =>
    emit("journal.transaction", { _tag: "journal-transaction", transactionId }),
).pipe(Command.withDescription("Read one transaction envelope by transaction ID"));

const journal = Command.make("journal").pipe(
  Command.withDescription("Inspect the causal transaction journal"),
  Command.withSubcommands([journalList, journalReceipt, journalTransaction]),
);

const configRefs = Command.make("refs", {}, () =>
  emit("config.refs", { _tag: "config-refs" }),
).pipe(Command.withDescription("List moving configuration refs"));

const configReleases = Command.make("releases", {}, () =>
  emit("config.releases", { _tag: "config-releases" }),
).pipe(Command.withDescription("List immutable configuration releases newest first"));

const configRelease = Command.make(
  "release",
  {
    snapshotId: Flag.string("snapshot").pipe(
      Flag.withSchema(ContentId.ContentIdSchema),
      Flag.optional,
    ),
    ref: Flag.string("ref").pipe(Flag.optional),
  },
  ({ snapshotId, ref }) => {
    if (Option.isNone(snapshotId) === Option.isNone(ref)) {
      return Effect.fail(new Error("provide exactly one of --snapshot or --ref"));
    }
    return emit("config.release", {
      _tag: "config-release",
      ...(optionValue(snapshotId) === undefined ? {} : { snapshotId: optionValue(snapshotId) }),
      ...(optionValue(ref) === undefined ? {} : { ref: optionValue(ref) }),
    });
  },
).pipe(Command.withDescription("Inspect a release and every pinned revision"));

const configObjects = Command.make(
  "objects",
  {
    kind: Flag.string("kind").pipe(Flag.optional),
    activeOnly: Flag.boolean("active-only").pipe(Flag.withDefault(false)),
  },
  ({ kind, activeOnly }) =>
    emit("config.objects", {
      _tag: "config-objects",
      activeOnly,
      ...(optionValue(kind) === undefined ? {} : { kind: optionValue(kind) }),
    }),
).pipe(Command.withDescription("List logical config identities and version counts"));

const configObject = Command.make(
  "object",
  {
    kind: Argument.string("kind"),
    key: Argument.string("key"),
  },
  ({ kind, key }) => emit("config.object", { _tag: "config-object", kind, key }),
).pipe(Command.withDescription("Inspect the complete immutable history of one config object"));

const configSetRef = Command.make(
  "set-ref",
  {
    name: Argument.string("name"),
    snapshotId: Argument.string("snapshot-id").pipe(Argument.withSchema(ContentId.ContentIdSchema)),
  },
  ({ name, snapshotId }) => emit("config.set-ref", { _tag: "config-set-ref", name, snapshotId }),
).pipe(Command.withDescription("Atomically move a configuration ref to an existing release"));

const configImpact = Command.make(
  "impact",
  { kind: Argument.string("kind"), key: Argument.string("key") },
  ({ kind, key }) => emit("config.impact", { _tag: "config-impact", kind, key }),
).pipe(Command.withDescription("Query reverse dependencies and deploy-impact candidates"));

const config = Command.make("config").pipe(
  Command.withDescription("Splunk configuration objects, revisions, releases, refs, and impact"),
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

const describe = Command.make("describe", {}, () =>
  Effect.gen(function* () {
    const root = yield* rootCommand;
    yield* Console.log(
      JSON.stringify(
        {
          ok: true,
          command: "describe",
          data: {
            output: "JSON envelope: { ok, command, data }",
            input: "JSON via --input <file>, or --input - for stdin",
            backends: ["SQLite file", "PostgreSQL URL", "database-scoped PostgreSQL"],
            commands: {
              status: "Database and configuration summary",
              entity: ["types", "list", "get", "facts", "history"],
              fact: ["match"],
              query: ["run", "page", "explain"],
              transaction: ["apply"],
              journal: ["list", "receipt", "transaction"],
              config: ["refs", "releases", "release", "objects", "object", "set-ref", "impact"],
            },
          },
        },
        null,
        root.pretty ? 2 : 0,
      ),
    );
  }),
).pipe(Command.withDescription("Print the machine-readable CLI capability manifest"));

export const command = rootCommand.pipe(
  Command.withSubcommands([status, describe, entity, fact, query, transaction, journal, config]),
);

export const run = Command.run(command, { version: __TRIPLEX_CLI_VERSION__ });

export const reportFailure = (cause: Cause.Cause<unknown>) =>
  Console.error(
    JSON.stringify({
      ok: false,
      error: {
        message: Cause.pretty(cause),
      },
    }),
  ).pipe(Effect.andThen(Effect.failCause(cause)));
