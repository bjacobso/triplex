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

<header class="th-hero" aria-labelledby="hero-title">
<div class="th-hero__copy">
<p class="th-eyebrow">Triplex <span>· embedded fact database · pre-1.0</span></p>
<h1 id="hero-title">The database that remembers why.</h1>
<p class="th-sub">Facts change. Rules change. Your record of what happened shouldn’t.</p>
<p class="th-lead">Triplex keeps facts, time, and versioned rules together in your TypeScript process. Every write records <strong>who acted</strong>, <strong>which rules applied</strong>, and <strong>when it was true</strong>. Audit questions and open work become queries instead of investigations.</p>
<div class="th-actions">
<a class="th-button th-button--primary" href="/getting-started">Get started</a>
<a class="th-button" href="#one-scenario">See the whole stack ↓</a>
</div>
<div class="th-install">

```sh
npm install @triplex-build/triplex effect@4.1.1
```

</div>
<p class="th-hero__note">Effect 4 required · MIT licensed · In-memory and SQLite supported · PostgreSQL is a production candidate · <a href="/current-state">Current state</a></p>
</div>
<div class="th-hero__side">
<DecisionTrace />
</div>
</header>

<aside class="th-agents" aria-labelledby="for-agents">
<h2 id="for-agents">Reading this as a coding agent?</h2>
<p>Start with the <a href="/agents">Modeling guide for agents</a>. Get the index at <a href="/llms.txt">/llms.txt</a>, every guide at <a href="/llms-full.txt">/llms-full.txt</a>, or append <code>.md</code> to any page URL. The <a href="/tools">CLI</a> prints JSON.</p>
</aside>

<section class="th-statement" aria-labelledby="the-problem">
<p class="th-statement__big">“Why?” is the most expensive question a back-office system gets asked.</p>
<p>An auditor asks: <em>was Maria trained for the Harbor site on the day she started there?</em> In a typical stack, the evidence is spread across systems that never shared an identity model or a clock.</p>
<p>The training row was corrected in place. The placement rules have changed since. The audit log knows who acted, but not what they saw. The job queue can’t say whether a task should have existed.</p>
<h2 id="the-problem" class="th-statement__question">What if the answer were a query?</h2>
</section>

<section class="th-row" aria-labelledby="one-store">
<div class="th-row__head">
<p class="th-row__num">01</p>
<h2 id="one-store">One store, one identity model, one clock.</h2>
</div>
<div class="th-row__body">
<p>Each system holds part of the answer, and each one has lost something along the way.</p>
<div class="th-table">

| Where the evidence usually lives | What it can no longer tell you                                          |
| -------------------------------- | ----------------------------------------------------------------------- |
| Application database             | The training row was corrected in place, so the original belief is gone |
| Config service or repository     | The placement rules have changed since. Which version applied?          |
| Audit log                        | Who acted, but not the facts they saw or the rules they were held to    |
| Job queue                        | Whether a training task should have existed, and when it should reopen  |

</div>
<p>Triplex keeps facts, versioned rules, the causal journal, and derived work in one store. The auditor’s question becomes a query.</p>
<dl class="th-primitives">
<div><dt>t₁ / t₂</dt><dd><a href="#what-did-we-know">Two clocks.</a> What was true, and what you knew when.</dd></div>
<div><dt>#</dt><dd><a href="#which-rules">Pinned rules.</a> The release behind every decision.</dd></div>
<div><dt>=&gt;</dt><dd><a href="#what-happens-next">Derived work.</a> What should happen next.</dd></div>
</dl>
</div>
</section>

<section class="th-row" aria-labelledby="one-scenario">
<div class="th-row__head">
<p class="th-row__num">02</p>
<h2 id="one-scenario">From schema to REST API in one file.</h2>
</div>
<div class="th-row__body">
<p>Model, versioned rules, a command, an audit, open work, storage, and HTTP. Each step below is the next region of the <a href="https://github.com/bjacobso/triplex/blob/main/docs/snippets/home/site-safety/app.ts">same file</a>, in order. Every block is type-checked, and CI runs the file to produce every output on this page.</p>
<p class="th-story"><strong>The story.</strong> Maria is trained for Harbor from March 1 to June 1 and placed there on March 2 under release <code>hr-2026.1</code>. The rules then change: <code>hr-2026.2</code> requires a supervisor. Later, an auditor finds that the certificate actually began on March 5.</p>
</div>
<div class="th-row__wide">

<StackMap />

</div>
</section>

<div class="th-steps">

<article class="th-step" aria-labelledby="model">
<div class="th-step__head">
<p class="th-step__num">Step 01 <span>· Model</span></p>
<h3 id="model">Declare the domain once.</h3>
<p>Attributes are global, typed facts. Entity types say how each one is used: required, cardinality, and references.</p>
<p>Changing the rules means a new version of the type, not a migration. Old facts stay valid under the release that accepted them.</p>
<a class="th-more" href="/configuration#ontology-dsl">Typed configuration →</a>
</div>
<div class="th-window">
<div class="th-window__bar"><span class="th-window__dots" aria-hidden="true"><i></i><i></i><i></i></span><span>app.ts</span><span>model</span></div>

<<< @/snippets/home/site-safety/app.ts#model

</div>
</article>

<article class="th-step" aria-labelledby="which-rules">
<div class="th-step__head">
<p class="th-step__num">Step 02 <span>· Rules</span></p>
<h3 id="which-rules">Publish the rules as a release.</h3>
<p>A release is immutable and content-addressed. The story publishes <code>hr-2026.1</code> with <code>Placement</code>, then <code>hr-2026.2</code> with <code>PlacementV2</code>. Each time, <code>live</code> moves and every earlier release stays exactly as it was.</p>
<a class="th-more" href="/configuration-versioning">Releases, refs, and rollback →</a>
</div>
<div class="th-window">
<div class="th-window__bar"><span class="th-window__dots" aria-hidden="true"><i></i><i></i><i></i></span><span>app.ts</span><span>release</span></div>

<<< @/snippets/home/site-safety/app.ts#release

</div>
</article>

<article class="th-step" aria-labelledby="record-a-command">
<div class="th-step__head">
<p class="th-step__num">Step 03 <span>· Command</span></p>
<h3 id="record-a-command">One command, one atomic transaction.</h3>
<p><code>Placement.assert</code> turns typed attribute values into facts. Dana’s placement records who acted, a command ID that makes retries safe, and, through <code>GraphConstraint.pinned</code>, the release whose constraints were checked in the same transaction.</p>
<p>Under <code>hr-2026.2</code>, the same command is rejected. It writes no facts, no receipt, and no journal entry.</p>
<a class="th-more" href="/operational-primitives">Transactions and the journal →</a>
</div>
<div class="th-window">
<div class="th-window__bar"><span class="th-window__dots" aria-hidden="true"><i></i><i></i><i></i></span><span>app.ts</span><span>command</span></div>

<<< @/snippets/home/site-safety/app.ts#command

<div class="th-window__bar th-window__bar--run"><span>The same command under <code>hr-2026.2</code></span><span>rejected</span></div>

<<< @/snippets/home/site-safety/output/rejected.json

</div>
</article>

<div class="th-journal">
<div class="th-step__head">
<p class="th-step__num">Journal</p>
<h3 id="journal">After the whole story, the journal reads:</h3>
</div>
<div class="th-table th-table--mono">

<!--@include: ./snippets/home/site-safety/output/timeline.md-->

</div>
<p>Nothing is overwritten. The auditor’s correction at position 6 retracts the old belief and asserts the new one, and the journal keeps both. The rest of the story is in <a href="https://github.com/bjacobso/triplex/blob/main/docs/snippets/home/site-safety/story.ts">story.ts</a>.</p>
</div>

<article class="th-step" aria-labelledby="what-did-we-know">
<div class="th-step__head">
<p class="th-step__num">Step 04 <span>· Audit</span></p>
<h3 id="what-did-we-know">Ask what you knew, and under which rules.</h3>
<p><code>validAt</code> is the day in question. <code>recordedAt</code> is the instant of Dana’s receipt. At that instant, the record said Maria was trained. After the correction, it says she was not.</p>
<p>Both answers can be proven, and the receipt still points at <code>hr-2026.1</code> even though <code>live</code> has moved.</p>
<a class="th-more" href="/concepts#recorded-time-and-valid-time">Recorded time and valid time →</a>
</div>
<div class="th-window">
<div class="th-window__bar"><span class="th-window__dots" aria-hidden="true"><i></i><i></i><i></i></span><span>app.ts</span><span>ask</span></div>

<<< @/snippets/home/site-safety/app.ts#ask

<div class="th-window__bar th-window__bar--run"><span>Output</span><span>audit.json</span></div>

<<< @/snippets/home/site-safety/output/audit.json

</div>
</article>

<article class="th-step" aria-labelledby="what-happens-next">
<div class="th-step__head">
<p class="th-step__num">Step 05 <span>· Open work</span></p>
<h3 id="what-happens-next">Derive what needs to happen.</h3>
<p>The obligation is a Datalog query, not a queue. On March 3, the corrected record exposes a gap. On April 1, nothing is open. On June 1, the training expires and the task reopens, even though nobody wrote anything.</p>
<p><code>recheckAt</code> comes from <code>nextTemporalBoundary</code>. Schedule a wake-up for it instead of polling.</p>
<a class="th-more" href="/derivations">Derivations and reconciliation →</a>
</div>
<div class="th-window">
<div class="th-window__bar"><span class="th-window__dots" aria-hidden="true"><i></i><i></i><i></i></span><span>app.ts</span><span>derive</span></div>

<<< @/snippets/home/site-safety/app.ts#derive

<div class="th-window__bar th-window__bar--run"><span>Evaluated on March 3, April 1, and June 1</span><span>open-work.json</span></div>

<<< @/snippets/home/site-safety/output/open-work.json

</div>
</article>

<article class="th-step" aria-labelledby="runtime">
<div class="th-step__head">
<p class="th-step__num">Step 06 <span>· Storage + HTTP</span></p>
<h3 id="runtime">Pick a store. Get an API.</h3>
<p>Storage is a layer. The same program runs in memory for tests and the browser, on SQLite, or on PostgreSQL.</p>
<p><code>EntityHttp</code> serves the <code>live</code> release as REST routes with OpenAPI docs. Every read accepts both clocks, so the audit question works over HTTP too.</p>
<a class="th-more" href="/http-api">Configuration-derived HTTP API →</a>
</div>
<div class="th-window">
<div class="th-window__bar"><span class="th-window__dots" aria-hidden="true"><i></i><i></i><i></i></span><span>app.ts</span><span>run</span></div>

<<< @/snippets/home/site-safety/app.ts#run

<div class="th-window__bar th-window__bar--run"><span>Launch it</span><span>serve.ts</span></div>

<<< @/snippets/home/site-safety/serve.ts

<div class="th-window__bar th-window__bar--run"><span><code>GET /api/rest/latest/workers/worker:maria?validAt=…</code>, with and without <code>recordedAt</code></span><span>http.json</span></div>

<<< @/snippets/home/site-safety/output/http.json

</div>
</article>

</div>

<section class="th-row" aria-labelledby="work-is-a-query">
<div class="th-row__head">
<p class="th-row__num">03</p>
<h2 id="work-is-a-query">Stop enqueuing obligations. Reconcile them.</h2>
</div>
<div class="th-row__body">
<p>Most back-office bugs come down to a task that should exist but doesn’t, or one that exists but shouldn’t. Event handlers create work one step at a time and drift out of sync with the data.</p>
<p class="th-row__after">A derivation states what should be true. Reconciliation reports the difference.</p>
</div>
<div class="th-row__wide">
<div class="th-table th-table--compare">

|                   | Event handlers that enqueue tasks       | Triplex derivations                                                |
| ----------------- | --------------------------------------- | ------------------------------------------------------------------ |
| Source of truth   | Whatever each handler remembered to do  | A Datalog query over facts, pinned to a release                    |
| Late corrections  | Missed unless someone re-runs a handler | Appear on the next evaluation, even for past dates                 |
| Expiring evidence | A separate cron job per rule            | `nextTemporalBoundary` says exactly when to re-evaluate            |
| Duplicates        | Hand-built idempotency                  | Stable, content-addressed candidate IDs                            |
| Explanation       | Log lines                               | Each candidate carries its source facts and assertion transactions |
| Change            | Diff it yourself                        | `Derivation.reconcile` returns `added`, `removed`, and `changed`   |

</div>
<div class="th-facts th-facts--three">
<article><h3>Triplex owns</h3><p>Facts, history, and the temporal read basis. Atomic transactions, command receipts, and the ordered journal. Release identity and constraint enforcement. Derivation candidates, provenance, and reconciliation diffs. Consumer checkpoints and wake-up boundaries.</p></article>
<article><h3>Your application owns</h3><p>Domain vocabulary and entity IDs. Authentication, authorization, and HTTP handlers. What a release contains and when <code>live</code> moves. What each reconciliation diff means: a ticket, an email, a workflow. Timer delivery and retries.</p></article>
<article><h3>See it end to end</h3><p>The <a href="https://github.com/bjacobso/triplex/tree/main/examples/compliance-host">compliance host example</a> adds durable task occurrences, a journal consumer with a checkpoint, a hypothetical preview, and a scheduler that reopens work at expiry. Read <a href="/host-integration">Host integration</a> for the full boundary.</p></article>
</div>
</div>
</section>

<section class="th-row" aria-labelledby="modeling">
<div class="th-row__head">
<p class="th-row__num">04</p>
<h2 id="modeling">From a back-office domain to Triplex primitives.</h2>
</div>
<div class="th-row__body">
<p>Most back-office systems are built from the same parts. This is where each part goes, and where it shows up in Maria’s story.</p>
<p><a class="th-more" href="/agents">Read the full modeling guide →</a></p>
</div>
<div class="th-row__wide">
<div class="th-table">

| In your domain                          | In Triplex                                                             | In the scenario                  |
| --------------------------------------- | ---------------------------------------------------------------------- | -------------------------------- |
| Things: workers, sites, cases, accounts | Stable `EntityId`s and an `EntityType` per kind                        | `worker:maria`, `Worker`         |
| Properties and relationships            | Global `Attribute` keys, with `Attribute.ref` for relationships        | `:placement/site`                |
| Schemas, policies, forms                | Config nodes committed as an immutable release, pointed to by `live`   | `hr-2026.1`, `hr-2026.2`         |
| User and system actions                 | One `transact` per command with `actor`, `commandId`, `configSnapshot` | `create:placement:maria-harbor`  |
| Evidence that starts or expires         | `validFrom` and `validTo` on the assertion                             | Training valid March 1 to June 1 |
| Corrections                             | Retract and assert in one transaction; history is kept                 | The auditor’s fix                |
| Obligations and to-dos                  | A `Derivation` whose candidates you reconcile                          | `task.site-safety-training`      |
| Tickets, notifications, SLAs            | Your code, driven by reconciliation diffs and wake-up boundaries       | Host-owned                       |
| Audit questions                         | A temporal basis, command receipts, and the journal                    | Step 04, Audit                   |

</div>
</div>
</section>

<section class="th-row" aria-labelledby="runs-where">
<div class="th-row__head">
<p class="th-row__num">05</p>
<h2 id="runs-where">A library, not another server.</h2>
</div>
<div class="th-row__body">
<p>Triplex runs inside your process as Effect layers. Switching storage changes the layer you provide, as in <a href="#runtime">step 06</a>, and the rest of the program stays the same.</p>
<p>On PostgreSQL, Triplex can share your application’s transaction, so your own rows, Triplex facts, the journal, and an outbox row commit or roll back together.</p>
<ul class="th-checklist" aria-label="Storage runtimes and their status">
<li><span><strong>In-memory KV</strong><small><code>@triplex-build/triplex</code> · tests, browser, edge</small></span><em class="is-supported">Supported</em></li>
<li><span><strong>SQLite</strong><small><code>@triplex-build/triplex-sqlite</code> · durable baseline</small></span><em class="is-supported">Supported</em></li>
<li><span><strong>PostgreSQL</strong><small><code>@triplex-build/triplex-postgres</code></small></span><em class="is-candidate">Pre-1.0 production candidate</em></li>
<li class="is-experimental"><span><strong>Cloudflare Durable Objects</strong><small>Private workspace package</small></span><em>Experimental</em></li>
<li class="is-experimental"><span><strong>FoundationDB</strong><small>Private workspace package</small></span><em>Experimental</em></li>
</ul>
<p>Want to build on another storage engine? Explore the <a href="/backends">backend blueprints</a>: working SQLite, experimental FoundationDB, and proposed Datomic and XTDB adapters. Each maps storage primitives to the Triplex contract and identifies what still needs to be built.</p>
<p>Also in the box: a JSON-first <a href="/tools">CLI</a> for agents, a browser <a href="/explorer">data explorer</a>, a <a href="/http-api">configuration-derived HTTP API</a> with OpenAPI, and an in-browser <a href="/playground">playground</a>.</p>
</div>
</section>

<section class="th-row" aria-labelledby="fit">
<div class="th-row__head">
<p class="th-row__num">06</p>
<h2 id="fit">When to use Triplex, and when not to.</h2>
</div>
<div class="th-row__body">
<div class="th-columns">
<div class="th-list th-list--yes">
<h3>A good fit</h3>
<ul>
<li>Compliance and onboarding, eligibility and entitlements, policy engines, case management, and back-office workflows.</li>
<li>Any domain where “as of when?” and “under which rules?” come up regularly.</li>
<li>Agent-driven systems that need a durable world model with an attributed record of every change.</li>
</ul>
</div>
<div class="th-list th-list--no">
<h3>Not a fit</h3>
<ul>
<li>High-volume telemetry, blob storage, caches, and queues.</li>
<li>Workloads that only need a relational table and never ask about history or provenance.</li>
<li>Replacing every table. Triplex is a system of record for facts.</li>
</ul>
</div>
</div>
</div>
<div class="th-row__wide">
<p class="th-relates">Triplex embeds in TypeScript and connects facts to versioned rules and reconciled work. Here is how it relates.</p>
<div class="th-facts">
<article><h3><a href="/datomic">Datomic</a></h3><p>Facts, Datalog, and historical database views.</p></article>
<article><h3><a href="/xtdb">Current XTDB</a></h3><p>Bitemporal data through SQL and XTQL.</p></article>
<article><h3>Event sourcing</h3><p>Gives you history, but you hand-write every projection.</p></article>
<article><h3>Workflow engines</h3><p>Run durable code. Triplex decides what work should exist, and the two compose.</p></article>
</div>
</div>
</section>

<section class="th-family" aria-labelledby="family-title">
<div class="th-family__head">
<div>
<p class="th-label">Part of the WorldVM family</p>
<h2 id="family-title">Small experiments. Bigger worlds.</h2>
</div>
<p>Triplex is one thread in a family of open experiments in software that can describe, remember, coordinate, and explain itself. WorldVM is where they meet: a runtime for living domain models, built on facts that Triplex remembers.</p>
</div>
<ul class="th-family__grid">
<li class="th-family__here"><div><strong>Triplex</strong><em>A memory for your world.</em><span>You are here: an embedded fact database that keeps time, rules, and provenance together.</span></div></li>
<li><a class="no-icon" href="https://forma-lang.com"><strong>Forma ↗</strong><em>Little language. Big ideas.</em><span>A typed Lisp for building domain-specific languages.</span></a></li>
<li><a class="no-icon" href="https://schematics.run"><strong>Schematics ↗</strong><em>Every app hides a second program.</em><span>Small Effect libraries that make application rules inspectable.</span></a></li>
<li><a class="no-icon" href="https://foldworks.dev"><strong>Foldworks ↗</strong><em>Give the machinery a face.</em><span>Outliners, data grids, forms, and diagrams for Foldkit.</span></a></li>
<li><a class="no-icon" href="https://open-ontology.com"><strong>Open Ontology ↗</strong><em>Every platform, checked as one program.</em><span>Configuration as code, type-checked across platforms.</span></a></li>
</ul>
<a class="th-family__cta no-icon" href="https://worldvm.com/">Meet the whole family at worldvm.com ↗</a>
</section>

<nav class="th-guides" aria-label="Guides">
<p class="th-label">Keep reading</p>
<div>
<a href="/getting-started">Quickstart →</a>
<a href="/agents">Modeling guide →</a>
<a href="/concepts">Core concepts →</a>
<a href="/datalog">Datalog →</a>
<a href="/configuration">Typed configuration →</a>
<a href="/derivations">Derivations →</a>
<a href="/host-integration">Host integration →</a>
<a href="/current-state">Current state →</a>
</div>
</nav>

</div>
