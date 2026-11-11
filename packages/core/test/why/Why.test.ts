import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { KvTriples } from "../../src/kv/layers/KvTriplesLive.js";
import { Triples } from "../../src/store/Triples.js";
import * as ConfigStore from "../../src/config/ConfigStore.js";
import { EntityId } from "../../src/Branded.js";
import { string } from "../../src/Value.js";
import { Why } from "../../src/why/index.js";

it.effect("explains a backdated assertion at its exact cut and hides later retraction", () =>
  Effect.gen(function* () {
    const triples = yield* Triples;
    const why = yield* Why;
    const entityId = EntityId.make("placement:maria");
    const written = yield* triples.transact(
      [
        {
          op: "assert",
          entityId,
          attribute: ":placement/site",
          value: string("harbor"),
          validFrom: 100,
        },
      ],
      { actor: "user:dana", commandId: "place" },
    );
    yield* triples.transact([{ op: "retract", id: written.triples[0]!.id }], { actor: "auditor" });
    const result = yield* why.why(
      { kind: "fact", tripleId: written.triples[0]!.id },
      { basis: { recordedPosition: written.position, validAt: 150 } },
    );
    expect(result.facts[0]).toMatchObject({
      visible: true,
      recorded: { to: null },
      retraction: null,
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      actor: "user:dana",
      commandId: "place",
      release: { status: "unpinned" },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  }).pipe(
    Effect.provide(Why.layer),
    Effect.provide(ConfigStore.layer),
    Effect.provide(KvTriples.layer),
  ),
);
