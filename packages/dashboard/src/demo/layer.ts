import { KvTriples } from "@bjacobso/triplex";
import { ConfigStore } from "@bjacobso/triplex/config";
import { Effect, Layer } from "effect";

import { localDashboardApiLayer } from "../api.js";
import { seedLearningDemo } from "./learning.js";

export const DemoDatabaseLayer = ConfigStore.layer.pipe(
  Layer.provideMerge(KvTriples.layerWithScope("triplex-dashboard-demo")),
);

/** Browser-local composition for the standalone classroom demo. */
const SeededDemoDatabaseLayer = Layer.merge(
  DemoDatabaseLayer,
  Layer.effectDiscard(seedLearningDemo.pipe(Effect.orDie)).pipe(Layer.provide(DemoDatabaseLayer)),
);

export const DashboardDemoLayer = Layer.merge(
  SeededDemoDatabaseLayer,
  localDashboardApiLayer("memory://demo-learning").pipe(Layer.provide(SeededDemoDatabaseLayer)),
);
