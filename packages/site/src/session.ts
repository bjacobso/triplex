/**
 * One MCP session's Durable Object: Triplex's KV hexastore on this object's
 * SQLite storage, served directly by Effect's Streamable HTTP `McpServer`.
 *
 * Effect's stateful HTTP MCP server keeps negotiated session state in memory.
 * To survive Durable Object eviction without dropping the client's session, we
 * persist the client's `initialize` request in storage and replay it into a
 * fresh `McpServer` on wake, translating between the external session ID
 * (which addresses this object) and the server's internal session ID.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect, Exit, Scope, Semaphore } from "effect";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http";

import type { SessionHandle } from "./runtime.ts";

export const MAX_BODY = 64_000;
const MAX_DATABASE_BYTES = 25_000_000;
const IDLE_MS = 24 * 60 * 60 * 1000;
const MCP_URL = "https://triplex.build/mcp";

interface SavedInit {
  readonly body: string;
  readonly protocolVersion: string | undefined;
  readonly initialized: boolean;
}

const parseJson = (text: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const mcpPostRequest = (body: string, headers: Readonly<Record<string, string>>) =>
  HttpServerRequest.fromWeb(
    new Request(MCP_URL, {
      method: "POST",
      headers,
      body,
    }),
  );

export class TriplexSession extends Cloudflare.Workers.DurableObject<TriplexSession>()(
  "TriplexSession",
  Effect.gen(function* () {
    const state = yield* Cloudflare.Workers.DurableObjectState;

    return Effect.gen(function* () {
      const runtimeContext = yield* RuntimeContext;
      const { buildSessionHandle } = yield* Effect.promise(() => import("./runtime.ts"));
      const mutex = Semaphore.makeUnsafe(1);
      let active: SessionHandle | undefined;
      let pendingClose: SessionHandle | undefined;

      const closeHandle = (handle: SessionHandle | undefined) =>
        handle === undefined ? Effect.void : Scope.close(handle.scope, Exit.void);

      const dispatch = (
        handle: SessionHandle,
        request: HttpServerRequest.HttpServerRequest,
      ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
        Effect.gen(function* () {
          let handled: HttpServerResponse.HttpServerResponse | undefined;
          yield* HttpEffect.toHandled(handle.httpEffect, (_req, response) =>
            Effect.sync(() => {
              handled = response;
            }),
          ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request));
          return (
            handled ??
            HttpServerResponse.jsonUnsafe(
              { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null },
              { status: 500 },
            )
          );
        });

      const replayInit = (handle: SessionHandle, saved: SavedInit) =>
        Effect.gen(function* () {
          const initResponse = yield* dispatch(
            handle,
            mcpPostRequest(saved.body, {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            }),
          );
          const innerId = initResponse.headers["mcp-session-id"];
          if (innerId === undefined) return;
          handle.innerSessionId = innerId;
          if (saved.initialized) {
            const headers: Record<string, string> = {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-session-id": innerId,
            };
            if (saved.protocolVersion !== undefined) {
              headers["mcp-protocol-version"] = saved.protocolVersion;
            }
            yield* dispatch(
              handle,
              mcpPostRequest(
                JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
                headers,
              ),
            );
          }
        });

      const buildSession: Effect.Effect<SessionHandle, never, RuntimeContext> = Effect.suspend(() =>
        buildSessionHandle({ state, runtimeContext, onReset: resetSession }),
      );

      const resetSession: Effect.Effect<void, never, RuntimeContext> = Effect.gen(function* () {
        const previous = active;
        const generation = ((yield* state.storage.get<number>("generation")) ?? 0) + 1;
        const savedInit = yield* state.storage.get<SavedInit>("mcp_init");
        yield* state.storage.deleteAll();
        // A new generation invalidates pagination cursors handed out before the reset.
        yield* state.storage.put("generation", generation);
        if (savedInit !== undefined) {
          yield* state.storage.put("mcp_init", savedInit);
        }
        const fresh = yield* buildSession;
        if (savedInit !== undefined) {
          yield* replayInit(fresh, savedInit);
        }
        active = fresh;
        // Close the previous McpServer after its `reset` response finishes sending.
        pendingClose = previous;
        yield* state.storage.setAlarm(Date.now() + IDLE_MS);
      });

      const destroySession: Effect.Effect<void, never, RuntimeContext> = Effect.gen(function* () {
        const current = active;
        active = undefined;
        yield* closeHandle(current);
        yield* state.storage.deleteAll();
      });

      return {
        fetch: mutex.withPermit(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;

            if (request.method === "DELETE") {
              yield* destroySession;
              return HttpServerResponse.empty({ status: 204 });
            }

            if (request.method !== "POST") {
              return HttpServerResponse.jsonUnsafe(
                { jsonrpc: "2.0", error: { code: -32000, message: "Use POST." }, id: null },
                { status: 405, headers: { allow: "POST, DELETE, OPTIONS" } },
              );
            }

            const bodyText = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
            if (new TextEncoder().encode(bodyText).byteLength > MAX_BODY) {
              return HttpServerResponse.jsonUnsafe(
                {
                  jsonrpc: "2.0",
                  error: {
                    code: -32000,
                    message: `Requests to triplex.build/mcp are limited to ${MAX_BODY} bytes.`,
                  },
                  id: null,
                },
                { status: 413 },
              );
            }

            const parsed = parseJson(bodyText);
            const isInitialize =
              parsed?.["jsonrpc"] === "2.0" &&
              parsed["method"] === "initialize" &&
              (typeof parsed["id"] === "string" || typeof parsed["id"] === "number");

            if (
              parsed?.["method"] === "tools/call" &&
              typeof parsed["params"] === "object" &&
              parsed["params"] !== null &&
              (parsed["params"] as Record<string, unknown>)["name"] === "transaction_apply" &&
              state.raw.storage.sql.databaseSize > MAX_DATABASE_BYTES
            ) {
              return HttpServerResponse.jsonUnsafe({
                jsonrpc: "2.0",
                id: parsed["id"] ?? null,
                result: {
                  content: [
                    { type: "text", text: "This demo database is full. Call reset to start over." },
                  ],
                  isError: true,
                },
              });
            }

            const savedInit = isInitialize
              ? undefined
              : yield* state.storage.get<SavedInit>("mcp_init");
            if (!isInitialize && active === undefined && savedInit === undefined) {
              return HttpServerResponse.empty({ status: 404 });
            }

            const handle = active ?? (active = yield* buildSession);
            if (!isInitialize && handle.innerSessionId === undefined && savedInit !== undefined) {
              yield* replayInit(handle, savedInit);
            }

            // Forward to McpServer with Origin stripped (CORS is enforced at the Worker edge)
            // and the external session ID translated to McpServer's internal session ID.
            const forwardHeaders: Record<string, string> = {};
            for (const [name, value] of Object.entries(request.headers)) {
              const lower = name.toLowerCase();
              if (lower === "origin" || lower === "mcp-session-id" || lower === "content-length") {
                continue;
              }
              forwardHeaders[lower] = value;
            }
            if (!isInitialize && handle.innerSessionId !== undefined) {
              forwardHeaders["mcp-session-id"] = handle.innerSessionId;
            }

            const response = yield* dispatch(handle, mcpPostRequest(bodyText, forwardHeaders));

            if (isInitialize && response.status < 400) {
              const innerId = response.headers["mcp-session-id"];
              if (innerId !== undefined) {
                handle.innerSessionId = innerId;
                yield* state.storage.put("mcp_init", {
                  body: bodyText,
                  protocolVersion: response.headers["mcp-protocol-version"],
                  initialized: false,
                } satisfies SavedInit);
              }
            } else if (
              parsed?.["method"] === "notifications/initialized" &&
              response.status < 400 &&
              savedInit !== undefined &&
              !savedInit.initialized
            ) {
              yield* state.storage.put("mcp_init", {
                ...savedInit,
                initialized: true,
              } satisfies SavedInit);
            }

            if (pendingClose !== undefined) {
              const stale = pendingClose;
              pendingClose = undefined;
              yield* closeHandle(stale);
            }

            yield* state.storage.setAlarm(Date.now() + IDLE_MS);
            return response;
          }),
        ),

        alarm: () => mutex.withPermit(destroySession),
      };
    });
  }),
) {}
