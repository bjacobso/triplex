import * as Alchemy from "alchemy";
import * as State from "alchemy/State";
import * as Test from "alchemy/Test/Vitest";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { workspaceAliases } from "../../../vitest.workspace-aliases.ts";
import { siteWorker } from "../src/worker.ts";
import { conformanceWorker } from "./conformance-worker.ts";

const MAR_2 = Date.UTC(2026, 2, 2);

const workspaceAlias = Object.fromEntries(
  workspaceAliases().map(({ find, replacement }) => [
    `${find.source.slice(1, -1).replaceAll("\\/", "/")}$`,
    replacement,
  ]),
);

const compatibility = { date: "2026-09-06", flags: ["nodejs_compat"] };
const build = { input: { resolve: { alias: workspaceAlias } } };

const SiteTestStack = Alchemy.Stack(
  "triplex-site-test",
  { providers: Cloudflare.providers(), state: State.inMemoryState() },
  Effect.gen(function* () {
    const site = yield* Cloudflare.Workers.Worker(
      "Site",
      {
        main: new URL("../src/worker.ts", import.meta.url).pathname,
        compatibility,
        build,
      },
      siteWorker,
    );
    const conformance = yield* Cloudflare.Workers.Worker(
      "Conformance",
      {
        main: new URL("./conformance-worker.ts", import.meta.url).pathname,
        compatibility,
        build,
      },
      conformanceWorker,
    );
    return {
      siteUrl: site.url,
      conformanceUrl: conformance.url,
    };
  }),
);

const { test, deploy, destroy, beforeAll, afterAll } = Test.make({
  providers: Cloudflare.providers(),
  state: State.inMemoryState(),
  dev: true,
  sidecar: false,
  stage: `site-test-${process.pid}`,
});

const createClient = (baseUrl: string) => {
  const endpoint = new URL("/mcp", baseUrl).toString();
  let sessionId: string | null = null;
  let id = 0;

  const post = async (
    method: string,
    params: unknown,
    extraHeaders: Record<string, string> = {},
  ) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
        ...extraHeaders,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (response.status < 400) {
      sessionId ??= response.headers.get("mcp-session-id");
    }
    return response;
  };

  const rpc = async (
    method: string,
    params: unknown,
    extraHeaders: Record<string, string> = {},
  ) => {
    const response = await post(method, params, extraHeaders);
    expect(response.status).toBe(200);
    return ((await response.json()) as { result: any }).result;
  };

  const notify = async (method: string) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method }),
    });
    expect(response.status).toBe(202);
  };

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await rpc("tools/call", { name, arguments: args });
    const text = result.content[0].text as string;
    return {
      isError: result.isError === true,
      data: text.startsWith("{") ? JSON.parse(text) : text,
    };
  };

  const close = () =>
    fetch(endpoint, {
      method: "DELETE",
      headers: sessionId === null ? {} : { "mcp-session-id": sessionId },
    });

  return {
    get sessionId() {
      return sessionId;
    },
    post,
    rpc,
    notify,
    call,
    close,
  };
};

describe("triplex.build Effect Worker and Durable Object", () => {
  const deployed = beforeAll(deploy(SiteTestStack));
  afterAll(destroy(SiteTestStack));

  test(
    "passes the shared Triples conformance suite on native Durable Object SQLite",
    Effect.gen(function* () {
      const { conformanceUrl } = yield* deployed;
      const response = yield* Effect.promise(() => fetch(conformanceUrl!));
      const body = yield* Effect.promise(() => response.text());
      expect(response.status, body).toBe(200);
      expect(body).toBe("ok");
    }),
  );

  test(
    "gives each MCP session its own seeded database, with bitemporal reads, writes, isolation, reset and delete",
    Effect.gen(function* () {
      const { siteUrl } = yield* deployed;
      const endpoint = new URL("/mcp", siteUrl!).toString();

      // CORS preflight and unknown session handling.
      const preflight = yield* Effect.promise(() => fetch(endpoint, { method: "OPTIONS" }));
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");

      const missing = yield* Effect.promise(() =>
        fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-session-id": "nonexistent-session",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        }),
      );
      expect(missing.status).toBe(404);

      // Initialize session A (including a browser Origin header).
      const a = createClient(siteUrl!);
      const init = yield* Effect.promise(() =>
        a.rpc(
          "initialize",
          {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
          { origin: "http://localhost:6274" },
        ),
      );
      expect(init.serverInfo.name).toBe("triplex");
      yield* Effect.promise(() => a.notify("notifications/initialized"));

      const tools = (yield* Effect.promise(() => a.rpc("tools/list", {}))).tools.map(
        (tool: { name: string }) => tool.name,
      );
      expect(tools).toEqual(
        expect.arrayContaining(["tour", "reset", "describe", "why", "transaction_apply"]),
      );

      const tourResult = yield* Effect.promise(() => a.call("tour"));
      expect(tourResult.isError).toBe(false);
      expect(tourResult.data).toMatch(/^# Triplex tour/);

      // As known now Maria was not trained on March 2; as known when she was placed, she was.
      const placed = (yield* Effect.promise(() =>
        a.call("journal_receipt", { commandId: "create:placement:maria-harbor" }),
      )).data;
      const trained = (basis: Record<string, number>) =>
        a
          .call("entity_get", { entityId: "worker:maria", basis })
          .then((r) =>
            r.data.facts.some(
              (fact: { attribute: string }) => fact.attribute === ":worker/trained-for",
            ),
          );
      expect(yield* Effect.promise(() => trained({ validAt: MAR_2 }))).toBe(false);
      expect(
        yield* Effect.promise(() =>
          trained({ validAt: MAR_2, recordedPosition: placed.transaction.position }),
        ),
      ).toBe(true);

      // A write in one session is invisible to another, duplicate commandId is rejected, and reset clears it.
      const described = (yield* Effect.promise(() => a.call("describe"))).data;
      const example = described.schema.examples.find(
        (e: { entityType: string }) => e.entityType === "Site",
      ).input;
      const write = JSON.parse(
        JSON.stringify(example)
          .replaceAll("<entity-id of Site>", "site:dock")
          .replaceAll("<text>", "Dock")
          .replaceAll("<actor>", "agent:test")
          .replaceAll("<command-id for Site>", "create:site:dock"),
      );
      expect((yield* Effect.promise(() => a.call("transaction_apply", write))).isError).toBe(false);
      expect((yield* Effect.promise(() => a.call("transaction_apply", write))).data.code).toBe(
        "transaction.command-already-committed",
      );

      const dockCount = (client: ReturnType<typeof createClient>) =>
        client
          .call("entity_get", { entityId: "site:dock" })
          .then((r) => (r.data.facts as unknown[]).length);

      const b = createClient(siteUrl!);
      yield* Effect.promise(() =>
        b.rpc("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "b", version: "1" },
        }),
      );
      expect(yield* Effect.promise(() => dockCount(a))).toBeGreaterThan(0);
      expect(yield* Effect.promise(() => dockCount(b))).toBe(0);

      // Reset wipes session A's write and keeps its MCP session usable.
      const resetResult = yield* Effect.promise(() => a.call("reset"));
      expect(resetResult.isError).toBe(false);
      expect(yield* Effect.promise(() => dockCount(a))).toBe(0);
      expect((yield* Effect.promise(() => a.call("journal_list"))).data.transactions).toHaveLength(
        6,
      );

      // DELETE ends session A; further calls get 404.
      const deleted = yield* Effect.promise(() => a.close());
      expect(deleted.status).toBe(204);
      const afterDelete = yield* Effect.promise(() => a.post("tools/list", {}));
      expect(afterDelete.status).toBe(404);
    }),
  );
});
