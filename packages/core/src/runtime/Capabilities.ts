import { Context, Effect, Layer, type Scope } from "effect";
import { Triples } from "../store/Triples.js";
import { TripleStoreRuntime } from "../store/TripleStoreRuntime.js";
import { ChangeEmitter, type ChangeEmitterService } from "../store/ChangeEmitter.js";
import { makeChangeEmissionCapability } from "../store/ChangeEmissionCapability.js";
import { type StoreCapability } from "../store/StoreCapability.js";
import { SnapshotService, SnapshotWriter } from "../snapshots/SnapshotService.js";
import { makeEntitySnapshotsCapability } from "../snapshots/EntitySnapshotsCapability.js";

/** A capability bundle preserves both its service outputs and its dependencies. */
export interface CapabilitySet<Out, E = never, R = never> {
  readonly build: Effect.Effect<
    { readonly capabilities: readonly StoreCapability[]; readonly services: Context.Context<Out> },
    E,
    R | Triples | TripleStoreRuntime | Scope.Scope
  >;
}

const ambientSnapshots = Layer.mergeAll(
  Layer.effect(SnapshotService, SnapshotService),
  Layer.effect(SnapshotWriter, SnapshotWriter),
);

export function entitySnapshots(): CapabilitySet<
  SnapshotService | SnapshotWriter,
  never,
  SnapshotService | SnapshotWriter
>;
export function entitySnapshots<E, R>(
  snapshots: Layer.Layer<SnapshotService | SnapshotWriter, E, R>,
): CapabilitySet<SnapshotService | SnapshotWriter, E, Exclude<R, Triples | TripleStoreRuntime>>;
export function entitySnapshots<E, R>(
  snapshots?: Layer.Layer<SnapshotService | SnapshotWriter, E, R>,
): CapabilitySet<SnapshotService | SnapshotWriter, E, R | SnapshotService | SnapshotWriter> {
  const persistence: Layer.Layer<
    SnapshotService | SnapshotWriter,
    E,
    R | SnapshotService | SnapshotWriter
  > = snapshots ?? ambientSnapshots;
  return {
    build: Effect.gen(function* () {
      const services = yield* Layer.build(persistence);
      const writer = Context.get(services, SnapshotWriter);
      return { capabilities: [makeEntitySnapshotsCapability(writer)], services };
    }),
  };
}

export function changeEmission(): CapabilitySet<never, never, ChangeEmitter>;
export function changeEmission(emitter: ChangeEmitterService): CapabilitySet<never>;
export function changeEmission(
  emitter?: ChangeEmitterService,
): CapabilitySet<never, never, ChangeEmitter> {
  return {
    build: Effect.gen(function* () {
      const service = emitter ?? (yield* ChangeEmitter);
      const runtime = yield* TripleStoreRuntime;
      return {
        capabilities: [makeChangeEmissionCapability(service, runtime.now)],
        services: Context.empty(),
      };
    }),
  };
}

type AnySet = CapabilitySet<never, unknown, unknown>;
type Output<S> = S extends CapabilitySet<infer O, infer _E, infer _R> ? O : never;
type Error<S> = S extends CapabilitySet<infer _O, infer E, infer _R> ? E : never;
type Requirements<S> = S extends CapabilitySet<infer _O, infer _E, infer R> ? R : never;

const of = <const Sets extends readonly AnySet[]>(
  ...sets: Sets
): CapabilitySet<Output<Sets[number]>, Error<Sets[number]>, Requirements<Sets[number]>> => ({
  // Each member's outputs are merged, and its errors/requirements remain in the union.
  build: Effect.gen(function* () {
    const capabilities: StoreCapability[] = [];
    let services = Context.empty();
    for (const set of sets) {
      const installed = yield* set.build;
      capabilities.push(...installed.capabilities);
      services = Context.merge(services, installed.services);
    }
    return { capabilities, services };
  }) as unknown as CapabilitySet<
    Output<Sets[number]>,
    Error<Sets[number]>,
    Requirements<Sets[number]>
  >["build"],
});

export const Capabilities = {
  of,
  none: of(),
  /** Missing persistence and emission services remain explicit Effect requirements. */
  default: of(entitySnapshots(), changeEmission()),
  custom: (...capabilities: readonly StoreCapability[]): CapabilitySet<never> => ({
    build: Effect.succeed({ capabilities, services: Context.empty() }),
  }),
} as const;
