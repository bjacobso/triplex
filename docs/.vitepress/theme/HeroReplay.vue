<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import source from "../../snippets/home/hero.ts?raw";
import out from "../../snippets/home/output/hero.json";

/* Code shown in each step is cut from the checked program; values are its saved output. */
const region = (name: string) => {
  const match = source.match(new RegExp(`// #region ${name}\\n([\\s\\S]*?)// #endregion ${name}`));
  const lines = (match?.[1] ?? "").split("\n").filter((line) => !line.startsWith("import "));
  while (lines.length && lines[0]!.trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  const indent = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length),
  );
  return lines.map((l) => l.slice(indent));
};

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const highlight = (line: string) =>
  escape(line).replace(
    /(\/\/.*$)|("[^"]*")|\b(const|yield|function|return|async|await)\b|\b([A-Z][A-Za-z]+)\b|\b(\d+)\b/g,
    (m, comment, str, kw, type, num) =>
      comment
        ? `<span class="hr-c">${m}</span>`
        : str
          ? `<span class="hr-s">${m}</span>`
          : kw
            ? `<span class="hr-k">${m}</span>`
            : type
              ? `<span class="hr-t">${m}</span>`
              : num
                ? `<span class="hr-n">${m}</span>`
                : m,
  );

const [hired, moved, corrected] = out.commands;
const steps = [
  {
    key: "model",
    label: "Model",
    code: region("model"),
    caption: `Release ${out.release.label} · ${out.release.id}… published to live`,
  },
  {
    key: "hire",
    label: "Hire",
    code: region("create"),
    caption: `tx ${hired!.position} · ${hired!.actor} · governed by ${out.release.label}`,
  },
  {
    key: "move",
    label: "Move",
    code: region("move"),
    caption: `tx ${moved!.position} · harbor ends June 1, pier begins · nothing overwritten`,
  },
  {
    key: "correct",
    label: "Correct",
    code: region("correct"),
    caption: `tx ${corrected!.position} · ${corrected!.actor} fixes the name · the old belief stays on record`,
  },
  {
    key: "ask",
    label: "Ask",
    code: region("asof"),
    caption: "Same entity, two questions: what we knew then, what is true now, and why",
  },
] as const;

const STEP_MS = 5200;
const step = ref(steps.length - 1); // Server render and reduced motion show the full story.
const playing = ref(false);
const hovering = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

const advance = () => {
  if (!hovering.value) step.value = (step.value + 1) % steps.length;
};
const play = () => {
  clearInterval(timer);
  playing.value = true;
  timer = setInterval(advance, STEP_MS);
};
const pause = () => {
  clearInterval(timer);
  playing.value = false;
};
const select = (index: number) => {
  step.value = index;
  if (playing.value) play(); // restart the step timer
};
const onVisibility = () => (document.hidden ? clearInterval(timer) : playing.value && play());

onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  step.value = 0;
  play();
  document.addEventListener("visibilitychange", onVisibility);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  document.removeEventListener("visibilitychange", onVisibility);
});

const short = (day: string | null) =>
  day === null
    ? ""
    : new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });

type Row = {
  fact: string;
  attribute: string;
  value: string | null;
  valid: string;
  tx: number;
  retractedAt: number | null;
};
const rows = computed(() => {
  const applied = out.commands.slice(0, Math.max(0, step.value)); // step 1 = model only
  const byFact = new Map<string, Row>();
  for (const command of applied) {
    for (const c of command.changes) {
      if (c.op === "assert") {
        byFact.set(c.fact, {
          fact: c.fact,
          attribute: c.attribute.replace(":worker/", ""),
          value: c.value,
          valid: c.validTo
            ? `${short(c.validFrom)} – ${short(c.validTo)}`
            : `${short(c.validFrom)} →`,
          tx: command.position,
          retractedAt: null,
        });
      } else {
        const row = byFact.get(c.fact);
        if (row) row.retractedAt = command.position;
      }
    }
  }
  return [...byFact.values()];
});
const currentTx = computed(() => out.commands[step.value - 1]?.position ?? -1);
const current = computed(() => steps[step.value]!);
const asking = computed(() => current.value.key === "ask");
const whyFor = (attribute: string) =>
  out.why.find((t) => t.commandId === (attribute === "site" ? "move:maria" : "fix:maria"));
</script>

<template>
  <figure
    class="hero-replay"
    @mouseenter="hovering = true"
    @mouseleave="hovering = false"
    @focusin="hovering = true"
    @focusout="hovering = false"
  >
    <div class="hero-replay__bar">
      <span class="hero-replay__dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <span>hero.ts</span>
      <button
        type="button"
        class="hero-replay__toggle"
        :aria-label="playing ? 'Pause the walkthrough' : 'Play the walkthrough'"
        @click="playing ? pause() : play()"
      >
        {{ playing ? "❚❚" : "▶" }}
      </button>
    </div>

    <div class="hero-replay__steps" role="group" aria-label="Walkthrough steps">
      <button
        v-for="(s, i) in steps"
        :key="s.key"
        type="button"
        :aria-pressed="i === step"
        :class="{ 'is-done': i < step }"
        @click="select(i)"
      >
        <span class="hero-replay__num">{{ i + 1 }}</span
        >{{ s.label }}
        <span
          v-if="i === step && playing && !hovering"
          :key="`p${step}`"
          class="hero-replay__progress"
          :style="{ animationDuration: `${STEP_MS}ms` }"
        ></span>
      </button>
    </div>

    <pre class="hero-replay__code" :key="current.key"><code><span
      v-for="(line, i) in current.code"
      :key="i"
      class="hero-replay__line"
      :style="{ animationDelay: `${i * 70}ms` }"
      v-html="highlight(line) || ' '"
    ></span></code></pre>

    <div class="hero-replay__divider">
      <span>worker:maria</span><span>{{ asking ? "two reads" : "facts" }}</span>
    </div>

    <div v-if="current.key === 'model'" class="hero-replay__schema">
      <span><code>:worker/name</code> text · required</span>
      <span><code>:worker/site</code> text</span>
      <span class="hero-replay__release">{{ out.release.label }} → live</span>
    </div>

    <div v-else-if="asking" class="hero-replay__ask">
      <div>
        <p class="hero-replay__ask-head">asOf tx {{ hired!.position }} · Mar 2</p>
        <p class="hero-replay__ask-value">{{ out.knownThen?.name }}</p>
        <p class="hero-replay__ask-sub">{{ out.knownThen?.site }}</p>
        <p class="hero-replay__ask-note">what Dana knew</p>
      </div>
      <div class="is-now">
        <p class="hero-replay__ask-head">now · Jun 1</p>
        <p class="hero-replay__ask-value">{{ out.now?.name }}</p>
        <p class="hero-replay__ask-sub">{{ out.now?.site }}</p>
        <p class="hero-replay__ask-why">
          <span v-for="attr in ['name', 'site']" :key="attr">
            {{ attr }} ← tx {{ whyFor(attr)?.position }} · {{ whyFor(attr)?.actor }} ·
            {{ whyFor(attr)?.release }}
          </span>
        </p>
      </div>
    </div>

    <table v-else class="hero-replay__facts">
      <thead>
        <tr>
          <th>attr</th>
          <th>value</th>
          <th>valid</th>
          <th>tx</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.fact"
          :class="{
            'is-new': row.tx === currentTx,
            'is-retracted': row.retractedAt !== null,
            'is-retracting': row.retractedAt === currentTx,
          }"
        >
          <td>{{ row.attribute }}</td>
          <td class="hero-replay__value">{{ row.value }}</td>
          <td>{{ row.valid }}</td>
          <td>
            {{ row.tx
            }}<span v-if="row.retractedAt !== null" class="hero-replay__retracted">
              ✕ {{ row.retractedAt }}</span
            >
          </td>
        </tr>
      </tbody>
    </table>

    <p class="hero-replay__caption" aria-live="polite">
      <span aria-hidden="true">&gt;</span> {{ current.caption }}
    </p>
  </figure>
</template>

<style scoped>
.hero-replay {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  border-radius: 8px;
  color: var(--th-win-ink);
  background: var(--th-win-bg);
  box-shadow: var(--th-shadow);
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
}
.hero-replay__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 18px;
  border-bottom: 1px solid var(--th-win-line);
  color: var(--th-win-muted);
}
.hero-replay__bar > span:nth-child(2) {
  flex: 1;
}
.hero-replay__dots {
  display: inline-flex;
  gap: 6px;
}
.hero-replay__dots i {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #4a554e;
}
.hero-replay__toggle {
  min-width: 28px;
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--th-win-muted);
  font-size: 10px;
}
.hero-replay__toggle:hover,
.hero-replay__toggle:focus-visible {
  color: var(--th-win-ink);
  background: var(--th-win-raised);
}

.hero-replay__steps {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  border-bottom: 1px solid var(--th-win-line);
}
.hero-replay__steps button {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 4px;
  color: var(--th-win-muted);
  font-size: 11.5px;
  border-right: 1px solid var(--th-win-line);
}
.hero-replay__steps button:last-child {
  border-right: 0;
}
.hero-replay__steps button[aria-pressed="true"] {
  color: var(--th-win-ink);
  background: var(--th-win-raised);
}
.hero-replay__steps button.is-done {
  color: #b7c1ba;
}
.hero-replay__num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  font-size: 10px;
  border: 1px solid currentColor;
}
.hero-replay__steps button[aria-pressed="true"] .hero-replay__num {
  color: var(--th-win-bg);
  background: var(--th-win-accent);
  border-color: var(--th-win-accent);
}
.hero-replay__progress {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  width: 100%;
  background: var(--th-win-accent);
  transform-origin: left;
  animation: hr-progress linear forwards;
}

.hero-replay__code {
  height: 196px;
  margin: 0;
  padding: 14px 18px;
  overflow: hidden;
  line-height: 1.6;
  white-space: pre;
}
.hero-replay__code code {
  display: block;
  font-size: 11.5px;
  color: var(--th-win-ink);
}
.hero-replay__line {
  display: block;
  animation: hr-type 360ms ease-out both;
}
.hero-replay__code :deep(.hr-c) {
  color: var(--th-win-muted);
  font-style: italic;
}
.hero-replay__code :deep(.hr-s) {
  color: #a8d8a0;
}
.hero-replay__code :deep(.hr-k) {
  color: #e0a8d8;
}
.hero-replay__code :deep(.hr-t) {
  color: var(--th-win-accent);
}
.hero-replay__code :deep(.hr-n) {
  color: #e3b55b;
}

.hero-replay__divider {
  display: flex;
  justify-content: space-between;
  padding: 7px 18px;
  border-block: 1px solid var(--th-win-line);
  color: var(--th-win-muted);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  background: var(--th-win-raised);
}

.hero-replay__facts {
  display: table;
  width: 100%;
  min-height: 176px;
  margin: 0;
  border-collapse: collapse;
}
.hero-replay__facts th,
.hero-replay__facts td {
  border: 0;
  padding: 6px 18px;
  text-align: left;
  font-size: 12px;
  white-space: nowrap;
}
.hero-replay__facts tr,
.hero-replay__facts tr:nth-child(2n) {
  border: 0;
  background: transparent;
}
.hero-replay__facts thead,
.hero-replay__facts thead tr {
  background: transparent;
}
.hero-replay__facts th {
  background: transparent;
  color: var(--th-win-muted);
  font-weight: 500;
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.hero-replay__facts td {
  color: var(--th-win-ink);
  transition:
    color 400ms,
    opacity 400ms;
}
.hero-replay__value {
  color: #a8d8a0 !important;
}
.hero-replay__facts tr.is-new td {
  animation: hr-flash 1400ms ease-out;
}
.hero-replay__facts tr.is-retracted td {
  color: var(--th-win-muted);
  opacity: 0.7;
  text-decoration: line-through;
  text-decoration-color: rgba(239, 138, 111, 0.7);
}
.hero-replay__facts tr.is-retracted .hero-replay__value {
  color: var(--th-win-muted) !important;
}
.hero-replay__facts tr.is-retracting td {
  animation: hr-strike 900ms ease-out;
}
.hero-replay__retracted {
  display: inline-block;
  margin-left: 6px;
  color: #ef8a6f;
  text-decoration: none;
}

.hero-replay__schema {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 10px;
  min-height: 176px;
  padding: 0 18px;
}
.hero-replay__schema span {
  animation: hr-type 400ms ease-out both;
}
.hero-replay__schema span:nth-child(2) {
  animation-delay: 150ms;
}
.hero-replay__schema span:nth-child(3) {
  animation-delay: 300ms;
}
.hero-replay__schema code {
  padding: 0;
  color: var(--th-win-accent);
  background: none;
  font-size: 12px;
}
.hero-replay__release {
  align-self: flex-start;
  padding: 3px 10px;
  border-radius: 999px;
  color: #c9b6f2;
  background: rgba(201, 182, 242, 0.12);
}

.hero-replay__ask {
  display: grid;
  grid-template-columns: 1fr 1fr;
  min-height: 176px;
}
.hero-replay__ask > div {
  padding: 14px 18px;
  animation: hr-type 450ms ease-out both;
}
.hero-replay__ask > div.is-now {
  border-left: 1px solid var(--th-win-line);
  animation-delay: 250ms;
}
.hero-replay__ask p {
  margin: 0;
  line-height: 1.5;
}
.hero-replay__ask-head {
  color: var(--th-win-muted);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.hero-replay__ask-value {
  margin-top: 8px !important;
  color: var(--th-win-ink);
  font-family: var(--vp-font-family-base);
  font-size: 20px;
  font-weight: 650;
}
.hero-replay__ask-sub {
  color: #a8d8a0;
}
.hero-replay__ask-note {
  margin-top: 10px !important;
  color: var(--th-win-muted);
}
.hero-replay__ask-why {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 10px !important;
  color: #c9b6f2;
  font-size: 11px;
}

.hero-replay__caption {
  margin: 0;
  padding: 10px 18px 12px;
  border-top: 1px solid var(--th-win-line);
  color: var(--th-win-muted);
  font-size: 11.5px;
  line-height: 1.5;
  min-height: 3.6em;
}
.hero-replay__caption span {
  color: var(--th-win-accent);
}

@keyframes hr-progress {
  from {
    transform: scaleX(0);
  }
  to {
    transform: scaleX(1);
  }
}
@keyframes hr-type {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes hr-flash {
  0% {
    background: rgba(159, 192, 255, 0.22);
  }
  100% {
    background: transparent;
  }
}
@keyframes hr-strike {
  0% {
    text-decoration-color: transparent;
    opacity: 1;
  }
  100% {
    text-decoration-color: rgba(239, 138, 111, 0.7);
    opacity: 0.7;
  }
}

@media (prefers-reduced-motion: reduce) {
  .hero-replay *,
  .hero-replay *::before {
    animation: none !important;
    transition: none !important;
  }
}
@media (max-width: 520px) {
  .hero-replay__steps button {
    flex-direction: column;
    gap: 2px;
    font-size: 10.5px;
  }
  .hero-replay__facts th,
  .hero-replay__facts td {
    padding: 6px 10px;
  }
  .hero-replay__code {
    height: 170px;
    padding: 12px;
    font-size: 11px;
    overflow-x: auto;
  }
}
</style>
