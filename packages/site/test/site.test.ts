import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { makeTriplesConformanceSuite } from "@triplex-build/triplex-testkit";
import { Capabilities, DatabaseScope, Runtime } from "@triplex-build/triplex/runtime";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { durableObjectKvLayer } from "../src/kv.js";

const MAR_2 = Date.UTC(2026, 2, 2);

const session = () => {
  let id: string | null = null;
  let n = 0;
  const rpc = async (method: string, params: unknown) => {
    const response = await exports.default.fetch(
      new Request("https://triplex.build/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(id === null ? {} : { "mcp-session-id": id }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
      }),
    );
    id ??= response.headers.get("mcp-session-id");
    return ((await response.json()) as { result: any }).result;
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await rpc("tools/call", { name, arguments: args });
    const text = result.content[0].text as string;
    return {
      isError: result.isError === true,
      data: text.startsWith("{") ? JSON.parse(text) : text,
    };
  };
  return { rpc, call };
};

describe("Durable Object KV backend", () => {
  it("passes the shared Triples contract on native Durable Object SQLite", async () => {
    await runInDurableObject(env.SESSIONS.getByName("conformance"), async (_instance, state) => {
      const runtime = Runtime.fromKv({
        name: "do-kv",
        backend: durableObjectKvLayer(state.storage),
      });
      await Effect.runPromise(
        makeTriplesConformanceSuite().pipe(
          Effect.provide(
            runtime.layer({
              scope: DatabaseScope.test("conformance"),
              capabilities: Capabilities.none,
            }),
          ),
          Effect.scoped,
        ) as Effect.Effect<void, unknown, never>,
      );
    });
  });
});

describe("triplex.build/mcp", () => {
  it("gives each session its own seeded database, with bitemporal reads, writes and reset", async () => {
    const a = session();
    const init = await a.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.serverInfo.name).toBe("triplex");
    const tools = (await a.rpc("tools/list", {})).tools.map((tool: { name: string }) => tool.name);
    expect(tools).toEqual(
      expect.arrayContaining(["tour", "reset", "describe", "why", "transaction_apply"]),
    );

    // As known now Maria was not trained on March 2; as known when she was placed, she was.
    const placed = (await a.call("journal_receipt", { commandId: "create:placement:maria-harbor" }))
      .data;
    const trained = async (basis: Record<string, number>) =>
      (await a.call("entity_get", { entityId: "worker:maria", basis })).data.facts.some(
        (fact: { attribute: string }) => fact.attribute === ":worker/trained-for",
      );
    expect(await trained({ validAt: MAR_2 })).toBe(false);
    expect(await trained({ validAt: MAR_2, recordedPosition: placed.transaction.position })).toBe(
      true,
    );

    // A write in one session is invisible to another, and reset removes it.
    const example = (await a.call("describe")).data.schema.examples.find(
      (e: { entityType: string }) => e.entityType === "Site",
    ).input;
    const write = JSON.parse(
      JSON.stringify(example)
        .replaceAll("<entity-id of Site>", "site:dock")
        .replaceAll("<text>", "Dock")
        .replaceAll("<actor>", "agent:test")
        .replaceAll("<command-id for Site>", "create:site:dock"),
    );
    expect((await a.call("transaction_apply", write)).isError).toBe(false);
    expect((await a.call("transaction_apply", write)).data.code).toBe(
      "transaction.command-already-committed",
    );
    const dock = async (s: ReturnType<typeof session>) =>
      (await s.call("entity_get", { entityId: "site:dock" })).data.facts.length;
    const b = session();
    await b.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "b", version: "1" },
    });
    expect(await dock(a)).toBeGreaterThan(0);
    expect(await dock(b)).toBe(0);
    await a.call("reset");
    expect(await dock(a)).toBe(0);
    expect((await a.call("journal_list")).data.transactions).toHaveLength(6);
  });
});
