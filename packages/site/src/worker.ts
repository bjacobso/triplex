/**
 * The triplex.build Effect Worker. Browsers get the documentation from static
 * assets; MCP clients that POST to /mcp get a hosted Triplex MCP server
 * (Streamable HTTP) backed by one Effect Durable Object (`TriplexSession`) per
 * MCP session.
 */
import type { Fetcher } from "@cloudflare/workers-types";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect } from "effect";
import { Headers, HttpServerRequest, HttpServerResponse } from "effect/http";

import { MAX_BODY, TriplexSession } from "./session.ts";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "content-type, accept, mcp-session-id, mcp-protocol-version, authorization",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
} as const;

const rpcError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
    { status, headers: corsHeaders },
  );

/** True when a request to /mcp is for the MCP server rather than the docs page. */
const isMcpRequest = (request: HttpServerRequest.HttpServerRequest) =>
  request.method === "GET" || request.method === "HEAD"
    ? request.headers["accept"]?.includes("text/event-stream") === true
    : true;

export const siteWorker = Effect.gen(function* () {
  const sessions = yield* TriplexSession;
  const rateLimit = yield* Cloudflare.Workers.RateLimit("MCP_CALLS", {
    namespaceId: 2001,
    simple: { limit: 120, period: 60 },
  });
  const env = yield* Cloudflare.Workers.WorkerEnvironment;

  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "https://triplex.build");
      const isMcpPath = url.pathname === "/mcp" || url.pathname === "/mcp/";

      if (!isMcpPath || !isMcpRequest(request)) {
        const assets = env["ASSETS"] as Fetcher | undefined;
        if (assets === undefined) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        return yield* Cloudflare.fromCloudflareFetcher(assets).fetch(request).pipe(Effect.orDie);
      }

      if (request.method === "OPTIONS") {
        return HttpServerResponse.empty({ status: 204, headers: corsHeaders });
      }
      // Each POST is answered with JSON; there is no server-to-client stream.
      if (request.method === "GET" || request.method === "HEAD") {
        return HttpServerResponse.empty({
          status: 405,
          headers: { ...corsHeaders, allow: "POST, DELETE, OPTIONS" },
        });
      }

      const clientIp = request.headers["cf-connecting-ip"] ?? "anonymous";
      const allowed = yield* rateLimit.limit({ key: clientIp }).pipe(
        Effect.map((result) => result.success),
        Effect.orElseSucceed(() => true),
      );
      if (!allowed) {
        return rpcError(
          429,
          "Too many requests to triplex.build/mcp; wait a minute and try again.",
        );
      }

      if (Number(request.headers["content-length"] ?? 0) > MAX_BODY) {
        return rpcError(413, `Requests to triplex.build/mcp are limited to ${MAX_BODY} bytes.`);
      }

      const incomingSessionId = request.headers["mcp-session-id"];
      if (request.method === "DELETE") {
        if (incomingSessionId !== undefined) {
          yield* sessions.getByName(incomingSessionId).fetch(request).pipe(Effect.orDie);
        }
        return HttpServerResponse.empty({ status: 204, headers: corsHeaders });
      }
      if (request.method !== "POST") {
        return rpcError(405, "Use POST.");
      }

      const sessionId = incomingSessionId ?? crypto.randomUUID();
      const response = yield* sessions.getByName(sessionId).fetch(request).pipe(Effect.orDie);
      const headers =
        response.status < 400 ? { ...corsHeaders, "mcp-session-id": sessionId } : corsHeaders;
      return response.pipe(HttpServerResponse.setHeaders(Headers.fromInput(headers)));
    }),
  };
}).pipe(Effect.provide(Cloudflare.Workers.RateLimitBinding));

export default Cloudflare.Workers.Worker("Docs", { main: import.meta.url }, siteWorker);
