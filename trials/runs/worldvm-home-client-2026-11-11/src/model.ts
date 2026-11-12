import { Effect, Layer, ManagedRuntime } from "effect";
import { EntityId, KvTriples, Triples, type TripleId } from "@triplex-build/triplex";
import { Attribute, ConfigStore, EntityType } from "@triplex-build/triplex/config";
import * as Database from "@triplex-build/triplex/database";
import { KeyProvider, Sensitive, ValueCodec } from "@triplex-build/triplex/sensitive";
import { SqliteTriples } from "@triplex-build/triplex-sqlite";

export const Home = EntityType.make("SubjectHome", {
  subject: Attribute.text(":home/subject").required({ unique: true }),
  status: Attribute.text(":home/status").required(),
  secret: Attribute.sensitive(Attribute.text(":home/secret")).required(),
  archive: Attribute.sensitive(Attribute.text(":home/archive")).required(),
});
export const Model = { types: [Home] } as const;
export const fixtures = {
  alice: { subject: "subject:alice", vault: "vault-a", secret: "SYNTHETIC-SHORT-ALICE-827", archive: "SYNTHETIC-LONG-ALICE-429" },
  bob: { subject: "subject:bob", vault: "vault-b", secret: "SYNTHETIC-SHORT-BOB-693", archive: "SYNTHETIC-LONG-BOB-731" },
} as const;
export type Subject = keyof typeof fixtures;
export const homeId = (subject: Subject) => EntityId.make(`home:${fixtures[subject].vault}:${fixtures[subject].subject}`);
export const keys = KeyProvider.test({ seed: "synthetic-trial-keys-only" });
// Host policy, not a native vault/retention feature. Encode the complete tuple
// unambiguously. Retention classes are fixed by these declared attributes.
export const keySubject = (ctx: ValueCodec.SensitiveContext) => JSON.stringify([
  ctx.entityId.split(":")[1], ctx.attribute === ":home/secret" ? "short" : "long", ctx.entityId,
]);
export const codec = ValueCodec.aesGcmWith({ subjectOf: keySubject }).pipe(Layer.provide(keys));
export type Backend = "kv" | "sqlite";
export function worldLayer(world: string, backend: Backend, filename?: string) {
  const base = backend === "kv" ? KvTriples.layerWithScope(world)
    : filename ? SqliteTriples.layer({ filename }) : SqliteTriples.layerMemoryWithScope(world);
  const storage = Sensitive.layer({ database: world, attributes: [Home] }).pipe(
    Layer.provide(codec), Layer.provide(base),
  );
  const store = ConfigStore.layer.pipe(Layer.provideMerge(storage));
  const published = Layer.effectDiscard(Effect.gen(function* () {
    const config = yield* ConfigStore.ConfigStore;
    yield* config.commit({ label: "synthetic-homes-v1", objects: yield* EntityType.nodesOf(Home), ref: "live" });
  })).pipe(Layer.provideMerge(store));
  return Database.layer({ schema: Model }).pipe(Layer.provideMerge(published));
}
export const openWorld = (world: string, backend: Backend, filename?: string) => ManagedRuntime.make(worldLayer(world, backend, filename));
export interface Principal { actor: string; world: string; subjects: readonly Subject[] }
export const principal = (world: string): Principal => ({ actor: "host:synthetic", world, subjects: ["alice", "bob"] });
export class HostDenied { readonly _tag = "HostDenied"; }
export function authorize(world: string, who: Principal, subject: Subject) {
  return who.world === world && who.subjects.includes(subject) ? Effect.void : Effect.fail(new HostDenied());
}
export function readHome(world: string, who: Principal, subject: Subject) {
  return Effect.gen(function* () {
    yield* authorize(world, who, subject);
    return yield* (yield* Database.Database).get(Home, homeId(subject));
  });
}
export function createHome(world: string, who: Principal, subject: Subject, commandId: string, status = "ready") {
  return Effect.gen(function* () {
    yield* authorize(world, who, subject);
    const db = yield* Database.Database;
    return yield* db.command({ actor: who.actor, commandId, correlationId: `request:${commandId}` }, tx => Effect.gen(function* () {
      yield* tx.create(Home, homeId(subject), { subject: fixtures[subject].subject, secret: fixtures[subject].secret, archive: fixtures[subject].archive, status }, { validFrom: 0 });
      yield* tx.outbox.append({ scope: homeId(subject), idempotencyKey: `${commandId}:refresh`, payload: { command: "refresh", subject: fixtures[subject].subject } });
    }));
  });
}
export function updateHome(world: string, who: Principal, subject: Subject, commandId: string,
  source: TripleId, status: string, gate: Effect.Effect<void> = Effect.void, at?: number) {
  return Effect.gen(function* () {
    yield* authorize(world, who, subject);
    const db = yield* Database.Database;
    return yield* db.command({ actor: who.actor, commandId }, tx => Effect.gen(function* () {
      yield* tx.get(Home, homeId(subject), { validAt: 0 });
      const fact = yield* tx.fact(Home, source);
      if (fact.entityId !== homeId(subject)) return yield* Effect.fail(new HostDenied());
      yield* gate;
      if (at === undefined) yield* tx.correct(Home, fact, { status });
      else yield* tx.replace(Home, fact, { status }, at);
      yield* tx.outbox.append({ scope: homeId(subject), idempotencyKey: `${commandId}:refresh`, payload: { command: "refresh", subject: fixtures[subject].subject } });
    }));
  });
}
// Infrastructure escape: the schema-bound client has no persisted receipt lookup
// or operational-entry read methods. Application writes above all use db.command.
export const audit = (subject: Subject, commandId: string) => Effect.gen(function* () {
  const db = yield* Database.Database;
  const triples = yield* Triples;
  const receipt = yield* triples.transactionByCommand(commandId);
  const { Outbox } = yield* Effect.promise(() => import("@triplex-build/triplex/operational"));
  return { home: yield* db.get(Home, homeId(subject)), receipt,
    intent: yield* Outbox.get(triples, Outbox.id(homeId(subject), `${commandId}:refresh`)) };
});
