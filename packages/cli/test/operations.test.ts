import { EntityId, KvTriples } from "@triplex-build/triplex";
import { ConfigNode, ConfigStore } from "@triplex-build/triplex/config";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { execute } from "../src/operations.js";

const TestLayer = ConfigStore.layer.pipe(
  Layer.provideMerge(KvTriples.layerWithScope("triplex-cli-test")),
);

describe("agent CLI operations", () => {
  it("writes attributed facts and explores entities, Datalog, journal, and config history", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ConfigStore.ConfigStore;
        const policyV1 = yield* ConfigNode.make({
          kind: "policy",
          key: "course/grade-submissions",
          attrs: { enabled: true, message: "Grade submitted quizzes" },
        });
        const first = yield* config.commit({
          label: "learning-beta",
          objects: [policyV1],
          ref: "test",
        });
        const policyV2 = yield* ConfigNode.make({
          kind: "policy",
          key: "course/grade-submissions",
          attrs: { enabled: true, message: "Grade submitted quizzes within two days" },
        });
        const second = yield* config.commit({
          label: "learning-live",
          objects: [policyV2],
          ref: "live",
        });

        const transaction = yield* execute({
          _tag: "transaction-apply",
          request: {
            operations: [
              {
                op: "assert",
                entityId: EntityId.make("student:mina"),
                entityType: "Student",
                attribute: ":person/name",
                value: { type: "string", value: "Mina Patel" },
              },
            ],
            meta: {
              actor: "agent:test",
              commandId: "cli-test/create-mina",
              configSnapshot: second.snapshot.id,
            },
          },
        });
        const types = yield* execute({ _tag: "entity-types", includeSystem: false });
        const entities = yield* execute({
          _tag: "entity-list",
          entityType: "Student",
          limit: 10,
          includeSystem: false,
        });
        const query = yield* execute({
          _tag: "query-run",
          query: {
            find: ["?student", "?name"],
            where: [["?student", ":person/name", "?name"]],
          },
          debug: false,
        });
        const receipt = yield* execute({
          _tag: "journal-receipt",
          commandId: "cli-test/create-mina",
        });
        const refs = yield* execute({ _tag: "config-refs" });
        const releases = yield* execute({ _tag: "config-releases" });
        const object = yield* execute({
          _tag: "config-object",
          kind: "policy",
          key: "course/grade-submissions",
        });
        return { transaction, types, entities, query, receipt, refs, releases, object, first };
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(result.transaction).toEqual(
      expect.objectContaining({ position: expect.any(Number), retracted: 0 }),
    );
    expect(result.types).toEqual({
      entityTypes: [
        {
          entityType: "Student",
          entityCount: 1,
          attributes: [":person/name"],
        },
      ],
    });
    expect(result.entities).toEqual(
      expect.objectContaining({
        entities: [expect.objectContaining({ entityId: "student:mina", entityType: "Student" })],
      }),
    );
    expect(result.query).toEqual(
      expect.objectContaining({
        results: [{ "?student": "student:mina", "?name": "Mina Patel" }],
      }),
    );
    expect(result.receipt).toEqual({
      transaction: expect.objectContaining({
        actor: "agent:test",
        commandId: "cli-test/create-mina",
      }),
    });
    expect(result.refs).toEqual({
      refs: expect.arrayContaining([
        expect.objectContaining({ name: "live", label: "learning-live" }),
        expect.objectContaining({ name: "test", label: "learning-beta" }),
      ]),
    });
    expect(result.releases).toEqual({ releases: expect.arrayContaining([expect.any(Object)]) });
    expect(result.object).toEqual({
      object: expect.objectContaining({
        kind: "policy",
        key: "course/grade-submissions",
        history: [
          expect.objectContaining({
            parentRevisionId: expect.any(String),
            body: expect.objectContaining({
              attrs: expect.objectContaining({
                message: "Grade submitted quizzes within two days",
              }),
            }),
          }),
          expect.objectContaining({
            parentRevisionId: null,
            body: expect.objectContaining({
              attrs: expect.objectContaining({ message: "Grade submitted quizzes" }),
            }),
          }),
        ],
      }),
    });
  });
});
