import { Attribute, ConfigNode, ConfigStore, EntityType } from "@triplex-internal/core/config";
import { Triples } from "@triplex-internal/core";
import * as Derivation from "@triplex-internal/core/derivation";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";
import { Effect, Layer } from "effect";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { assertBuiltCliIsFresh, cliArgs } from "./builtCli.js";

const exec = promisify(execFile);
beforeAll(assertBuiltCliIsFresh);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), "triplex-describe-"));
  directories.push(directory);
  const filename = join(directory, "app.db");
  const layer = ConfigStore.layer.pipe(Layer.provideMerge(SqliteTriples.layer({ filename })));
  const cli = async (...args: string[]) => {
    const { stdout } = await exec(process.execPath, cliArgs(["--sqlite", filename, ...args]));
    return JSON.parse(stdout);
  };
  return { directory, layer, cli };
};

const Site = EntityType.make("Site", {
  name: Attribute.text(":site/name").required({ unique: true }),
});
const Worker = EntityType.make("Worker", {
  site: Attribute.ref(":worker/site", Site).required(),
  roles: Attribute.enumOf(":worker/role", ["inspector", "operator"]).required({
    cardinality: "many",
  }),
  secret: Attribute.sensitive(Attribute.text(":worker/secret")),
  count: Attribute.integer(":worker/count").required(),
  enabled: Attribute.boolean(":worker/enabled").required(),
  date: Attribute.date(":worker/date").required(),
  instant: Attribute.instant(":worker/instant").required(),
  score: Attribute.number(":worker/score").required(),
});

const publish = Effect.gen(function* () {
  const config = yield* ConfigStore.ConfigStore;
  const unused = yield* Attribute.text(":unused/text").node;
  const policy = yield* ConfigNode.make({ kind: "policy", key: "work/safety", attrs: {} });
  return yield* config.commit({
    label: "production",
    ref: "live",
    objects: [...(yield* EntityType.nodesOf(Site, Worker)), unused, policy],
  });
});

// Each case spawns the built CLI several times; leave headroom for a loaded parallel run.
describe("describe release schema", { timeout: 120_000 }, () => {
  it("describes the persisted release graph and retains the command manifest", async () => {
    const { layer, cli } = await setup();
    const release = await Effect.runPromise(publish.pipe(Effect.provide(layer)));
    const output = await cli("describe");
    expect(output).toMatchObject({
      ok: true,
      command: "describe",
      data: { commands: { transaction: ["apply", "preview"] } },
    });
    const schema = output.data.schema;
    expect(schema.release).toEqual({
      id: release.snapshot.id,
      label: "production",
      rootContentId: release.snapshot.rootCid,
      ref: "live",
    });
    expect(schema.entityTypes.map((type: { name: string }) => type.name)).toEqual([
      "Site",
      "Worker",
    ]);
    expect(schema.entityTypes[0].attributes).toEqual([
      {
        key: ":site/name",
        valueType: { _tag: "Prim", v: 1, prim: "text" },
        required: true,
        cardinality: "one",
        unique: true,
        referenceTarget: null,
        sensitive: false,
      },
    ]);
    expect(schema.entityTypes[1].attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: ":worker/site", required: true, referenceTarget: "Site" }),
        expect.objectContaining({
          key: ":worker/role",
          cardinality: "many",
          valueType: { _tag: "Enum", v: 1, values: ["inspector", "operator"] },
        }),
        expect.objectContaining({ key: ":worker/secret", required: false, sensitive: true }),
      ]),
    );
    expect(schema.attributes).toContainEqual({
      key: ":unused/text",
      valueType: { _tag: "Prim", v: 1, prim: "text" },
    });
    expect(schema.constraints).toEqual(
      expect.arrayContaining([
        { key: "Site::site/name:unique", kind: "Unique" },
        expect.objectContaining({ kind: "ReferenceTarget" }),
      ]),
    );
    expect(schema.derivations).toContainEqual({ kind: "policy", key: "work/safety" });
    expect(schema.rules).toHaveLength(5);
  });

  it("explains retractions and past state, and previews without writing", async () => {
    const { directory, layer, cli } = await setup();
    await Effect.runPromise(publish.pipe(Effect.provide(layer)));
    const described = (await cli("describe")).data;
    const example = described.schema.examples.find(
      (e: { entityType: string }) => e.entityType === "Site",
    );
    const request = JSON.parse(
      JSON.stringify(example.input)
        .replaceAll("<entity-id of Site>", "site:preview")
        .replaceAll("<text>", "Preview")
        .replaceAll("<actor>", "agent:test")
        .replaceAll("<command-id for Site>", "preview-site"),
    );
    for (const op of request.operations) op.validFrom = 1;
    const path = join(directory, "preview.json");
    await writeFile(path, JSON.stringify(request));
    const position = (await cli("status")).data.position;
    const preview = (await cli("transaction", "preview", "--input", path)).data;
    expect(preview.violations).toEqual([]);
    expect((await cli("status")).data.position).toBe(position);
    const applied = (await cli("transaction", "apply", "--input", path)).data;
    const receipt = (await cli("journal", "receipt", "preview-site")).data.transaction;
    expect(
      receipt.changes.map(
        ({ tripleId: _id, recordedAt: _at, assertionTxId: _tx, ...c }: Record<string, unknown>) =>
          c,
      ),
    ).toEqual(preview.changes);
    const repeated = (await cli("transaction", "preview", "--input", path)).data;
    expect(repeated.commandAlreadyCommitted.position).toBe(applied.position);
    request.meta.commandId = "duplicate-preview";
    for (const op of request.operations) op.entityId = "site:duplicate";
    await writeFile(path, JSON.stringify(request));
    expect(
      (await cli("transaction", "preview", "--input", path)).data.violations.length,
    ).toBeGreaterThan(0);
    expect((await cli("status")).data.position).toBe(applied.position);
    const candidateInput = await Effect.runPromise(
      Effect.gen(function* () {
        const triples = yield* Triples;
        const definition = yield* Derivation.make({
          name: "sites",
          query: { find: ["?e", "?name"], where: [["?e", ":site/name", "?name"]] },
          identity: ["?e"],
          configSnapshot: request.meta.configSnapshot,
        });
        const basis = { validAt: 2, recordedPosition: applied.position };
        const evaluated = yield* Derivation.evaluate(triples, definition, { basis });
        const candidate = evaluated.candidates[0]!;
        return {
          subject: {
            kind: "candidate",
            definition,
            candidateId: candidate.id,
            revision: candidate.revision,
          },
          basis,
        };
      }).pipe(Effect.provide(layer)),
    );
    await writeFile(path, JSON.stringify(candidateInput));
    const candidateWhy = (await cli("why", "candidate", "--input", path)).data;
    expect(candidateWhy.derivation.candidate.id).toBe(candidateInput.subject.candidateId);
    expect(candidateWhy.subject).not.toHaveProperty("definition");
    const id = applied.asserted[0].id;
    await writeFile(
      path,
      JSON.stringify({
        operations: [{ op: "retract", id }],
        meta: { actor: "agent:test", commandId: "retract-site" },
      }),
    );
    const retracted = (await cli("transaction", "apply", "--input", path)).data;
    const why = (await cli("why", "fact", id)).data;
    expect(why.facts[0]).toMatchObject({ visible: false, retraction: retracted.transactionId });
    expect(why.transactions).toEqual(
      expect.arrayContaining([expect.objectContaining({ commandId: "retract-site" })]),
    );
    const past = (
      await cli(
        "why",
        "entity",
        "site:preview",
        "--recorded-position",
        String(applied.position),
        "--valid-at",
        "2",
      )
    ).data;
    expect(past.facts).toHaveLength(1);
    expect(past.facts[0]).toMatchObject({ visible: true, retraction: null });
    expect(
      (
        await cli(
          "why",
          "attribute",
          "site:preview",
          ":site/name",
          "--recorded-position",
          String(applied.position),
          "--valid-at",
          "2",
        )
      ).data.facts,
    ).toEqual(past.facts);
  });

  it("generates wire inputs that apply under the pinned release's enforcement", async () => {
    const { directory, layer, cli } = await setup();
    const release = await Effect.runPromise(publish.pipe(Effect.provide(layer)));
    const {
      data: { schema },
    } = await cli("describe");
    for (const example of schema.examples) {
      expect(example.input.meta).toMatchObject({
        actor: expect.any(String),
        commandId: expect.any(String),
        configSnapshot: release.snapshot.id,
        enforce: { constraints: expect.any(Array) },
      });
      expect(example.input.operations.length).toBeGreaterThan(0);
      for (const operation of example.input.operations)
        expect(operation.entityType).toBe(example.entityType);
      const input = JSON.stringify(example.input)
        .replaceAll("<entity-id of Site>", "site:example")
        .replaceAll("<entity-id of Worker>", "worker:example")
        .replaceAll("<text>", "Example")
        .replaceAll("<actor>", "agent:test")
        .replaceAll(
          `<command-id for ${example.entityType}>`,
          `describe/create-${example.entityType}`,
        );
      const path = join(directory, `${example.entityType}.json`);
      await writeFile(path, input);
      const result = await cli("transaction", "apply", "--input", path);
      expect(result.ok).toBe(true);
      expect(result.data.asserted).toHaveLength(example.input.operations.length);
    }
  });

  it("returns a publishing hint when the ref has no release", async () => {
    const { cli } = await setup();
    expect((await cli("describe")).data).toMatchObject({
      schema: null,
      hint: expect.stringContaining("config.commit"),
    });
  });

  it("reads a different ref with --ref", async () => {
    const { layer, cli } = await setup();
    await Effect.runPromise(publish.pipe(Effect.provide(layer)));
    const alternate = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ConfigStore.ConfigStore;
        return yield* config.commit({
          label: "preview",
          objects: yield* Site.nodes,
          ref: "preview",
        });
      }).pipe(Effect.provide(layer)),
    );
    const { data } = await cli("describe", "--ref", "preview");
    expect(data.schema.release).toMatchObject({
      id: alternate.snapshot.id,
      ref: "preview",
      label: "preview",
    });
    expect(data.schema.entityTypes.map((type: { name: string }) => type.name)).toEqual(["Site"]);
    expect((await cli("describe", "--ref", "missing")).data.schema).toBeNull();
  });
});
