import { Effect } from "effect";
import { expect, it } from "vitest";
import * as Attribute from "../../src/config/Attribute.js";
import * as EntityType from "../../src/config/EntityType.js";

const Site = EntityType.make("ClosureSite", { name: Attribute.text(":closure/name").required() });
const site = Attribute.ref(":closure/site", Site);
const Placement = EntityType.make("ClosurePlacement", { site: site.required() });
const Note = EntityType.make("ClosureNote", { placement: Attribute.ref(":closure/placement", Placement) });

it("retains target declarations and includes transitive shared reference closure once", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    expect(site.target).toBe(Site);
    const expected = yield* Effect.all([Note.nodes, Placement.nodes, Site.nodes]);
    const nodes = yield* EntityType.nodesOf(Note, Site, Placement, Note);
    expect(nodes).toEqual([...new Map(expected.flat().map((node) => [node.cid, node])).values()]);
    expect(yield* EntityType.nodesOf(Note)).toEqual(nodes);
  }));
});

it("preserves the pre-closure node CIDs", async () => {
  const nodes = await Effect.runPromise(Effect.all([Site.node, site.node, Placement.node]));
  expect(nodes.map((node) => node.cid)).toEqual([
    "sha256-6477584d83bf19b196bc62280c7569356d5d45398914b93f312cccfb8951ff31",
    "sha256-ea517ed7e32b140fcccabccdb50b2db09ba1318402e1bbd38b7656466a3918e2",
    "sha256-cac2f65bb21561bd9d580077471a52dd7ab45a15d49442048977ea7aaa1c0d48",
  ]);
});
