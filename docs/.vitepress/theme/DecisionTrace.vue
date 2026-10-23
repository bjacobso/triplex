<script setup lang="ts">
import { computed, ref } from "vue";
import audit from "../../snippets/home/site-safety/output/audit.json";

const corrected = ref(false);
const trained = computed(() =>
  corrected.value ? audit.trainedAsKnownNow : audit.trainedAsKnownThen,
);
</script>

<template>
  <figure class="decision-trace">
    <div class="decision-trace__bar">
      <span class="decision-trace__dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <span>placement:maria-harbor</span>
      <span class="decision-trace__badge">receipt</span>
    </div>
    <div class="decision-trace__body">
      <p class="decision-trace__comment">// A decision keeps its context.</p>
      <dl class="decision-trace__fields">
        <div>
          <dt>worker</dt>
          <dd>worker:maria</dd>
        </div>
        <div>
          <dt>site</dt>
          <dd>site:harbor</dd>
        </div>
        <div>
          <dt>actor</dt>
          <dd>{{ audit.actor }}</dd>
        </div>
        <div>
          <dt>governedBy</dt>
          <dd class="decision-trace__violet">{{ audit.governedBy }}</dd>
        </div>
      </dl>
      <div class="decision-trace__divider"><span>One date. Two views of the evidence.</span></div>
      <p class="decision-trace__question">Was Maria trained on March 2?</p>
      <div class="decision-trace__controls" aria-label="View recorded knowledge">
        <button type="button" :aria-pressed="!corrected" @click="corrected = false">
          At the decision
        </button>
        <button type="button" :aria-pressed="corrected" @click="corrected = true">
          After the correction
        </button>
      </div>
      <div class="decision-trace__result" aria-live="polite" aria-atomic="true">
        <span class="decision-trace__result-key">trained</span>
        <strong :class="trained ? 'decision-trace__yes' : 'decision-trace__no'">{{
          trained
        }}</strong>
        <p>
          {{
            corrected
              ? "The corrected certificate starts March 5. The earlier belief is still in the record."
              : "Dana saw a certificate starting March 1. That is the evidence her decision used."
          }}
        </p>
      </div>
      <p class="decision-trace__footer">
        <span aria-hidden="true">&gt;</span> same decision · same rules · history preserved
      </p>
    </div>
    <figcaption>
      Explore saved query results from the <a href="#one-scenario">checked scenario below ↓</a>
    </figcaption>
  </figure>
</template>
