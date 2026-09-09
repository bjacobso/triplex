---
layout: home
title: Triplex
titleTemplate: false
description: A temporal fact database for TypeScript, built on Effect.
sidebar: false
aside: false
pageClass: triplex-index
---

<div class="triplex-home">
  <header class="triplex-home__intro">
    <h1>Triplex</h1>
    <p class="triplex-home__tagline">A temporal fact database for TypeScript.</p>
    <p class="triplex-home__detail">
      Store facts. Query relationships. Derive state. Keep the complete history.<br>
      Bitemporal facts, Datalog, and typed, content-addressed configuration—built on Effect.
    </p>
    <div class="triplex-home__actions">
      <a class="triplex-home__primary" href="/current-state">
        Get started<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span>
      </a>
      <a class="triplex-home__secondary" href="https://github.com/bjacobso/triplex">GitHub</a>
    </div>
  </header>

  <section class="triplex-home__code" aria-label="Triplex code examples">

  <div class="triplex-home__flow" aria-label="Facts flow through Datalog into derived state">
    <div>
      <span>01 · Facts</span>
      <strong>student → submitted → quiz</strong>
    </div>
    <div>
      <span>02 · Datalog</span>
      <strong>submission without a grade</strong>
    </div>
    <div>
      <span>03 · Current state</span>
      <strong>grading task · open</strong>
    </div>
  </div>

::: code-group

<<< @/snippets/home/query.ts{ts twoslash}

<<< @/snippets/home/facts.ts{ts twoslash}

<<< @/snippets/home/ontology.ts{ts twoslash}

:::

  </section>

  <nav class="triplex-home__guides" aria-label="Guides">
    <a href="/datalog">Datalog<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
    <a href="/configuration">Typed configuration<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
    <a href="/derivations">Derived facts<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
    <a href="/operational-primitives">Operations<span class="vpi-arrow-right triplex-home__link-icon" aria-hidden="true"></span></a>
  </nav>
</div>
