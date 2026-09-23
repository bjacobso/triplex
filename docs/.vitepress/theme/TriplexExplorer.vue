<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { Runtime } from "foldkit";

import { DashboardDemoLayer } from "../../../packages/dashboard/src/demo/layer.js";
import { Message, elementView, init, update } from "../../../packages/dashboard/src/main.js";
import { Model } from "../../../packages/dashboard/src/model.js";
import "../../../packages/dashboard/src/styles.css";

const container = ref<HTMLElement | null>(null);
let handle: ReturnType<typeof Runtime.embed> | undefined;

onMounted(() => {
  handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container: container.value,
      init,
      update,
      view: elementView,
      resources: DashboardDemoLayer,
      devTools: { Message },
    }),
  );
});

onBeforeUnmount(() => handle?.dispose());
</script>

<template>
  <div id="triplex-explorer-root" ref="container" class="triplex-explorer-app" aria-live="polite">
    <div class="triplex-explorer-loading">Opening the in-memory Triplex database…</div>
  </div>
</template>

<style>
.triplex-explorer-app,
.triplex-explorer-loading {
  min-height: 100vh;
}

.triplex-explorer-loading {
  display: grid;
  place-items: center;
  background: #0b1220;
  color: #94a3b8;
  font:
    0.875rem "IBM Plex Sans Variable",
    sans-serif;
}
</style>
