import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Effect, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import { EntityId, Triples, number } from "../../src/index.js";
import { KvBackend, type KvBackendService } from "../../src/kv/kv/KvBackend.js";
import { makeTestKvBackend } from "../../src/kv/kv/InMemoryKvBackend.js";
import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import { createKvTripleStore } from "../../src/kv/hexastore/KvTripleStore.js";
import { decodeTuple } from "../../src/kv/hexastore/tuple.js";
import { TripleStoreRuntimeLayer } from "../../src/store/TripleStoreRuntime.js";

it(
  "does not read unrelated transaction metadata with 10 or 10000 unrelated commands",
  { timeout: 30000 },
  async () => {
    const measurements = [];
    for (const unrelatedCount of [10, 10000]) {
      const kv = makeTestKvBackend();
      const metaIds: string[] = [];
      let prefixCandidates = 0;
      const measuredGet: KvBackendService["get"] = (key) => {
        if (key[0] === 0x20) {
          const part = decodeTuple(key.subarray(1))[0]!;
          if (part.type !== "string") throw new Error("Invalid META key");
          metaIds.push(part.value);
        }
        return kv.get(key);
      };
      const measured: KvBackendService = {
        ...kv,
        get: measuredGet,
        getMany: (keys) =>
          Effect.forEach(keys, (key) =>
            measuredGet(key).pipe(Effect.map((value) => [key, value] as const)),
          ),
        getRange: (range) => {
          expect(range.start[0]).not.toBe(0x05); // The global transaction TYPE scan.
          return kv.getRange(range).pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                if (range.start[0] === 0x03) prefixCandidates++;
              }),
            ),
          );
        },
      };
      const backendLayer = KvTriples.layerBackend.pipe(
        Layer.provide(Layer.succeed(KvBackend, measured)),
        Layer.provide(TripleStoreRuntimeLayer),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const t = yield* Triples;
          const wanted = [];
          const unrelated = new Set<string>();
          for (let i = 0; i < 3; i++)
            wanted.push(
              yield* t.transact([
                {
                  op: "assert",
                  entityId: EntityId.make(`feed:home:a:${i}`),
                  attribute: ":feed/value",
                  value: number(i),
                },
                {
                  op: "assert",
                  entityId: EntityId.make(`feed:home:b:${i}`),
                  attribute: ":feed/value",
                  value: number(i),
                },
                {
                  op: "assert",
                  entityId: EntityId.make(`other:included:${i}`),
                  attribute: ":feed/value",
                  value: number(i),
                },
              ]),
            );
          for (let i = 0; i < unrelatedCount; i++) {
            const result = yield* t.transact([
              {
                op: "assert",
                entityId: EntityId.make(`noise:${i}`),
                attribute: ":feed/value",
                value: number(i),
              },
            ]);
            unrelated.add(result.txId);
          }
          metaIds.length = 0;
          prefixCandidates = 0;
          const page = yield* t.transactions({ entityIdPrefix: "feed:home:", limit: 2 });
          expect(page.transactions.map((record) => record.txId)).toEqual(
            wanted.slice(0, 2).map((result) => result.txId),
          );
          expect(page.transactions.every((record) => record.changes.length === 3)).toBe(true);
          expect(prefixCandidates).toBe(6); // Only the two matching references per wanted command.
          const reader = createKvTripleStore(kv);
          for (const id of metaIds) {
            const datom = yield* reader.getById(id);
            expect(unrelated.has(datom!.entity)).toBe(false);
          }
          measurements.push({
            unrelatedCommands: unrelatedCount,
            prefixCandidates,
            metadataReads: metaIds.length,
          });
        }).pipe(Effect.provide(backendLayer)),
      );
    }
    expect(measurements[0]!.prefixCandidates).toBe(measurements[1]!.prefixCandidates);
    expect(measurements[0]!.metadataReads).toBe(measurements[1]!.metadataReads);
    const path = process.env["TRIPLEX_FEED_KV_EVIDENCE"];
    if (path)
      writeFileSync(
        path,
        JSON.stringify(
          {
            sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
            dirty:
              execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length >
              0,
            node: process.version,
            measuredAt: new Date().toISOString(),
            measurements,
          },
          null,
          2,
        ) + "\n",
      );
  },
);
