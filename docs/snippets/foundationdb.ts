import { Effect } from "effect";
import { EntityId, Triples } from "@triplex-build/triplex";
import { Capabilities, DatabaseScope, Runtime } from "@triplex-build/triplex/runtime";
import { makeFdbKvBackend } from "@triplex-build/triplex/foundationdb";

const FoundationDbRuntime = Runtime.fromKv({
  name: "foundationdb",
  backend: makeFdbKvBackend({ subspace: Buffer.from("triplex/training/") }),
});
const DatabaseLive = FoundationDbRuntime.layer({
  scope: DatabaseScope.make({
    env: "dev",
    tenant: "example",
    database: "training",
    generation: 0,
  }),
  capabilities: Capabilities.none,
});

const program = Effect.gen(function* () {
  const triples = yield* Triples;
  return yield* triples.entity(EntityId.make("worker:maria"));
});

await Effect.runPromise(program.pipe(Effect.provide(DatabaseLive)));
