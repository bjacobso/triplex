import { Attribute, ConfigStore, EntityType } from "@triplex-build/triplex/config";
import { KeyProvider, Sensitive, ValueCodec } from "@triplex-build/triplex/sensitive";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";
import { Effect, Layer } from "effect";
import { McpProtocol, McpTest } from "effect/ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { EntityId } from "@triplex-build/triplex";
import { execute } from "@triplex-build/triplex-cli";
import { registrations } from "../src/index.js";

const Site = EntityType.make("Site", {
  name: Attribute.text(":site/name").required({ unique: true }),
});
const Worker = EntityType.make("Worker", {
  site: Attribute.ref(":worker/site", Site).required(),
});
const Secret = Attribute.sensitive(Attribute.text(":worker/secret"));

it("serves the agent workflow, diagnostics, validation and redacted reads over MCP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "triplex-mcp-"));
  try {
    const database = ConfigStore.layer.pipe(
      Layer.provideMerge(
        Sensitive.layer({ database: "mcp-test", attributes: [Secret] }).pipe(
          Layer.provide(ValueCodec.aesGcm),
          Layer.provide(KeyProvider.test({ seed: "mcp-test" })),
          Layer.provide(SqliteTriples.layer({ filename: join(directory, "app.db") })),
        ),
      ),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ConfigStore.ConfigStore;
        yield* config.commit({
          label: "test",
          ref: "live",
          objects: yield* EntityType.nodesOf(Site, Worker),
        });
        const client = yield* McpTest.makeClient(registrations, {
          protocols: [McpProtocol.v2025_11_25],
        });
        const tools = yield* client.listTools();
        expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
          "config_release",
          "describe",
          "entity_facts",
          "entity_get",
          "entity_history",
          "entity_types",
          "fact_match",
          "journal_list",
          "journal_receipt",
          "query_explain",
          "query_page",
          "query_run",
          "status",
          "transaction_apply",
          "transaction_preview",
          "why",
        ]);
        for (const tool of tools.tools) expect(tool.inputSchema.type).toBe("object");
        const call = Effect.fn(function* (name: string, args: Record<string, unknown> = {}) {
          const result = yield* client.callTool({ name, arguments: args });
          const content = result.content[0];
          if (content?.type !== "text") throw new Error("Expected JSON text content");
          return { ...result, data: JSON.parse(content.text) };
        });
        const described = yield* call("describe");
        expect(described.isError).toBe(false);
        expect(
          described.data.schema.entityTypes.map((type: { name: string }) => type.name),
        ).toEqual(["Site", "Worker"]);
        const requests: Record<string, Record<string, unknown>> = {};
        for (const example of described.data.schema.examples) {
          const request = JSON.parse(
            JSON.stringify(example.input)
              .replaceAll("<entity-id of Site>", "site:one")
              .replaceAll("<entity-id of Worker>", "worker:one")
              .replaceAll("<text>", "Main")
              .replaceAll("<actor>", "agent:test")
              .replaceAll(`<command-id for ${example.entityType}>`, `create-${example.entityType}`),
          );
          requests[example.entityType] = request;
          for (const op of request.operations) op.validFrom = 1;
          expect((yield* call("transaction_preview", request)).data).toEqual(
            yield* execute({ _tag: "transaction-preview", request }),
          );
          expect((yield* call("transaction_apply", request)).isError).toBe(false);
        }
        const entity = yield* call("entity_get", { entityId: "site:one" });
        expect(entity.data.facts[0].value).toEqual({ type: "string", value: "Main" });
        expect(entity.structuredContent).toEqual(entity.data);
        const joined = yield* call("query_run", {
          query: {
            find: ["?worker", "?name"],
            where: [
              ["?worker", ":worker/site", "?site"],
              ["?site", ":site/name", "?name"],
            ],
          },
        });
        expect(joined.isError).toBe(false);
        expect(JSON.stringify(joined.data)).toContain("Main");
        const badQuery = yield* call("query_run", {
          query: { find: ["?missing"], where: [["?e", ":site/name", "?name"]] },
        });
        expect(badQuery).toMatchObject({
          isError: true,
          data: { code: "datalog.unbound-variable", retryable: false },
        });
        const subject = { kind: "entity" as const, entityId: EntityId.make("site:one") };
        const whyBasis = { validAt: Date.now() };
        const explained = yield* call("why", { subject, basis: whyBasis });
        expect(explained.data).toEqual(yield* execute({ _tag: "why", subject, basis: whyBasis }));
        expect(explained.data.facts).toHaveLength(1);
        expect(
          yield* call("why", { subject: { kind: "fact", tripleId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" } }),
        ).toMatchObject({ isError: true, data: { code: "why.subject-not-found" } });
        expect(
          (yield* call("transaction_preview", requests["Site"]!)).data.commandAlreadyCommitted
            .commandId,
        ).toBe("create-Site");
        const duplicate = yield* call("transaction_apply", requests["Site"]!);
        expect(duplicate).toMatchObject({
          isError: true,
          data: { code: "transaction.command-already-committed", retryable: false },
        });
        const violation = JSON.parse(
          JSON.stringify(requests["Site"])
            .replaceAll("site:one", "site:two")
            .replaceAll("create-Site", "duplicate-name"),
        );
        const before = (yield* call("status")).data.position;
        expect(
          (yield* call("transaction_preview", violation)).data.violations.length,
        ).toBeGreaterThan(0);
        expect((yield* call("status")).data.position).toBe(before);
        expect(yield* call("transaction_apply", violation)).toMatchObject({
          isError: true,
          data: { code: "constraint.violation", retryable: false },
        });
        const invalid = yield* client.callTool({
          name: "transaction_apply",
          arguments: { operations: [], meta: { actor: "agent:test" } },
        });
        expect(invalid.isError).toBe(true);
        expect(JSON.stringify(invalid)).toContain("commandId");
        const missingActor = yield* client.callTool({
          name: "transaction_apply",
          arguments: { operations: [], meta: { commandId: "missing-actor" } },
        });
        expect(missingActor.isError).toBe(true);
        expect(JSON.stringify(missingActor)).toContain("actor");
        const planted = "MCP-SECRET-987-65-4321";
        const write = yield* call("transaction_apply", {
          operations: [
            {
              op: "assert",
              entityId: "worker:one",
              attribute: ":worker/secret",
              value: { type: "string", value: planted },
            },
          ],
          meta: { actor: "agent:test", commandId: "secret" },
        });
        expect(write.isError).toBe(false);
        const secretPreview = yield* call("transaction_preview", {
          operations: [
            {
              op: "assert",
              entityId: "worker:one",
              attribute: ":worker/secret",
              value: { type: "string", value: planted },
            },
          ],
          meta: { actor: "agent:test", commandId: "secret-preview" },
        });
        const secretWhy = yield* call("why", {
          subject: { kind: "entity", entityId: "worker:one" },
        });
        const outputs = [write, secretPreview, secretWhy];
        for (const name of ["entity_get", "entity_facts", "entity_history"])
          outputs.push(yield* call(name, { entityId: "worker:one" }));
        outputs.push(yield* call("journal_receipt", { commandId: "secret" }));
        outputs.push(yield* call("journal_list"));
        for (const output of outputs) {
          expect(JSON.stringify(output)).not.toContain(planted);
          expect(JSON.stringify(output)).not.toContain("ciphertext");
          expect(JSON.stringify(output)).not.toContain("blindIndex");
        }
        expect(JSON.stringify(outputs)).toContain('"sealed"');
      }).pipe(Effect.provide(database), Effect.scoped),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
