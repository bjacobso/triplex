import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import { KvTriples } from "@triplex-build/triplex";
import { ConfigStore } from "@triplex-build/triplex/config";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";
import { Effect, Layer, Option, Path, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { createServer } from "node:http";

import { routes } from "./api.js";

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
