import { Attribute, ConfigNode, ConfigStore, EntityType } from "@triplex-build/triplex/config";
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
describe("describe release schema", { timeout: 30_000 }, () => {
  it("describes the persisted release graph and retains the command manifest", async () => {
    const { layer, cli } = await setup();
    const release = await Effect.runPromise(publish.pipe(Effect.provide(layer)));
    const output = await cli("describe");
    expect(output).toMatchObject({
      ok: true,
      command: "describe",
      data: { commands: { transaction: ["apply"] } },
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
