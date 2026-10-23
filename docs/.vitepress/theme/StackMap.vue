<script setup lang="ts">
import stack from "../../snippets/home/site-safety/output/stack.json";

// Each layer's width is its share of the lines the homepage shows from app.ts.
const layers = [
  { id: "model", label: "Model", lines: stack.model },
  { id: "which-rules", label: "Rules", lines: stack.release },
  { id: "record-a-command", label: "Command", lines: stack.command },
  { id: "what-did-we-know", label: "Audit", lines: stack.ask },
  { id: "what-happens-next", label: "Open work", lines: stack.derive },
  { id: "runtime", label: "Storage + HTTP", lines: stack.run },
];
</script>

<template>
  <figure class="stack-map">
    <figcaption>
      <code>app.ts</code> · <strong>{{ stack.total }} lines</strong> from schema to REST API
    </figcaption>
    <ol>
      <li v-for="(layer, index) in layers" :key="layer.id" :style="{ flexGrow: layer.lines }">
        <a :href="`#${layer.id}`">
          <span class="stack-map__step">0{{ index + 1 }}</span>
          <span class="stack-map__label">{{ layer.label }}</span>
          <span class="stack-map__lines">{{ layer.lines }} lines</span>
        </a>
      </li>
    </ol>
  </figure>
</template>
