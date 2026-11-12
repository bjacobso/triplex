import { Effect } from "effect";
import { EntityId, Triples, string } from "@triplex-internal/core";
import { describe, expect, it } from "vitest";
import { loadDashboardAt, loadEntityTypePage } from "./data.js";
import { DashboardDemoLayer } from "./demo/layer.js";

const entityType = "PositionCut";
const seed = Effect.gen(function* () {
  const t = yield* Triples;
  const first = yield* t.transact(
    ["a", "b"].map((suffix) => ({
      op: "assert" as const,
      entityId: EntityId.make(`position:${suffix}`),
      entityType,
      attribute: ":position/name",
      value: string(suffix),
      validFrom: 0,
    })),
  );
  yield* t.transact([
    { op: "retract", id: first.triples[0]!.id },
    {
      op: "assert",
      entityId: EntityId.make("position:a"),
      entityType,
      attribute: ":position/name",
      value: string("renamed"),
      validFrom: 0,
    },
    {
      op: "assert",
      entityId: EntityId.make("position:c"),
      entityType,
      attribute: ":position/name",
      value: string("c"),
      validFrom: 0,
    },
  ]);
  return first.position;
});

describe("dashboard position bases", () => {
  it("preserves the position on dashboard fact reads and entity-page continuation", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const position = yield* seed;
        const data = yield* loadDashboardAt({ recordedPosition: position, validAt: 1 });
        expect(data.basis.recordedPosition).toBe(position);
        expect(
          data.entities.filter((entity) => entity.type === entityType).map((entity) => entity.id),
        ).toEqual(["position:a", "position:b"]);
        const page = yield* loadEntityTypePage(entityType, null, 1, {
          recordedPosition: position,
          validAt: 1,
        });
        expect(page.totalCount).toBe(2);
        expect(page.entities.map((entity) => entity.id)).toEqual(["position:a"]);
        expect(
          page.entities[0]!.facts.find((fact) => fact.attribute === ":position/name")!.value,
        ).toBe("a");
        const next = yield* loadEntityTypePage(entityType, page.nextCursor, 10);
        expect(next.entities.map((entity) => entity.id)).toEqual(["position:b"]);
        const empty = yield* loadEntityTypePage(entityType, null, 10, {
          recordedPosition: 0,
          validAt: 1,
        });
        expect(empty.totalCount).toBe(0);
        const ambiguous = yield* loadDashboardAt({
          recordedAt: Date.now(),
          recordedPosition: position,
        }).pipe(Effect.result);
        expect(ambiguous._tag).toBe("Failure");
      }).pipe(Effect.provide(DashboardDemoLayer)),
    );
  });

  it("caps future position pages at their first head", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed;
        const t = yield* Triples;
        const page = yield* loadEntityTypePage(entityType, null, 1, {
          recordedPosition: Number.MAX_SAFE_INTEGER,
          validAt: 1,
        });
        yield* t.assert({
          entityId: EntityId.make("position:d"),
          entityType,
          attribute: ":position/name",
          value: string("d"),
          validFrom: 0,
        });
        const next = yield* loadEntityTypePage(entityType, page.nextCursor, 10);
        expect(next.entities.map((entity) => entity.id)).toEqual(["position:b", "position:c"]);
      }).pipe(Effect.provide(DashboardDemoLayer)),
    );
  });
  it("retains legacy timestamp cursors and rejects cursors without an exact cut", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed;
        const cursor = (fields: object) =>
          btoa(
            JSON.stringify({
              version: 1,
              entityType,
              validAt: 1,
              afterEntityId: "position:a",
              ...fields,
            }),
          )
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replace(/=+$/, "");
        const legacy = yield* loadEntityTypePage(
          entityType,
          cursor({ recordedAt: Date.now() }),
          10,
        );
        expect(legacy.entities.map((entity) => entity.id)).toEqual(["position:b", "position:c"]);
        for (const fields of [
          {},
          { recordedAt: 1, recordedPosition: 1 },
          { recordedPosition: -1 },
        ]) {
          const invalid = yield* loadEntityTypePage(entityType, cursor(fields), 10).pipe(
            Effect.result,
          );
          expect(invalid._tag).toBe("Failure");
        }
      }).pipe(Effect.provide(DashboardDemoLayer)),
    );
  });
});
