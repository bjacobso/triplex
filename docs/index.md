---
layout: home
title: Triplex
titleTemplate: false
description: A temporal fact database for TypeScript, built on Effect.
sidebar: false
aside: false
pageClass: triplex-index
---

::: warning Pre-1.0 release candidate
The new `@triplex-build` packages are not yet published. Run Triplex from a source checkout; the
current tree requires `effect@4.0.0-rc.112`, and Effect 3 is not compatible. KV and SQLite are the
supported baseline; PostgreSQL is a production candidate, while Cloudflare and FoundationDB are
experimental. [Read the exact maturity contract](/current-state).
:::

<div class="triplex-home">
<header class="triplex-home__intro">
<h1>Triplex</h1>
<p class="triplex-home__tagline">A temporal fact database for TypeScript.</p>
<p class="triplex-home__detail">
      Store facts. Query relationships. Derive state. Keep the complete history.<br>
      Bitemporal facts, Datalog, and typed, content-addressed configuration—built on Effect.
</p>
<div class="triplex-home__actions">
<a class="triplex-home__primary" href="/getting-started">
        Get started<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span>
</a>
<a class="triplex-home__secondary" href="/playground">Try the playground</a>
<a class="triplex-home__secondary" href="https://github.com/bjacobso/triplex">GitHub</a>
</div>
</header>

<section class="triplex-home__section" aria-labelledby="why-triplex">
<div class="triplex-home__section-intro">
<p class="triplex-home__eyebrow">Why Triplex?</p>
<h2 id="why-triplex">Your application should be able to explain itself.</h2>
<p>Current state tells you what is true now. Explaining why often means piecing together database rows, audit logs, policy versions, and background jobs. Those systems rarely share the same view of time.</p>
<p>Triplex connects facts, history, configuration, and derived state through a shared identity model and provenance chain. You can trace an answer back to the data and the versioned rules behind it.</p>
</div>
<div class="triplex-home__principles">
<div>
<h3>What did we know?</h3>
<p>Read facts as they were recorded at a point in time, or as they were valid in the world. Corrections preserve the assertion history.</p>
</div>
<div>
<h3>Which rules applied?</h3>
<p>Pin a write to an immutable configuration release. Keep the exact schema and policy version available after the live configuration changes.</p>
</div>
<div>
<h3>What needs to happen?</h3>
<p>Query relationships and missing evidence to derive work. Your application decides how to turn those results into tasks and workflows.</p>
</div>
</div>
<p class="triplex-home__fit">Built for domains where history and rules matter: compliance, onboarding, eligibility, entitlements, and agent-driven workflows.</p>
</section>

<section class="triplex-home__section triplex-home__code" aria-labelledby="facts-and-queries">
<div class="triplex-home__section-intro">
<p class="triplex-home__eyebrow">Facts → queries → work</p>
<h2 id="facts-and-queries">From a submission to an open grading task.</h2>
<p>A student submits a quiz. Until a grade exists, that submission implies work. Here is how the facts and query fit together.</p>
</div>

<article class="triplex-home__example" aria-labelledby="write-facts">
<div class="triplex-home__example-description">
<p class="triplex-home__eyebrow">01 · Facts</p>
<h3 id="write-facts">Record what happened.</h3>
<p>Assert the submission’s relationships in one atomic transaction, with the actor, command, and governing configuration recorded alongside it.</p>
<a href="/operational-primitives">Explore transactions<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
</div>
<div class="triplex-home__snippet">

<<< @/snippets/home/facts.ts{ts twoslash}

</div>
</article>

<article class="triplex-home__example" aria-labelledby="query-work">
<div class="triplex-home__example-description">
<p class="triplex-home__eyebrow">02 · Datalog</p>
<h3 id="query-work">Ask what still needs doing.</h3>
<p>Join facts by shared variables and find submissions without a grade. Once a grade is present, the submission no longer matches.</p>
<p>A derivation can track changes to these results and retain their source provenance, so your application can reconcile its grading tasks.</p>
<a href="/derivations">Explore derived facts<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
</div>
<div class="triplex-home__snippet">

<<< @/snippets/home/query.ts{ts twoslash}

</div>
</article>

</section>

<section class="triplex-home__section triplex-home__code" aria-labelledby="config-and-versioning">
<div class="triplex-home__section-intro">
<p class="triplex-home__eyebrow">Configuration &amp; versioning</p>
<h2 id="config-and-versioning">Version the rules alongside the facts.</h2>
<p>Schemas, forms, policies, and routines change. Triplex stores their typed configuration graph as immutable, content-addressed releases, so a new deployment does not erase the rules that governed an earlier decision.</p>
</div>

<article class="triplex-home__example" aria-labelledby="typed-config">
<div class="triplex-home__example-description">
<p class="triplex-home__eyebrow">03 · Typed configuration</p>
<h3 id="typed-config">Define once. Publish a release.</h3>
<p>Attributes define identity and value type. Entity types define how those attributes are used, including requiredness and uniqueness.</p>
<p>Commit those definitions with your application’s other configuration into one release, and point <code>live</code> at its snapshot.</p>
<a href="/configuration">Explore configuration<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
</div>
<div class="triplex-home__snippet">

<<< @/snippets/home/ontology.ts{ts twoslash}

</div>
</article>

<div class="triplex-home__principles">
<div>
<h3>Immutable releases</h3>
<p>Content determines identity. Equal nodes deduplicate, and unchanged revisions are shared between releases. Each snapshot preserves an exact configuration graph.</p>
</div>
<div>
<h3>Movable refs</h3>
<p>Names such as <code>test</code> and <code>live</code> point to snapshots. Promote a release or point back to an earlier one without copying configuration. Moving a ref does not undo operational writes.</p>
</div>
<div>
<h3>Pinned provenance</h3>
<p>Attach the release’s snapshot ID to a transaction with <code>configSnapshot</code>. Later, inspect the exact version that governed the write, even after <code>live</code> moves.</p>
</div>
</div>

</section>

<nav class="triplex-home__guides" aria-label="Guides">
<a href="/getting-started">Quickstart<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
<a href="/playground">Playground<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
<a href="/concepts">Core concepts<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
<a href="/datalog">Datalog<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
<a href="/configuration">Typed configuration<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
<a href="/derivations">Derived facts<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
<a href="/tools">CLI and dashboard<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
</nav>
</div>
