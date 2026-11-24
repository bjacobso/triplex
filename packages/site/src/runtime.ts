/**
 * Builds one MCP session's Effect `HttpEffect`: Triplex's KV hexastore over
 * Durable Object SQLite, seeded with the homepage story, served by Effect's
 * Streamable HTTP `McpServer` with `tour`, `reset`, and the `triplex mcp`
 * toolkit. Kept in its own module so plan-time evaluation of `alchemy.run.ts`
 * does not need built `@triplex-build/triplex` dist files on disk.
 */
import type { DurableObjectState } from "@alchemy.run/cloudflare/Workers";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { ConfigStore } from "@triplex-build/triplex/config";
import { registrations } from "@triplex-build/triplex/mcp";
import { Capabilities, DatabaseScope, Runtime } from "@triplex-build/triplex/runtime";
import { Context, Effect, Layer, Scope } from "effect";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import { HttpRouter, type HttpServerRequest, type HttpServerResponse } from "effect/http";

import { instructions, seed, tour } from "./demo.ts";
import { durableObjectKvLayer } from "./kv.ts";

const VERSION = "0.3.0";

export type McpHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  unknown,
  Scope.Scope | HttpServerRequest.HttpServerRequest
>;

export interface SessionHandle {
  readonly scope: Scope.Closeable;
  readonly httpEffect: McpHttpEffect;
  innerSessionId: string | undefined;
}

const textResult = (text: string, isError = false) =>
  new McpSchema.CallToolResult({
    isError,
    content: [{ type: "text", text }],
  });

export const buildSessionHandle = (options: {
  readonly state: DurableObjectState["Service"];
  readonly runtimeContext: RuntimeContext["Service"];
  readonly onReset: Effect.Effect<void, never, RuntimeContext>;
}): Effect.Effect<SessionHandle, never, RuntimeContext> =>
  Effect.gen(function* () {
    const { state, runtimeContext, onReset } = options;
    const generation = (yield* state.storage.get<number>("generation")) ?? 0;
    const scope = yield* Scope.make();
    const database = ConfigStore.layer.pipe(
      Layer.provideMerge(
        Runtime.fromKv({
          name: "durable-object-kv",
          backend: durableObjectKvLayer(state.raw.storage),
        }).layer({
          scope: DatabaseScope.make({
            env: "triplex.build",
            tenant: "mcp",
            database: state.id.toString(),
            generation,
          }),
          capabilities: Capabilities.none,
        }),
      ),
    );
    const databaseContext = yield* Layer.buildWithScope(database, scope).pipe(Effect.orDie);
    if (!(yield* state.storage.get<boolean>("seeded"))) {
      yield* seed.pipe(Effect.provide(databaseContext), Effect.orDie);
      yield* state.storage.put("seeded", true);
    }

    const demoRegistrations = Layer.effectDiscard(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        yield* server.addTool({
          tool: new McpSchema.Tool({
            name: "tour",
            description:
              "Start here. The story already loaded in this session's database and the questions worth asking it.",
            inputSchema: { type: "object", properties: {} },
          }),
          annotations: Context.empty(),
          handle: () => Effect.succeed(textResult(tour)),
        });
        yield* server.addTool({
          tool: new McpSchema.Tool({
            name: "reset",
            description:
              "Delete everything in this session's database and load the starting story again.",
            inputSchema: { type: "object", properties: {} },
          }),
          annotations: Context.empty(),
          handle: () =>
            onReset.pipe(
              Effect.provideService(RuntimeContext, runtimeContext),
              Effect.as(textResult("The database holds the starting story again.")),
            ),
        });
      }),
    );

    const mcpLayer = McpServer.layerHttp({
      name: "triplex",
      version: VERSION,
      instructions,
      path: "/mcp",
      protocols: [
        McpProtocol.v2025_11_25,
        McpProtocol.v2025_06_18,
        McpProtocol.v2025_03_26,
        McpProtocol.v2024_11_05,
      ],
      allowSessionTermination: true,
      registrations: Layer.merge(demoRegistrations, registrations).pipe(
        Layer.provide(Layer.succeedContext(databaseContext)),
      ),
    });

    const httpEffect = yield* HttpRouter.toHttpEffect(mcpLayer).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.orDie,
    );

    return {
      scope,
      httpEffect: httpEffect as McpHttpEffect,
      innerSessionId: undefined,
    };
  });
