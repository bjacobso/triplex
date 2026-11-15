#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";
import { ConfigStore } from "@triplex-internal/core/config";
import { Why } from "@triplex-internal/core/why";
import { Effect, Layer, Schema, Stream } from "effect";
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http";
import { createServer } from "node:http";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ExplorerRequest } from "../shared/protocol.js";
import { Explorer } from "./api.js";
import { isAllowedOrigin, parseAllowedOrigin } from "./security.js";

const usage = `Usage:
  triplex-explorer --sqlite <database.db> [--port 4176] [--read-only] [--allow-origin <https origin>]...

The host binds to 127.0.0.1 and accepts API requests only from its own loopback
origin and from each exact --allow-origin, such as an authenticated proxy in front of it.`;

const parseOptions = (args: readonly string[]) => {
  const valueAfter = (flag: string) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const sqlite = valueAfter("--sqlite");
  if (sqlite === undefined) throw new Error(usage);
  const port = Number(valueAfter("--port") ?? "4176");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(usage);
  const allowed = args.flatMap((arg, index) =>
    arg === "--allow-origin" && args[index + 1] !== undefined
      ? [parseAllowedOrigin(args[index + 1]!)]
      : [],
  );
  return { filename: resolve(sqlite), port, allowed, readOnly: args.includes("--read-only") };
};

const options = parseOptions(process.argv.slice(2));

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    if (typeof error.message === "string") return error.message;
  }
  return String(error);
};

const forbidden = HttpServerResponse.jsonUnsafe(
  { ok: false, error: "Explorer requests require an allowed Origin" },
  { status: 403 },
);

const encoder = new TextEncoder();

const ApiRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/health", HttpServerResponse.jsonUnsafe({ ok: true })),
  HttpRouter.add("POST", "/api/explorer", (request) =>
    Effect.gen(function* () {
      if (!isAllowedOrigin(request.headers["origin"], options.port, options.allowed))
        return forbidden;
      const explorer = yield* Explorer;
      const operation = yield* Schema.decodeUnknownEffect(ExplorerRequest)(yield* request.json);
      const value = yield* explorer.handle(operation);
      return yield* HttpServerResponse.json({ ok: true, value });
    }).pipe(
      Effect.catch((error) =>
        HttpServerResponse.json({ ok: false, error: errorMessage(error) }, { status: 400 }),
      ),
    ),
  ),
  // A POST stream keeps the Origin check that EventSource would not send.
  HttpRouter.add("POST", "/api/live", (request) =>
    Effect.gen(function* () {
      if (!isAllowedOrigin(request.headers["origin"], options.port, options.allowed))
        return forbidden;
      const explorer = yield* Explorer;
      const body = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ after: Schema.optional(Schema.Number) }),
      )(yield* request.json);
      return HttpServerResponse.stream(
        explorer
          .live(body.after)
          .pipe(Stream.map((event) => encoder.encode(`${JSON.stringify(event)}\n`))),
        { contentType: "application/x-ndjson", headers: { "cache-control": "no-store" } },
      );
    }).pipe(
      Effect.catch((error) =>
        HttpServerResponse.json({ ok: false, error: errorMessage(error) }, { status: 400 }),
      ),
    ),
  ),
);

// Both src/server/main.ts and dist-server/server/main.js sit two levels below the package.
const distDirectory = fileURLToPath(new URL("../../dist", import.meta.url));
const StaticRoutes = HttpStaticServer.layer({
  root: distDirectory,
  index: "index.html",
  spa: true,
});

const triplesLayer = options.readOnly
  ? SqliteTriples.layerReadOnly({ filename: options.filename })
  : SqliteTriples.layer({ filename: options.filename });
const databaseLayer = ConfigStore.layer.pipe(Layer.provideMerge(triplesLayer));
const explorerLayer = Explorer.layer({
  database: basename(options.filename),
  readOnly: options.readOnly,
}).pipe(Layer.provide(Why.layer), Layer.provide(databaseLayer));

const HttpServerLive = HttpRouter.serve(Layer.mergeAll(ApiRoutes, StaticRoutes)).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: options.port })),
  Layer.provide(explorerLayer),
);

Effect.log(
  `Triplex explorer: http://localhost:${options.port} (${options.filename}${options.readOnly ? ", read-only" : ""})`,
).pipe(Effect.andThen(Layer.launch(HttpServerLive)), NodeRuntime.runMain);
