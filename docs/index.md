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
<p class="th-lead">Triplex is a bitemporal fact database that keeps facts, time, and versioned rules together in your TypeScript process. Every write records <strong>who acted</strong>, <strong>which rules applied</strong>, and <strong>when it was true</strong>. Audit questions and open work become queries instead of investigations.</p>
<div class="th-actions">
<a class="th-button th-button--primary" href="/getting-started">Get started</a>
<a class="th-button" href="#one-scenario">See the whole stack ↓</a>
</div>
<div class="th-install">

<div class="language-sh vp-adaptive-theme"><pre><code>npm install @triplex-build/triplex effect</code></pre></div>

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
<div><dt>=&gt;</dt><dd><a href="#work-is-a-query">Derived work.</a> What should happen next.</dd></div>
</dl>
</div>
</section>

<section class="th-row" aria-labelledby="one-scenario">
<div class="th-row__head">
<p class="th-row__num">02</p>
<h2 id="one-scenario">From schema to an answer you can explain.</h2>
</div>
<div class="th-row__body">
<p>Start with the <a href="/database">Database client</a>: declare a schema, publish it, and handle each action as one command. Every TypeScript block below comes from the <a href="https://github.com/bjacobso/triplex/blob/main/docs/snippets/home/client.ts">same checked, executable file</a>. CI runs it to verify receipts, typed reads, historical state, and attribution.</p>
<p class="th-story"><strong>The story.</strong> Dana records Maria under release <code>workers-v1</code>. An auditor later corrects her name. Today’s read shows the correction; a view at Dana’s receipt still shows what Dana recorded, with the actor and rules that explain it.</p>
<p>For durable SQLite, add <code>@effect/sql-sqlite-node</code> to the install line. Follow <a href="/getting-started">Getting started</a> for a complete first program.</p>
</div>
</section>

<div class="th-steps">

<article class="th-step" aria-labelledby="model">
<div class="th-step__head">
<p class="th-step__num">Step 01 <span>· Model</span></p>
<h3 id="model">Declare the domain once.</h3>
<p>Attributes own global keys and value types. Entity types declare aliases, required fields, cardinality, and reference targets. The same declarations drive command inputs and typed reads.</p>
<a class="th-more" href="/configuration#ontology-dsl">Typed configuration →</a>
</div>
<div class="th-window">
<div class="th-window__bar"><span class="th-window__dots" aria-hidden="true"><i></i><i></i><i></i></span><span>client.ts</span><span>model</span></div>

<<< @/snippets/home/client.ts#model

</div>
</article>

<article class="th-step" aria-labelledby="which-rules">
<div class="th-step__head">
<p class="th-step__num">Step 02 <span>· Rules</span></p>
<h3 id="which-rules">Publish the rules as a release.</h3>
<p>The host publishes an immutable, content-addressed release before acquiring the client. <code>Database.layer</code> checks the model against <code>live</code>; every new command pins and enforces the release it admits.</p>
<a class="th-more" href="/configuration-versioning">Releases, refs, and rollback →</a>
</div>
<div class="th-window">
<div class="th-window__bar"><span class="th-window__dots" aria-hidden="true"><i></i><i></i><i></i></span><span>client.ts</span><span>release</span></div>

<<< @/snippets/home/client.ts#release

</div>
</article>

<article class="th-step" aria-labelledby="record-a-command">
<div class="th-step__head">
<p class="th-step__num">Step 03 <span>· Command</span></p>
<h3 id="record-a-command">One command, one atomic transaction.</h3>
<p><code>db.command</code> returns a persisted receipt with actor, command ID, release, and commit position. The builder’s <code>tx.create</code> encodes typed values and checks that the entity is new. Retrying the same command ID returns the original receipt.</p>
<a class="th-more" href="/database#build-one-command">Commands and receipts →</a>
</div>
<div class="th-window">
<div class="th-window__bar"><span class="th-window__dots" aria-hidden="true"><i></i><i></i><i></i></span><span>client.ts</span><span>command</span></div>

<<< @/snippets/home/client.ts#command

</div>
</article>

<article class="th-step" aria-labelledby="read">
<div class="th-step__head">
<p class="th-step__num">Step 04 <span>· Read</span></p>
<h3 id="read">Read through your schema.</h3>
<p><code>db.get</code> returns alias-keyed values or <code>null</code>. <code>db.list</code> returns a bounded page and a cursor. For joins, <code>db.query</code> checks attributes against the release and decodes each binding with an Effect Schema projection.</p>
<a class="th-more" href="/database#typed-reads-and-bounded-queries">Typed reads and queries →</a>
</div>
<div class="th-window">
<div class="th-window__bar"><span class="th-window__dots" aria-hidden="true"><i></i><i></i><i></i></span><span>client.ts</span><span>read</span></div>

<<< @/snippets/home/client.ts#read

</div>
</article>

<article class="th-step" aria-labelledby="what-did-we-know">
<div class="th-step__head">
<p class="th-step__num">Step 05 <span>· Audit</span></p>
<h3 id="what-did-we-know">Keep the correction and the original belief.</h3>
<p><code>tx.correct</code> replaces a fact over its original valid interval and keeps the recorded history. <code>db.asOf</code> at the receipt’s exact position returns a stable, read-only view: what was known then, for the business date in question.</p>
<a class="th-more" href="/concepts#recorded-time-and-valid-time">Recorded time and valid time →</a>
</div>
<div class="th-window">
<div class="th-window__bar"><span class="th-window__dots" aria-hidden="true"><i></i><i></i><i></i></span><span>client.ts</span><span>audit</span></div>

<<< @/snippets/home/client.ts#audit

</div>
</article>

<article class="th-step" aria-labelledby="runtime">
<div class="th-step__head">
<p class="th-step__num">Step 06 <span>· Explain + run</span></p>
<h3 id="runtime">Ask why, at the same cut.</h3>
<p>The <code>Why</code> service explains the visible facts, their asserting transactions, actors, and pinned releases. Pass the historical view’s basis so the explanation and typed read agree. Compose the client and explanation services over one shared store.</p>
<a class="th-more" href="/why">Explain a fact with why →</a>
</div>
<div class="th-window">
<div class="th-window__bar"><span class="th-window__dots" aria-hidden="true"><i></i><i></i><i></i></span><span>client.ts</span><span>why</span></div>

<<< @/snippets/home/client.ts#why

<div class="th-window__bar th-window__bar--run"><span>One store for the application lifetime</span><span>run</span></div>

<<< @/snippets/home/client.ts#run

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
<h2 id="modeling">From a back-office domain to client commands.</h2>
</div>
<div class="th-row__body">
<p>Most back-office systems are built from the same parts. This is where each part goes, and where it shows up in Maria’s story.</p>
<p><a class="th-more" href="/agents">Read the full modeling guide →</a></p>
</div>
<div class="th-row__wide">
<div class="th-table">

| In your domain                          | In Triplex                                                      | In the example or guide                                       |
| --------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| Things: workers, sites, cases, accounts | Declare an `EntityType`; create with `tx.create`                | `Worker`, `worker:maria`                                      |
| Properties and relationships            | Typed `Attribute` keys and `Attribute.ref`                      | `:worker/name`                                                |
| Schemas, policies, forms                | Publish a release; acquire `Database.layer`                     | `workers-v1`                                                  |
| User and system actions                 | One `db.command` per action, with actor and stable command ID   | Dana’s create command and receipt                             |
| Evidence that starts or expires         | `validFrom` and `validTo` on builder writes                     | Maria’s facts start on March 2                                |
| Corrections and changes from a date     | `tx.correct`, `tx.replace`, or `tx.end` inside a command        | The auditor’s name correction                                 |
| Current state and lists                 | `db.get`, `db.list`, and Schema-projected `db.query`            | Step 04, Read                                                 |
| Audit questions                         | `db.asOf`, `db.receipt`, `db.history`, and `why.why`            | Steps 05–06                                                   |
| Obligations and to-dos                  | A `Derivation` over `Triples`, with an explicit release         | [Modeling guide](/agents#_4-model-obligations-as-derivations) |
| Tickets, notifications, SLAs            | Host code driven by reconciliation diffs and wake-up boundaries | [Host integration](/host-integration)                         |

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
<li><span><strong>SQLite</strong><small><code>@triplex-build/triplex/sqlite</code> · durable baseline</small></span><em class="is-supported">Supported</em></li>
<li><span><strong>PostgreSQL</strong><small><code>@triplex-build/triplex/postgres</code></small></span><em class="is-candidate">Pre-1.0 production candidate</em></li>
<li class="is-experimental"><span><strong>Cloudflare Durable Objects</strong><small><code>@triplex-build/triplex/cloudflare</code></small></span><em>Experimental</em></li>
<li class="is-experimental"><span><strong>FoundationDB</strong><small><code>@triplex-build/triplex/foundationdb</code></small></span><em>Experimental</em></li>
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
<article><h3><a href="https://worldvm.com/">WorldVM</a></h3><p>WorldVM keeps each world’s subject records in Triplex. Its runtime uses recorded state and bases to explain what it knows.</p></article>
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
