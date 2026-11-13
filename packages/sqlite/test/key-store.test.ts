import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EntityId, Triples } from "@triplex-internal/core";
import { Attribute } from "@triplex-internal/core/config";
import { KeyProvider, RootKey, Sensitive, ValueCodec } from "@triplex-internal/core/sensitive";
import { SqlKeyStore } from "@triplex-build/triplex-sql";
import {
  ERASURE_CONFORMANCE_DATABASE,
  erasureConformanceLayer,
  makeErasureSuite,
  makeRotationSuite,
  KEY_STORE_CONFORMANCE_DATABASE,
  SENSITIVE_CONFORMANCE_DATABASE,
  makeKeyStoreSuite,
  makeSensitiveConformanceSuite,
  sensitiveConformanceLayer,
} from "@triplex-build/triplex-testkit";

import { SqliteTriples } from "../src/SqliteTriples.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const rootBytes = (fill: number) => new Uint8Array(32).fill(fill);
const root = (id: string, fill: number) => ({ id, key: Redacted.make(rootBytes(fill)) });
const rootLayer = (options: RootKey.FromBytesOptions) => Layer.orDie(RootKey.fromBytes(options));

const keyStore = (
  database: string,
  options: RootKey.FromBytesOptions = { current: root("root-1", 7) },
) => SqlKeyStore.layer({ database }).pipe(Layer.provide(rootLayer(options)));

const run = <A>(effect: Effect.Effect<A, unknown, never>) =>
  Effect.runPromise(Effect.scoped(effect));

const Ssn = Attribute.sensitive(Attribute.text(":person/ssn"));
const DATABASE = "acme/main";
const PERSON = EntityId.make("person:1");

/** Decorated Triples over a SQLite file with the SQL key store. */
const fileStore = (
  filename: string,
  options?: RootKey.FromBytesOptions,
  codec: Layer.Layer<ValueCodec.ValueCodec, never, KeyProvider.KeyProvider> = ValueCodec.aesGcm,
) =>
  Sensitive.layer({ database: DATABASE, attributes: [Ssn] }).pipe(
    Layer.provide(codec),
    Layer.provide(keyStore(DATABASE, options)),
    Layer.provideMerge(SqliteTriples.layerWithSqlClient({ filename })),
  );

const tempFile = async () => {
  const directory = await mkdtemp(join(tmpdir(), "triplex-keys-"));
  temporaryDirectories.push(directory);
  return { directory, filename: join(directory, "triplex.db") };
};

const writeSsn = Effect.gen(function* () {
  const triples = yield* Triples;
  return yield* triples.assert({
    entityId: PERSON,
    attribute: ":person/ssn",
    value: { type: "string", value: "917-55-4321" },
  });
});

const openSsn = Effect.gen(function* () {
  const triples = yield* Triples;
  const [fact] = yield* triples.entity(PERSON);
  return yield* Sensitive.open(fact!);
});

describe("SQLite erasure", () => {
  it("passes the erasure contract with test keys", async () => {
    await run(
      makeErasureSuite().pipe(
        Effect.andThen(makeRotationSuite()),
        Effect.provide(erasureConformanceLayer(Layer.fresh(SqliteTriples.layerMemory))),
      ),
    );
  });

  it("passes the erasure contract with stored keys and leaves no token in any table", async () => {
    const tokens = await run(
      Effect.gen(function* () {
        // Build the store once so Triples, the key store and the scan share one database.
        const store = Layer.succeedContext(
          yield* Layer.build(SqliteTriples.layerMemoryWithSqlClient),
        );
        return yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const triples = yield* Triples;
          yield* triples.assert({
            entityId: EntityId.make("er:ada"),
            attribute: ":er-person/ssn",
            value: { type: "string", value: "999-99-9999" },
          });
          const before = yield* sql<{ value_blind: string }>`
          SELECT value_blind FROM triples WHERE entity_id = 'er:ada' AND value_blind IS NOT NULL
        `;
          yield* makeErasureSuite();
          yield* makeRotationSuite();
          const tables = yield* sql<{ name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table'
        `;
          let dump = "";
          for (const { name } of tables) {
            dump += JSON.stringify(yield* sql.unsafe(`SELECT * FROM "${name}"`));
          }
          const blindKeyPart = (token: string) => token.slice(token.indexOf(":") + 1);
          return before.map(({ value_blind }) => dump.includes(blindKeyPart(value_blind)));
        }).pipe(
          Effect.provide(
            erasureConformanceLayer(
              store,
              keyStore(ERASURE_CONFORMANCE_DATABASE).pipe(Layer.provide(store)),
            ).pipe(Layer.provideMerge(store)),
          ),
        );
      }),
    );
    expect(tokens).toEqual([false]);
  });
});

describe("SQLite key store", () => {
  it("passes the key store contract", async () => {
    await run(
      makeKeyStoreSuite().pipe(
        Effect.provide(
          keyStore(KEY_STORE_CONFORMANCE_DATABASE).pipe(
            Layer.provide(Layer.fresh(SqliteTriples.layerMemoryWithSqlClient)),
          ),
        ),
      ),
    );
  });

  it("passes the sensitive decorator contract with stored keys", async () => {
    await run(
      Effect.gen(function* () {
        const store = Layer.succeedContext(
          yield* Layer.build(SqliteTriples.layerMemoryWithSqlClient),
        );
        const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(store));
        yield* makeSensitiveConformanceSuite().pipe(
          Effect.provide(
            sensitiveConformanceLayer(
              store,
              ValueCodec.aesGcm.pipe(
                Layer.provide(keyStore(SENSITIVE_CONFORMANCE_DATABASE).pipe(Layer.provide(store))),
              ),
            ),
          ),
        );
        // The keys were stored in the same database as the facts.
        const [keys] = yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM triplex_data_keys`;
        expect(keys!.count).toBeGreaterThan(0);
      }),
    );
  });

  it("opens values after a restart, with a previous root key, and not with a wrong one", async () => {
    const { filename } = await tempFile();
    const written = await run(writeSsn.pipe(Effect.provide(fileStore(filename))));
    const keyId = (written.value as { keyId: string }).keyId;
    expect(keyId).toMatch(/^k1\.[0-9a-f]{32}$/);

    const reopened = await run(openSsn.pipe(Effect.provide(fileStore(filename))));
    expect(reopened.value).toEqual({ type: "string", value: "917-55-4321" });

    const rotatedRoot = await run(
      openSsn.pipe(
        Effect.provide(
          fileStore(filename, { current: root("root-2", 9), previous: [root("root-1", 7)] }),
        ),
      ),
    );
    expect(rotatedRoot.value).toEqual({ type: "string", value: "917-55-4321" });

    const wrongRoot = await run(
      Effect.exit(openSsn).pipe(
        Effect.provide(fileStore(filename, { current: root("root-1", 8) })),
      ),
    );
    expect(JSON.stringify(wrongRoot)).toContain("key-unavailable");
  });

  it("rewraps stored keys under a new root key so the old one can be dropped", async () => {
    const { filename } = await tempFile();
    await run(writeSsn.pipe(Effect.provide(fileStore(filename))));
    const rotated = { current: root("root-2", 9), previous: [root("root-1", 7)] };
    const report = await run(
      SqlKeyStore.rewrapRoot.pipe(
        Effect.provide(
          Layer.merge(rootLayer(rotated), SqliteTriples.layerWithSqlClient({ filename })),
        ),
      ),
    );
    expect(report).toEqual({ dataKeys: 1, blindKeys: 1, remaining: 0 });
    const again = await run(
      SqlKeyStore.rewrapRoot.pipe(
        Effect.provide(
          Layer.merge(rootLayer(rotated), SqliteTriples.layerWithSqlClient({ filename })),
        ),
      ),
    );
    expect(again).toEqual({ dataKeys: 0, blindKeys: 0, remaining: 0 });
    const opened = await run(
      openSsn.pipe(Effect.provide(fileStore(filename, { current: root("root-2", 9) }))),
    );
    expect(opened.value).toEqual({ type: "string", value: "917-55-4321" });
    const oldOnly = await run(
      Effect.exit(openSsn).pipe(
        Effect.provide(fileStore(filename, { current: root("root-1", 7) })),
      ),
    );
    expect(JSON.stringify(oldOnly)).toContain("key-unavailable");
  });

  it("opens by key ID even when the host maps values to subjects differently", async () => {
    const { filename } = await tempFile();
    await run(writeSsn.pipe(Effect.provide(fileStore(filename))));
    const opened = await run(
      openSsn.pipe(
        Effect.provide(
          fileStore(filename, undefined, ValueCodec.aesGcmWith({ subjectOf: () => "household:9" })),
        ),
      ),
    );
    expect(opened.value).toEqual({ type: "string", value: "917-55-4321" });
  });

  it("stores keys only wrapped and never stores the root key", async () => {
    const { directory, filename } = await tempFile();
    const rows = await run(
      Effect.gen(function* () {
        yield* writeSsn;
        const sql = yield* SqlClient.SqlClient;
        return {
          data: yield* sql<{ root_key_id: string; wrapped_key: string }>`
            SELECT root_key_id, wrapped_key FROM triplex_data_keys
          `,
          blind: yield* sql<{ root_key_id: string }>`SELECT root_key_id FROM triplex_blind_keys`,
        };
      }).pipe(Effect.provide(fileStore(filename))),
    );
    expect(rows.data).toHaveLength(1);
    expect(rows.data[0]!.root_key_id).toBe("root-1");
    expect(rows.data[0]!.wrapped_key.length).toBeGreaterThan(40);
    expect(rows.blind).toEqual([{ root_key_id: "root-1" }]);

    const root = Buffer.from(rootBytes(7));
    const forms = [
      root,
      Buffer.from(root.toString("hex")),
      Buffer.from(root.toString("base64url")),
    ];
    for (const name of await readdir(directory)) {
      const bytes = await readFile(join(directory, name));
      for (const form of forms)
        expect(bytes.includes(form), `${name} holds the root key`).toBe(false);
    }
  });
});
