/**
 * The explorer's logic. Everything on the page is computed by the real package
 * in the browser - no fixtures, no recorded output. That is only possible
 * because `ContentId` uses a hand-written SHA-256 rather than `node:crypto`;
 * the page is the proof that the kernel is genuinely browser-safe.
 */

import { Effect } from "effect";

import {
  ConfigNode,
  Evaluate,
  InMemoryConfigStore,
  Reactor,
  World,
} from "@triplex-build/triplex/config";
import * as OnboardingConfig from "./OnboardingConfig.js";

const { BASELINE, releaseWithRules, ruleSet } = OnboardingConfig;
type AccountConfig = OnboardingConfig.AccountConfig;

const DAY = 86_400_000;
const MARCH_3 = 1772496000000;
const EE = "ee_1";
const SSN = "123-45-6789";

const $ = (id: string) => document.getElementById(id)!;
const short = (cid: string) => cid.slice(7, 17);
const el = (tag: string, cls?: string, text?: string) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

// --- the scenario, as data --------------------------------------------------

interface Step {
  readonly label: string;
  readonly when: string;
  /** Applies the change and returns the observation keys it touched. */
  readonly apply: () => ReadonlyArray<string>;
  readonly note: string;
}

const QUESTIONS = {
  required: { label: "I-9 required?", expr: ruleSet(BASELINE)["i9-required"]! },
  satisfied: {
    label: "I-9 satisfied?",
    expr: ruleSet(BASELINE)["i9-satisfied"]!,
  },
  overdue: { label: "I-9 overdue?", expr: ruleSet(BASELINE)["i9-overdue"]! },
} as const;

type State = {
  v1: Awaited<ReturnType<typeof buildRelease>>;
  world: World.World;
  now: number;
  reactor: Reactor.Reactor;
  cursor: number;
  last: { considered: ReadonlyArray<string>; flipped: ReadonlyArray<Reactor.Flip> } | undefined; // prettier-ignore
  tampered: boolean;
  published: boolean;
};

const buildRelease = (config: AccountConfig, label: string, store = InMemoryConfigStore.empty()) =>
  // prettier-ignore
  Effect.runSync(releaseWithRules(store, label, config));

let s: State;
let steps: ReadonlyArray<Step>;

const envOf = (catalog = s.v1.catalog) =>
  Evaluate.env(s.world, { now: s.now, granularity: "day" }, catalog, EE);

const reset = () => {
  const v1 = buildRelease(BASELINE, "2026.1");
  s = {
    v1,
    world: World.make({
      [`${EE}/role`]: "caregiver",
      [`${EE}/start_date`]: MARCH_3 + 3 * DAY,
    }),
    now: MARCH_3,
    reactor: Reactor.empty,
    cursor: 0,
    last: undefined,
    tampered: false,
    published: false,
  };

  for (const [key, q] of Object.entries(QUESTIONS)) {
    s.reactor = Reactor.register(s.reactor, key, q.expr, envOf());
  }

  steps = [
    {
      label: "Employee submits their SSN",
      when: "Mar 3",
      note: "Two questions read it, and neither moves — half of section 1 is not section 1. Reconsidered is not the same as changed.",
      apply: () => {
        s.world = World.withFact(s.world, EE, "ssn", SSN);
        return [Reactor.factKey(EE, "ssn")];
      },
    },
    {
      label: "Employee uploads work authorisation",
      when: "Mar 3",
      note: "Section 1 is complete. Still unsatisfied: section 2 is the employer's half, and nobody has done it.",
      apply: () => {
        s.world = World.withFact(s.world, EE, "work_auth", "passport");
        return [Reactor.factKey(EE, "work_auth")];
      },
    },
    {
      label: "The start date passes",
      when: "Mar 7",
      note: "A clock tick is an input like any other, and it reaches only the question that asked about days. The other two are not even considered.",
      apply: () => {
        s.now = MARCH_3 + 4 * DAY;
        return [Reactor.clockKey("day")];
      },
    },
    {
      label: "Employer verifies section 2",
      when: "Mar 7",
      note: "All three answers move at once. The decision that says 'satisfied' is now something we can hand to an auditor.",
      apply: () => {
        s.world = World.withFact(s.world, EE, "i9_verified_at", s.now);
        return [Reactor.factKey(EE, "i9_verified_at")];
      },
    },
  ];

  s.last = undefined;
  render();
};

// --- rendering --------------------------------------------------------------

const tile = (k: string, v: string, sub?: string, live = false) => {
  const t = el("div", "tile" + (live ? " is-live" : ""));
  t.append(el("div", "k", k), el("div", "v", v));
  if (sub) t.append(el("div", "sub", sub));
  return t;
};

const renderRelease = () => {
  const snap = s.v1.snapshot;
  const walked = [...ConfigNode.walk(snap.root)].length;
  const distinct = ConfigNode.flatten(snap.root).size;
  const rules = s.v1.store.revisions.filter((r) => r.kind === "rule").length;

  const host = $("release-tiles");
  host.replaceChildren(
    tile("Release", snap.label),
    tile("Objects in the snapshot", String(snap.revisionIds.length)),
    tile("Of which rules", String(rules)),
    tile("Nodes walked", String(walked), `${distinct} distinct`),
  );

  const note = $("release-note");
  note.replaceChildren(
    document.createTextNode("ConfigSnapshot id "),
    el("span", "cid", short(snap.rootCid)),
    document.createTextNode(
      ` — two accounts on this release are in sync if and only if this matches. ${walked - distinct} of the ${walked} nodes walked are shared subtrees, stored once.`,
    ),
  );
};

const renderTimeline = () => {
  const host = $("timeline");
  host.replaceChildren();
  steps.forEach((step, i) => {
    const li = el("li", i < s.cursor ? "done" : i === s.cursor ? "now" : "");
    li.append(document.createTextNode(step.label), el("span", "when", step.when));
    host.append(li);
  });
  if (s.cursor >= steps.length) {
    host.append(el("li", "done", "Complete"));
  }
};

const renderAnswers = () => {
  const flippedKeys = new Set((s.last?.flipped ?? []).map((f) => f.key));
  const consideredKeys = new Set(s.last?.considered ?? []);
  const host = $("answers");
  host.replaceChildren();

  for (const [key, q] of Object.entries(QUESTIONS)) {
    const truth = Reactor.answer(s.reactor, key)?.truth ?? "unknown";
    const row = el("div", "answer" + (flippedKeys.has(key) ? " moved" : ""));
    row.append(el("span", `dot t-${truth}`));
    row.append(el("span", "q", q.label));
    // The word carries the meaning; the dot only reinforces it.
    row.append(el("span", "a", truth));
    if (flippedKeys.has(key)) row.append(el("span", "flag", "flipped"));
    else if (consideredKeys.has(key)) row.append(el("span", "flag", "reconsidered")); // prettier-ignore
    host.append(row);
  }
};

const renderStep = () => {
  const host = $("step-tiles");
  const done = s.cursor > 0;
  host.replaceChildren(
    tile("Watching", String(s.reactor.registrations.size), "registrations"),
    tile("Considered", done ? String(s.last?.considered.length ?? 0) : "—", "recomputed", done), // prettier-ignore
    tile("Flipped", done ? String(s.last?.flipped.length ?? 0) : "—", "actually changed", done), // prettier-ignore
  );
  $("step-note").textContent = done
    ? (steps[s.cursor - 1]?.note ?? "")
    : "Nothing submitted yet. The employee is a caregiver, so the I-9 applies, and it is unsatisfied because we know nothing.";
  ($("step") as HTMLButtonElement).disabled = s.cursor >= steps.length;
};

const truthOf = (node: Evaluate.Evaluation) => node.truth;

const renderTree = () => {
  const host = $("tree");
  host.replaceChildren();
  const decision = Reactor.answer(s.reactor, "satisfied");
  if (!decision) return;

  const build = (node: Evaluate.Evaluation, label: string): HTMLElement => {
    const li = el("li");
    const row = el("div", "row");
    row.append(el("span", `dot t-${truthOf(node)}`));
    row.append(el("span", "lbl", label));
    row.append(el("span", "a", truthOf(node)));
    row.append(el("span", "cid", short(node.cid)));
    if (node.reason) row.append(el("span", "why", node.reason));
    li.append(row);

    if (node.children.length > 0) {
      const ul = el("ul");
      node.children.forEach((child, i) => ul.append(build(child, `child ${i + 1}`))); // prettier-ignore
      li.append(ul);
    }
    return li;
  };

  host.append(build(tamperedView(decision), "i9-satisfied"));
};

/** A displayed copy with one leaf's answer flipped, to show verify catching it. */
const tamperedView = (node: Evaluate.Evaluation): Evaluate.Evaluation => {
  if (!s.tampered) return node;
  return {
    ...node,
    children: node.children.map((c, i) =>
      i === 0 ? { ...c, truth: c.truth === "true" ? "false" : "true" } : c,
    ),
  };
};

const render = () => {
  renderRelease();
  renderTimeline();
  renderAnswers();
  renderStep();
  renderTree();
};

// --- interactions -----------------------------------------------------------

$("step").addEventListener("click", () => {
  if (s.cursor >= steps.length) return;
  const step = steps[s.cursor];
  if (!step) return;
  const changed = step.apply();
  const reaction = Reactor.react(s.reactor, changed, envOf());
  s.reactor = reaction.reactor;
  s.last = { considered: reaction.considered, flipped: reaction.flipped };
  s.cursor++;
  $("verify-out").textContent = "";
  render();
});

$("reset").addEventListener("click", () => {
  $("verify-out").textContent = "";
  $("replay-out").textContent = "";
  $("diff-out").replaceChildren();
  ($("publish") as HTMLButtonElement).disabled = true;
  reset();
});

$("verify").addEventListener("click", () => {
  const decision = Reactor.answer(s.reactor, "satisfied");
  const out = $("verify-out");
  if (!decision) return;

  const problems = Evaluate.verify(tamperedView(decision));
  out.className = problems.length === 0 ? "verdict ok" : "verdict bad";
  out.replaceChildren();
  if (problems.length === 0) {
    out.append(el("b", undefined, "Verified."));
    out.append(
      document.createTextNode(
        " Every id recomputes from the tree's own contents. Nothing edited it.",
      ),
    );
  } else {
    const problem = problems[0]!;
    out.append(el("b", undefined, `Tampered at ${problem.path}.`));
    out.append(
      document.createTextNode(
        ` Claimed ${short(problem.claimed)}, recomputes to ${short(problem.actual)}. The edit breaks the root, so it cannot be passed off as the original.`,
      ),
    );
  }
});

$("tamper").addEventListener("click", () => {
  s.tampered = true;
  $("verify-out").textContent = "";
  render();
});
$("untamper").addEventListener("click", () => {
  s.tampered = false;
  $("verify-out").textContent = "";
  render();
});

let v2: ReturnType<typeof buildRelease> | undefined;

$("propose").addEventListener("click", () => {
  const widened: AccountConfig = { ...BASELINE, i9AppliesTo: "everyone" };
  v2 = buildRelease(widened, "2026.2", s.v1.store);

  const changes = InMemoryConfigStore.changesBetween(v2.store, s.v1.snapshot, v2.snapshot); // prettier-ignore
  const affected = Reactor.affected(s.reactor, [Reactor.ruleKey("i9-applies")]);

  const host = $("diff-out");
  host.replaceChildren();

  const table = el("table");
  const head = el("tr");
  for (const h of ["What changed", "Kind", "Data moved", "Because a dependency moved"]) {
    // prettier-ignore
    head.append(el("th", undefined, h));
  }
  table.append(head);
  for (const c of changes) {
    if (c._tag !== "ObjectChanged") continue;
    const tr = el("tr");
    tr.append(el("td", undefined, c.key));
    tr.append(el("td", undefined, c.kind));
    tr.append(el("td", undefined, c.dataChanged ? "yes" : "no"));
    tr.append(el("td", undefined, c.closureChanged ? "yes" : "no"));
    table.append(tr);
  }
  host.append(table);

  const p = el("p", "note");
  p.textContent =
    `No form, page, field, policy or automation revision moved — only the rule that changed and the two that call it. ` +
    `Of the ${s.reactor.registrations.size} questions being watched, ${affected.length} read that rule: ${affected.join(", ")}. ` +
    `That is known before publishing, by lookup.`;
  host.append(p);

  ($("publish") as HTMLButtonElement).disabled = false;
});

$("publish").addEventListener("click", () => {
  if (!v2) return;
  const decision = Reactor.answer(s.reactor, "satisfied")!;
  const requirement = Reactor.answer(s.reactor, "required")!;

  const reaction = Reactor.react(s.reactor, [Reactor.ruleKey("i9-applies")], envOf(v2.catalog));
  s.reactor = reaction.reactor;
  s.last = { considered: reaction.considered, flipped: reaction.flipped };
  s.published = true;

  const clock = { now: s.now, granularity: "day" as const };
  const satisfiedStill = Evaluate.replay(QUESTIONS.satisfied.expr, decision, s.world, clock, v2.catalog, EE); // prettier-ignore
  const requiredStill = Evaluate.replay(QUESTIONS.required.expr, requirement, s.world, clock, v2.catalog, EE); // prettier-ignore

  const out = $("replay-out");
  out.className = "verdict";
  out.replaceChildren();
  out.append(el("b", undefined, "Pinning is precise, not blunt."));
  out.append(
    document.createTextNode(
      ` This employee is a caregiver either way, so ${reaction.considered.length} answers were reconsidered and ${reaction.flipped.length} changed. ` +
        `The "satisfied" decision never resolved the rule that moved, so it still replays under 2026.2 (${satisfiedStill}). ` +
        `The "required" decision did, so it refuses (${requiredStill}) — a later edit cannot be passed off as what was in force at the time. ` +
        `Both still verify: nobody tampered with either.`,
    ),
  );

  render();
});

// --- theme ------------------------------------------------------------------

const themeBtn = $("theme") as HTMLButtonElement;
const applyTheme = (mode: "light" | "dark") => {
  document.documentElement.dataset["theme"] = mode;
  themeBtn.textContent = mode === "dark" ? "Light" : "Dark";
};
themeBtn.addEventListener("click", () => {
  const dark = document.documentElement.dataset["theme"] === "dark";
  applyTheme(dark ? "light" : "dark");
});
applyTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

reset();
