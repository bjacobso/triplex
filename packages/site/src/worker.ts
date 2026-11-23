/**
 * The triplex.build Worker. Browsers get the documentation; MCP clients that
 * POST to /mcp get a hosted Triplex MCP server (Streamable HTTP). Each MCP
 * session owns one Durable Object, and that object's SQLite storage is the
 * session's own Triplex database, seeded with the homepage story. It serves
 * the same tools as `triplex mcp`, plus `tour` and `reset`.
 */
import { DurableObject } from "cloudflare:workers";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ConfigStore } from "@triplex-build/triplex/config";
import { registrations } from "@triplex-build/triplex/mcp";
import { Capabilities, DatabaseScope, Runtime } from "@triplex-build/triplex/runtime";
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { McpProtocol, McpTest } from "effect/ai";

import { instructions, seed, tour } from "./demo.js";
import { durableObjectKvLayer } from "./kv.js";

const MAX_BODY = 64_000;
const MAX_DATABASE_BYTES = 25_000_000;
const IDLE_MS = 24 * 60 * 60 * 1000;
const VERSION = "0.3.0";

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  readonly ASSETS: Fetcher;
  readonly SESSIONS: DurableObjectNamespace<TriplexSession>;
  readonly MCP_CALLS?: RateLimit;
}

const demoTools: Tool[] = [
  {
    name: "tour",
    description:
      "Start here. The story already loaded in this session's database and the questions worth asking it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "reset",
    description: "Delete everything in this session's database and load the starting story again.",
    inputSchema: { type: "object", properties: {} },
  },
];

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "content-type, accept, mcp-session-id, mcp-protocol-version, authorization",
  "access-control-expose-headers": "mcp-session-id",
};
const rpcError = (status: number, message: string) =>
  Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
    { status, headers: corsHeaders },
  );

/** True when a request to /mcp is for the MCP server rather than the docs page. */
const isMcpRequest = (request: Request) =>
  request.method === "GET" || request.method === "HEAD"
    ? request.headers.get("accept")?.includes("text/event-stream") === true
    : true;

const handleMcp = async (request: Request, env: Env): Promise<Response> => {
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });
  // Each POST is answered with JSON; there is no server-to-client stream.
  if (request.method === "GET" || request.method === "HEAD")
    return new Response(null, {
      status: 405,
      headers: { ...corsHeaders, allow: "POST, DELETE, OPTIONS" },
    });
  if (
    env.MCP_CALLS &&
    !(await env.MCP_CALLS.limit({ key: request.headers.get("cf-connecting-ip") ?? "anonymous" }))
      .success
  )
    return rpcError(429, "Too many requests to triplex.build/mcp; wait a minute and try again.");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY)
    return rpcError(413, `Requests to triplex.build/mcp are limited to ${MAX_BODY} bytes.`);

  // The server names sessions and keeps each in a Durable Object, so the
  // transport is stateless and any Worker instance can answer.
  const sessionId = request.headers.get("mcp-session-id") ?? crypto.randomUUID();
  const session = env.SESSIONS.getByName(sessionId);
  if (request.method === "DELETE") {
    await session.destroy();
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") return rpcError(405, "Use POST.");

  const server = new Server(
    { name: "triplex", version: VERSION },
    { capabilities: { tools: {} }, instructions },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...demoTools, ...((await session.tools()) as Tool[])],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name === "tour") return { content: [{ type: "text" as const, text: tour }] };
    if (params.name === "reset") {
      await session.reset();
      return {
        content: [{ type: "text" as const, text: "The database holds the starting story again." }],
      };
    }
    return (await session.call(params.name, params.arguments ?? {})) as CallToolResult;
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries({ ...corsHeaders, "mcp-session-id": sessionId }))
    headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if ((pathname === "/mcp" || pathname === "/mcp/") && isMcpRequest(request))
      return handleMcp(request, env);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

type Client = McpTest.Client;
interface Open {
  readonly runtime: ManagedRuntime.ManagedRuntime<never, unknown>;
  readonly scope: Scope.Closeable;
  readonly client: Client;
}

/** One MCP session's database: Triplex's KV hexastore on this object's SQLite storage. */
export class TriplexSession extends DurableObject<Env> {
  #open: Promise<Open> | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  #serial<A>(work: () => Promise<A>): Promise<A> {
    // Calls run one at a time; Triplex commits are serialized anyway.
    const next = this.#queue.then(work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #connect(): Promise<Open> {
    return (this.#open ??= (async () => {
      const storage = this.ctx.storage;
      const database = ConfigStore.layer.pipe(
        Layer.provideMerge(
          Runtime.fromKv({
            name: "durable-object-kv",
            backend: durableObjectKvLayer(storage),
          }).layer({
            scope: DatabaseScope.make({
              env: "triplex.build",
              tenant: "mcp",
              database: this.ctx.id.toString(),
              generation: (await storage.get<number>("generation")) ?? 0,
            }),
            capabilities: Capabilities.none,
          }),
        ),
      );
      const runtime = ManagedRuntime.make(database) as unknown as ManagedRuntime.ManagedRuntime<
        never,
        unknown
      >;
      if (!(await storage.get<boolean>("seeded"))) {
        await runtime.runPromise(seed as Effect.Effect<void, unknown, never>);
        await storage.put("seeded", true);
      }
      const scope = await runtime.runPromise(Scope.make());
      const client = await runtime.runPromise(
        McpTest.makeClient(registrations, { protocols: [McpProtocol.v2025_11_25] }).pipe(
          Scope.provide(scope),
        ) as Effect.Effect<Client, unknown, never>,
      );
      return { runtime, scope, client };
    })());
  }

  async #close(): Promise<void> {
    const open = await this.#open?.catch(() => undefined);
    this.#open = undefined;
    if (open === undefined) return;
    await open.runtime.runPromise(Scope.close(open.scope, Exit.void));
    await open.runtime.dispose();
  }

  tools(): Promise<unknown[]> {
    return this.#serial(async () => {
      const { runtime, client } = await this.#connect();
      return JSON.parse(JSON.stringify((await runtime.runPromise(client.listTools())).tools));
    });
  }

  call(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.#serial(async () => {
      const { runtime, client } = await this.#connect();
      const write = name === "transaction_apply";
      if (write && this.ctx.storage.sql.databaseSize > MAX_DATABASE_BYTES) {
        const text = "This demo database is full. Call reset to start over.";
        return { content: [{ type: "text", text }], isError: true };
      }
      const result = await runtime.runPromise(client.callTool({ name, arguments: args }));
      await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
      // A plain object crosses the RPC boundary.
      return JSON.parse(JSON.stringify(result));
    });
  }

  reset(): Promise<void> {
    return this.#serial(async () => {
      const generation = ((await this.ctx.storage.get<number>("generation")) ?? 0) + 1;
      await this.#close();
      await this.ctx.storage.deleteAll();
      // A new generation invalidates cursors handed out before the reset.
      await this.ctx.storage.put("generation", generation);
      await this.#connect();
      await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    });
  }

  destroy(): Promise<void> {
    return this.#serial(async () => {
      await this.#close();
      await this.ctx.storage.deleteAll();
    });
  }

  override async alarm(): Promise<void> {
    await this.destroy();
  }
}
