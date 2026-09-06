#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { PgTriples } from "@bjacobso/triplex-postgres";
import { SqliteTriples } from "@bjacobso/triplex-sqlite";
import { ConfigStore } from "@bjacobso/triplex/config";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/unstable/http";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DashboardRequest, executeDashboardRequest, localDashboardApiLayer } from "./api.js";

interface ServerOptions {
  readonly source: "sqlite" | "postgres";
  readonly target: string;
  readonly port: number;
}

const usage = `Usage:
  pnpm --filter @bjacobso/triplex-dashboard serve -- --sqlite <database.db> [--port 4174]
  pnpm --filter @bjacobso/triplex-dashboard serve -- --postgres <connection-url> [--port 4174]`;

const parseOptions = (args: readonly string[]): ServerOptions => {
  const valueAfter = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const sqlite = valueAfter("--sqlite");
  const postgres = valueAfter("--postgres");
  if ((sqlite === undefined) === (postgres === undefined)) throw new Error(usage);
  const rawPort = valueAfter("--port") ?? "4174";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${rawPort}\n\n${usage}`);
  }
  return sqlite === undefined
    ? { source: "postgres", target: postgres!, port }
    : { source: "sqlite", target: resolve(sqlite), port };
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string") return message;
  }
  return String(error);
};

const ApiRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/health", HttpServerResponse.jsonUnsafe({ ok: true })),
  HttpRouter.add("POST", "/api/dashboard", (request) =>
    Effect.gen(function* () {
      const body = yield* request.json;
      const operation = yield* Schema.decodeUnknownEffect(DashboardRequest)(body);
      const value = yield* executeDashboardRequest(operation);
      return yield* HttpServerResponse.json({ ok: true, value });
    }).pipe(
      Effect.catch((error) =>
        HttpServerResponse.json({ ok: false, error: errorMessage(error) }, { status: 400 }),
      ),
    ),
  ),
);

const distDirectory = fileURLToPath(new URL("../dist", import.meta.url));
const StaticRoutes = HttpStaticServer.layer({
  root: distDirectory,
  index: "index.html",
  spa: true,
});

const options = parseOptions(process.argv.slice(2));
const databaseLayer = ConfigStore.layer.pipe(
  Layer.provideMerge(
    options.source === "sqlite"
      ? SqliteTriples.layer({ filename: options.target })
      : PgTriples.layerFromUrl(options.target),
  ),
);
const sourceLabel =
  options.source === "sqlite"
    ? `sqlite://${options.target}`
    : (() => {
        const url = new URL(options.target);
        return `postgresql://${url.host}/${url.pathname.replace(/^\//, "")}`;
      })();
const dashboardApiLayer = localDashboardApiLayer(sourceLabel).pipe(Layer.provide(databaseLayer));

const HttpServerLive = HttpRouter.serve(Layer.mergeAll(ApiRoutes, StaticRoutes)).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: options.port })),
  Layer.provide(dashboardApiLayer),
);

Effect.log(`Triplex dashboard: http://localhost:${options.port}/?source=remote`).pipe(
  Effect.andThen(Layer.launch(HttpServerLive)),
  NodeRuntime.runMain,
);
