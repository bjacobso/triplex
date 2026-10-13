---
layout: home
title: Triplex · The database that remembers why
titleTemplate: false
description: An embedded fact database for TypeScript back-office systems. Every write records who made it, which versioned rules governed it, and when it was true.
sidebar: false
aside: false
pageClass: triplex-index
---

<div class="triplex-home">

<header class="triplex-home__intro">
<div class="triplex-home__hero-copy">
<p class="triplex-home__eyebrow"><span class="triplex-home__dot" aria-hidden="true"></span> An embedded fact database · TypeScript + Effect</p>
<div class="triplex-home__wordmark" aria-hidden="true">triplex<span>_</span></div>
<h1>The database that remembers why.</h1>
<p class="triplex-home__tagline">Facts change. Rules change. Your record of what happened shouldn’t.</p>
<p class="triplex-home__detail">Triplex keeps facts, time, and versioned rules together. Every write records <strong>who acted</strong>, <strong>which rules applied</strong>, and <strong>when it was true</strong>. Audit questions and open work become queries instead of investigations.</p>

<div class="triplex-home__actions">
<a class="triplex-home__primary" href="/getting-started">Get started<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
<a class="triplex-home__secondary triplex-home__button" href="#one-scenario">Follow one decision <span aria-hidden="true">↓</span></a>
</div>
<p class="triplex-home__status">Pre-1.0 · MIT licensed · In-memory + SQLite supported<br>PostgreSQL is a production candidate · <a href="/current-state">Current state ↗</a></p>
</div>
<DecisionTrace />
</header>

<div class="triplex-home__install">
<span class="triplex-home__eyebrow">Start in your process</span>

```sh
npm install @triplex-build/triplex effect@4.0.3
```

<span class="triplex-home__install-note">Effect 4 required · <a href="/getting-started">First program →</a></span>

</div>

<nav class="triplex-home__strip" aria-label="What Triplex keeps together">
<a href="#what-did-we-know"><span class="triplex-home__strip-symbol" aria-hidden="true">t₁ / t₂</span><strong>Two clocks.</strong><span>What was true. What you knew.</span></a>
<a href="#which-rules"><span class="triplex-home__strip-symbol" aria-hidden="true">#</span><strong>Pinned rules.</strong><span>The release behind every decision.</span></a>
<a href="#what-happens-next"><span class="triplex-home__strip-symbol" aria-hidden="true">=&gt;</span><strong>Derived work.</strong><span>What should happen next.</span></a>
</nav>

<aside class="triplex-home__agents" aria-labelledby="for-agents">
<h2 id="for-agents">Reading this as a coding agent?</h2>
<p>Start with the <a href="/agents">Modeling guide for agents</a>. Get the index at <a href="/llms.txt">/llms.txt</a>, every guide at <a href="/llms-full.txt">/llms-full.txt</a>, or append <code>.md</code> to any page URL. The <a href="/tools">CLI</a> prints JSON.</p>
</aside>

<section class="triplex-home__section" aria-labelledby="the-problem">
<div class="triplex-home__section-intro">
<p class="triplex-home__eyebrow">00 / The missing context</p>
<h2 id="the-problem">“Why?” is the most expensive question a back-office system gets asked.</h2>
<p>An auditor asks: <em>was Maria trained for the Harbor site on the day she started there?</em> In a typical stack, the evidence is spread across systems that never shared an identity model or a clock.</p>
</div>

| Where the evidence usually lives | What it can no longer tell you                                          |
| -------------------------------- | ----------------------------------------------------------------------- |
| Application database             | The training row was corrected in place, so the original belief is gone |
| Config service or repository     | The placement rules have changed since. Which version applied?          |
| Audit log                        | Who acted, but not the facts they saw or the rules they were held to    |
| Job queue                        | Whether a training task should have existed, and when it should reopen  |

<p class="triplex-home__fit">Triplex keeps facts, versioned rules, the causal journal, and derived work in one store with one identity model and one clock. The auditor’s question becomes a query.</p>
</section>

<section class="triplex-home__section triplex-home__code" aria-labelledby="one-scenario">
<div class="triplex-home__section-intro">
<p class="triplex-home__eyebrow">01 / One scenario, start to finish</p>
<h2 id="one-scenario">Maria, the Harbor site, and a certificate that was wrong.</h2>
<p>Maria is trained for Harbor from March 1 to June 1 and placed there on March 2 under release <code>hr-2026.1</code>. The rules then change: <code>hr-2026.2</code> requires a supervisor on every placement. Later, an auditor finds that the certificate actually began on March 5.</p>
<p>Every snippet is type-checked. Every output is produced by <a href="https://github.com/bjacobso/triplex/tree/main/docs/snippets/home/site-safety">running this scenario in CI</a>. The database’s own journal reads:</p>
</div>

<div class="triplex-home__timeline">

<!--@include: ./snippets/home/site-safety/output/timeline.md-->

</div>

<article class="triplex-home__example" aria-labelledby="record-a-command">
<div class="triplex-home__example-description">
<p class="triplex-home__eyebrow">00 · Record</p>
<h3 id="record-a-command">One command, one atomic transaction.</h3>
<p>Dana’s placement records who acted, a command ID that makes retries safe, a correlation ID, and the release that governed the write. The constraints come from that same release and are checked in the same transaction.</p>
<p>Nothing is overwritten. The auditor’s correction retracts the old belief and asserts the new one, and the journal keeps both.</p>
<a href="/operational-primitives">Transactions and the journal<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
</div>
<div class="triplex-home__snippet">

<<< @/snippets/home/site-safety/record.ts#place

</div>
</article>
</section>

<section class="triplex-home__section triplex-home__code" aria-labelledby="three-questions">
<div class="triplex-home__section-intro">
<p class="triplex-home__eyebrow">02 / Three questions, three queries</p>
<h2 id="three-questions">Ask what you knew, which rules applied, and what happens next.</h2>
<p>Each answer below is the real output of the code beside it.</p>
</div>

<article class="triplex-home__example" aria-labelledby="what-did-we-know">
<div class="triplex-home__example-description">
<p class="triplex-home__eyebrow">01 · What did we know?</p>
<h3 id="what-did-we-know">Two clocks: when it was true, and when you learned it.</h3>
<p><code>validAt</code> is the day in question. <code>recordedAt</code> is the instant of Dana’s receipt. At that instant, the record said Maria was trained. Today, after the correction, it says she was not.</p>
<p>Both answers can be proven. Dana acted in good faith on a record that was later corrected.</p>
<a href="/concepts#recorded-time-and-valid-time">Recorded time and valid time<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
</div>
<div class="triplex-home__snippet">

<<< @/snippets/home/site-safety/what-we-knew.ts

<p class="triplex-home__output-label">Output</p>

<<< @/snippets/home/site-safety/output/what-we-knew.json

</div>
</article>

<article class="triplex-home__example" aria-labelledby="which-rules">
<div class="triplex-home__example-description">
<p class="triplex-home__eyebrow">02 · Which rules applied?</p>
<h3 id="which-rules">Every receipt is pinned to an immutable release.</h3>
<p>The <code>live</code> ref has moved to <code>hr-2026.2</code>, but Dana’s placement still points at <code>hr-2026.1</code>, the content-addressed release that governed it.</p>
<p>The same kind of command under today’s rules is rejected atomically. The rejected command writes no facts, no receipt, and no journal entry.</p>
<a href="/configuration-versioning">Releases, refs, and rollback<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
</div>
<div class="triplex-home__snippet">

<<< @/snippets/home/site-safety/which-rules.ts

<p class="triplex-home__output-label">Output</p>

<<< @/snippets/home/site-safety/output/which-rules.json

<p class="triplex-home__output-label">The same command under <code>hr-2026.2</code></p>

<<< @/snippets/home/site-safety/output/rejected.json

</div>
</article>

<article class="triplex-home__example" aria-labelledby="what-happens-next">
<div class="triplex-home__example-description">
<p class="triplex-home__eyebrow">03 · What needs to happen?</p>
<h3 id="what-happens-next">Open work is a query over facts.</h3>
<p>The obligation is a Datalog derivation: a placed worker without current training for that site.</p>
<p>On March 3, the corrected record exposes a gap, so the task is open. On April 1 nothing is open, and the evaluation reports when that can next change. On June 1 the training expires and the task reopens, even though nobody wrote anything.</p>
<p><code>recheckOn</code> comes from <code>nextTemporalBoundary</code>. Schedule a wake-up for that date instead of polling.</p>
<a href="/derivations">Derivations and reconciliation<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
</div>
<div class="triplex-home__snippet">

<<< @/snippets/home/site-safety/open-work.ts

<p class="triplex-home__output-label">Output for March 3, April 1, and June 1</p>

<<< @/snippets/home/site-safety/output/open-work.json

</div>
</article>
</section>

<section class="triplex-home__section" aria-labelledby="work-is-a-query">
<div class="triplex-home__section-intro">
<p class="triplex-home__eyebrow">03 / Derived work</p>
<h2 id="work-is-a-query">Stop enqueuing obligations. Reconcile them.</h2>
<p>Most back-office bugs come down to a task that should exist but doesn’t, or one that exists but shouldn’t. Event handlers create work one step at a time and drift out of sync with the data. A derivation states what should be true, and reconciliation reports the difference.</p>
</div>

|                   | Event handlers that enqueue tasks       | Triplex derivations                                                |
| ----------------- | --------------------------------------- | ------------------------------------------------------------------ |
| Source of truth   | Whatever each handler remembered to do  | A Datalog query over facts, pinned to a release                    |
| Late corrections  | Missed unless someone re-runs a handler | Appear on the next evaluation, even for past dates                 |
| Expiring evidence | A separate cron job per rule            | `nextTemporalBoundary` says exactly when to re-evaluate            |
| Duplicates        | Hand-built idempotency                  | Stable, content-addressed candidate IDs                            |
| Explanation       | Log lines                               | Each candidate carries its source facts and assertion transactions |
| Change            | Diff it yourself                        | `Derivation.reconcile` returns `added`, `removed`, and `changed`   |

<div class="triplex-home__principles">
<div>
<h3>Triplex owns</h3>
<p>Facts, history, and the temporal read basis. Atomic transactions, command receipts, and the ordered journal. Release identity and constraint enforcement. Derivation candidates, provenance, and reconciliation diffs. Consumer checkpoints and wake-up boundaries.</p>
</div>
<div>
<h3>Your application owns</h3>
<p>Domain vocabulary and entity IDs. Authentication, authorization, and HTTP handlers. What a release contains and when <code>live</code> moves. What each reconciliation diff means: a ticket, an email, a workflow. Timer delivery and retries.</p>
</div>
<div>
<h3>See it end to end</h3>
<p>The <a href="https://github.com/bjacobso/triplex/tree/main/examples/compliance-host">compliance host example</a> adds durable task occurrences, a journal consumer with a checkpoint, a hypothetical preview, and a scheduler that reopens work at expiry. Read <a href="/host-integration">Host integration</a> for the full boundary.</p>
</div>
</div>
</section>

<section class="triplex-home__section" aria-labelledby="modeling">
<div class="triplex-home__section-intro">
<p class="triplex-home__eyebrow">04 / Modeling</p>
<h2 id="modeling">From a back-office domain to Triplex primitives.</h2>
<p>Most back-office systems are built from the same parts. This is where each part goes.</p>
</div>

| In your domain                          | In Triplex                                                             | In the scenario                  |
| --------------------------------------- | ---------------------------------------------------------------------- | -------------------------------- |
| Things: workers, sites, cases, accounts | Stable `EntityId`s and an `EntityType` per kind                        | `worker:maria`, `Worker`         |
| Properties and relationships            | Global `Attribute` keys, with `Attribute.ref` for relationships        | `:placement/site`                |
| Schemas, policies, forms                | Config nodes committed as an immutable release, pointed to by `live`   | `hr-2026.1`, `hr-2026.2`         |
| User and system actions                 | One `transact` per command with `actor`, `commandId`, `configSnapshot` | `placement:create:maria-harbor`  |
| Evidence that starts or expires         | `validFrom` and `validTo` on the assertion                             | Training valid March 1 to June 1 |
| Corrections                             | Retract and assert in one transaction; history is kept                 | The auditor’s fix                |
| Obligations and to-dos                  | A `Derivation` whose candidates you reconcile                          | `task.site-safety-training`      |
| Tickets, notifications, SLAs            | Your code, driven by reconciliation diffs and wake-up boundaries       | Host-owned                       |
| Audit questions                         | A temporal basis, command receipts, and the journal                    | Questions 01 and 02              |

<p class="triplex-home__fit"><a href="/agents">Read the full modeling guide<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a></p>
</section>

<section class="triplex-home__section" aria-labelledby="runs-where">
<div class="triplex-home__section-intro">
<p class="triplex-home__eyebrow">05 / Deployment</p>
<h2 id="runs-where">A library, not another server.</h2>
<p>Triplex runs inside your process as Effect layers. Switching storage changes the layer you provide, and the rest of the program stays the same. On PostgreSQL, Triplex can share your application’s transaction, so your own rows, Triplex facts, the journal, and an outbox row commit or roll back together.</p>
</div>

<<< @/snippets/home/layers.ts

| Runtime                    | Package                           | Status                          |
| -------------------------- | --------------------------------- | ------------------------------- |
| In-memory KV               | `@triplex-build/triplex`          | Supported: tests, browser, edge |
| SQLite                     | `@triplex-build/triplex-sqlite`   | Supported durable baseline      |
| PostgreSQL                 | `@triplex-build/triplex-postgres` | Pre-1.0 production candidate    |
| Cloudflare Durable Objects | private workspace package         | Experimental                    |
| FoundationDB               | private workspace package         | Experimental                    |

<p class="triplex-home__fit">Want to build on another storage engine? Explore the <a href="/backends">backend blueprints</a>: working SQLite, experimental FoundationDB, and proposed Datomic and XTDB adapters. Each maps storage primitives to the Triplex contract and identifies what still needs to be built.</p>

<p class="triplex-home__fit">Also in the box: a JSON-first <a href="/tools">CLI</a> for agents, a browser <a href="/explorer">data explorer</a>, a <a href="/http-api">configuration-derived HTTP API</a> with OpenAPI, and an in-browser <a href="/playground">playground</a>.</p>
</section>

<section class="triplex-home__section" aria-labelledby="fit">
<div class="triplex-home__section-intro">
<p class="triplex-home__eyebrow">06 / Fit</p>
<h2 id="fit">When to use Triplex, and when not to.</h2>
</div>
<div class="triplex-home__principles">
<div>
<h3>Good fit</h3>
<p>Compliance and onboarding, eligibility and entitlements, policy engines, case management, and back-office workflows. Any domain where “as of when?” and “under which rules?” come up regularly. Also agent-driven systems that need a durable world model with an attributed record of every change.</p>
</div>
<div>
<h3>Not a fit</h3>
<p>High-volume telemetry, blob storage, caches, and queues. Also workloads that only need a relational table and never ask about history or provenance. Triplex is a system of record for facts, not a replacement for every table.</p>
</div>
<div>
<h3>How it relates</h3>
<p><a href="/datomic">Datomic</a> offers facts, Datalog, and historical database views. <a href="/xtdb">Current XTDB</a> offers bitemporal data through SQL and XTQL. Triplex embeds in TypeScript and connects facts to versioned rules and reconciled work. <strong>Event sourcing</strong> gives you history, but you hand-write every projection. <strong>Workflow engines</strong> run durable code; Triplex decides what work should exist, and the two compose.</p>
</div>
</div>
</section>

<section class="triplex-home__family" aria-labelledby="family-title">
<p class="triplex-home__eyebrow">07 / Part of the WorldVM family</p>
<div class="triplex-home__family-head">
<h2 id="family-title">A memory for your world.</h2>
<p>Small experiments in software you can inspect, explain, and build on. Triplex keeps the facts. These projects explore the language and models around them.</p>
</div>
<div class="triplex-home__family-grid">
<a class="no-icon" href="https://github.com/bjacobso/forma" style="--project-color: #c6bed9"><span class="triplex-home__swatch" aria-hidden="true"></span><strong>Forma ↗</strong><span>A typed Lisp for building your own domain language.</span></a>
<a class="no-icon" href="https://schematics.run" style="--project-color: #b794f6"><span class="triplex-home__swatch" aria-hidden="true"></span><strong>Schematics ↗</strong><span>Small Effect libraries that make application rules inspectable.</span></a>
<a class="no-icon" href="https://open-ontology.com" style="--project-color: #b7c8a4"><span class="triplex-home__swatch" aria-hidden="true"></span><strong>Open Ontology ↗</strong><span>Configuration as code, checked across platforms.</span></a>
</div>
<a class="triplex-home__family-link no-icon" href="https://worldvm.com/">Meet the whole family at worldvm.com ↗</a>
</section>

<nav class="triplex-home__guides" aria-label="Guides">
<a href="/getting-started">Quickstart<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
<a href="/agents">Modeling guide<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
<a href="/concepts">Core concepts<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
<a href="/datalog">Datalog<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
<a href="/configuration">Typed configuration<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
<a href="/derivations">Derivations<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
<a href="/host-integration">Host integration<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
<a href="/current-state">Current state<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
</nav>
</div>
