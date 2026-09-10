import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { EntityId, Triples, blob } from "@triplex-build/triplex";
import { SqliteTestLayer } from "./fixtures/SqliteTestLayer.js";

const TestLayer = SqliteTestLayer;
const eid = EntityId.make;

describe("BlobValue in Triples", () => {
  it("should store and retrieve a blob value", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Triples;

        const triple = yield* store.assert({
          entityId: eid("doc-1"),
          attribute: ":document/attachment",
          value: blob("abc123def456".padEnd(64, "0"), "application/pdf", 102400, "report.pdf"),
        });

        expect(triple.value).toEqual({
          type: "blob",
          value: "abc123def456".padEnd(64, "0"),
          mimeType: "application/pdf",
          size: 102400,
          filename: "report.pdf",
        });

        // Retrieve and verify
        const found = yield* store.entity("doc-1" as EntityId);
        expect(found.length).toBe(1);
        expect(found[0]!.value).toEqual({
          type: "blob",
          value: "abc123def456".padEnd(64, "0"),
          mimeType: "application/pdf",
          size: 102400,
          filename: "report.pdf",
        });
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  it("should store blob value without filename", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Triples;

        const triple = yield* store.assert({
          entityId: eid("img-1"),
          attribute: ":image/data",
          value: blob("f".repeat(64), "image/png", 2048),
        });

        expect(triple.value).toEqual({
          type: "blob",
          value: "f".repeat(64),
          mimeType: "image/png",
          size: 2048,
        });

        // Retrieve and verify no filename key
        const found = yield* store.entity("img-1" as EntityId);
        expect(found[0]!.value).toEqual({
          type: "blob",
          value: "f".repeat(64),
          mimeType: "image/png",
          size: 2048,
        });
        expect("filename" in found[0]!.value).toBe(false);
      }).pipe(Effect.provide(TestLayer)),
    );
  });
});
