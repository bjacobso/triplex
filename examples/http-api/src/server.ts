import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import { KvTriples } from "@bjacobso/triplex";
import { Attribute, ConfigStore, EntityType } from "@bjacobso/triplex/config";
import { EntityHttp, HttpAuthorizationAllowAll } from "@bjacobso/triplex-http";
import { SqliteTriples } from "@bjacobso/triplex-sqlite";
import { Effect, Layer, Option, Path, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { createServer } from "node:http";

const EmployeeName = Attribute.text(":employee/name");
const EmployeeEmail = Attribute.text(":employee/email");

// First deployment: Employee has one exposed attribute.
const EmployeeV1 = EntityType.make("Employee", {
  attributes: { name: Attribute.use(EmployeeName, { required: true, unique: true }) },
});

// Second deployment: the persisted schema adds an optional email attribute.
const EmployeeV2 = EntityType.make("Employee", {
  attributes: {
    name: Attribute.use(EmployeeName, { required: true, unique: true }),
    email: Attribute.use(EmployeeEmail),
  },
});

const routes = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* ConfigStore.ConfigStore;
    const v1 = yield* store.commit({
      label: "http-example-v1",
      objects: yield* EmployeeV1.nodes,
    });
    const v2 = yield* store.commit({
      label: "http-example-v2",
      objects: yield* EmployeeV2.nodes,
      ref: "live",
    });
    return EntityHttp.layer({
      basePath: "/api",
      docs: true,
      aliases: { v1: v1.snapshot.id, v2: v2.snapshot.id },
      exposure: { collections: { Employee: "employees" } },
    });
  }),
).pipe(Layer.provide(HttpAuthorizationAllowAll));

const logDocumentation = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const address = HttpServer.formatAddress(server.address);
  yield* Effect.log(`Triplex HTTP API documentation:
  v1 (name only):     ${address}/api/rest/v1/docs
  v2 (name + email):  ${address}/api/rest/v2/docs
  latest (v2 writes): ${address}/api/rest/latest/docs`);
});

const command = Command.make(
  "triplex-http-api",
  {
    sqlite: Flag.string("sqlite").pipe(
      Flag.withDescription("SQLite filename; omit to use ephemeral in-memory storage"),
      Flag.optional,
    ),
    host: Flag.string("host").pipe(
      Flag.withDescription("Host address to bind"),
      Flag.withDefault("127.0.0.1"),
    ),
    port: Flag.integer("port").pipe(
      Flag.withDescription("Port to listen on; use 0 to allocate an available port"),
      Flag.withSchema(
        Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(65535)),
      ),
      Flag.withDefault(3000),
    ),
  },
  Effect.fn(function* ({ sqlite, host, port }) {
    const path = yield* Path.Path;
    const triples = Option.match(sqlite, {
      onNone: () => KvTriples.layer,
      onSome: (filename) => SqliteTriples.layer({ filename: path.resolve(filename) }),
    });
    const database = ConfigStore.layer.pipe(Layer.provideMerge(triples));

    yield* HttpRouter.serve(routes.pipe(Layer.provide(database))).pipe(
      Layer.tap(() => logDocumentation),
      Layer.provide(NodeHttpServer.layer(createServer, { host, port })),
      Layer.launch,
    );
  }),
).pipe(Command.withDescription("Serve the versioned Triplex Employee HTTP API example"));

command.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
