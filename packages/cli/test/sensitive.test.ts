import { EntityId, KvTriples } from "@triplex-internal/core";
import { Attribute, ConfigStore } from "@triplex-internal/core/config";
import { KeyProvider, Sensitive, ValueCodec } from "@triplex-internal/core/sensitive";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { execute, redactSealed } from "../src/operations.js";

const Ssn = Attribute.sensitive(Attribute.text(":person/ssn"));
const PLANTED = "zq-cli-planted-987-65-4321";

const TestLayer = ConfigStore.layer.pipe(
  Layer.provideMerge(
    Sensitive.layer({ database: "cli-test", attributes: [Ssn] }).pipe(
      Layer.provide(ValueCodec.aesGcm),
      Layer.provide(KeyProvider.test({ seed: "cli-sensitive-test" })),
      Layer.provide(KvTriples.layerWithScope("triplex-cli-sensitive-test")),
    ),
  ),
);

describe("CLI output for sealed values", () => {
  it("prints sealed values as type and key ID only across entity, history and journal", async () => {
    const outputs = await Effect.runPromise(
      Effect.gen(function* () {
        const applied = (yield* execute({
          _tag: "transaction-apply",
          request: {
            operations: [
              {
                op: "assert",
                entityId: EntityId.make("person:1"),
                attribute: ":person/ssn",
                value: { type: "string", value: PLANTED },
              },
            ],
            meta: { commandId: "cli-sensitive" },
          },
        })) as { readonly transactionId: string };
        const entityId = EntityId.make("person:1");
        return [
          applied,
          yield* execute({ _tag: "entity-get", entityId }),
          yield* execute({ _tag: "entity-facts", entityId }),
          yield* execute({ _tag: "entity-history", entityId, limit: 10 }),
          yield* execute({ _tag: "journal-receipt", commandId: "cli-sensitive" }),
          yield* execute({ _tag: "journal-list", after: 0, limit: 10 }),
          yield* execute({
            _tag: "entity-get",
            entityId: EntityId.make(applied.transactionId),
          }),
        ];
      }).pipe(Effect.provide(TestLayer)),
    );
    for (const output of outputs) {
      const json = JSON.stringify(output);
      expect(json).not.toContain(PLANTED);
      expect(json).not.toContain("ciphertext");
      expect(json).not.toContain("blind");
    }
    expect(JSON.stringify(outputs[1])).toMatch(
      /\{"type":"sealed","valueType":"string","keyId":"test:[0-9a-f]{16}:v1"\}/,
    );
    expect(JSON.stringify(outputs[4])).toContain('"type":"sealed"');
  });

  it("leaves non-sealed data and class instances untouched", () => {
    const date = new Date(0);
    expect(redactSealed({ value: { type: "string", value: "x" }, at: date })).toEqual({
      value: { type: "string", value: "x" },
      at: date,
    });
  });
});
