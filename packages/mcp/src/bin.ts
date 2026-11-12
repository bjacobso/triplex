#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { diagnose } from "@triplex-internal/core";
import { Console, Effect, Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { registrations } from "./index.js";
import { databaseLayer, parseOptions } from "./startup.js";

const main = Effect.gen(function* () {
  const options = yield* parseOptions(process.argv.slice(2), process.env);
  yield* Layer.launch(
    McpServer.layerStdio({
      name: "triplex-mcp",
      version: "0.0.0",
      protocols: [McpProtocol.v2025_11_25],
      instructions:
        "Start with describe. Use its live release examples, pin configSnapshot, enforce constraints, and include actor and commandId on every write.",
      registrations,
    }).pipe(Layer.provide(databaseLayer(options))),
  );
});

main.pipe(
  Effect.catch((error) =>
    Console.error(JSON.stringify(diagnose(error))).pipe(Effect.andThen(Effect.fail(error))),
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
