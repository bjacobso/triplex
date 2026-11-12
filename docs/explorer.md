---
layout: false
title: Triplex data explorer
description: Explore a live in-memory Triplex database in an Airtable-like grid, JSON editor, and transaction diff viewer.
---

<nav class="explorer-site-links" aria-label="Triplex site">
  <a href="/">Triplex home</a>
  <a href="/database">Database client docs</a>
</nav>

<ClientOnly>
  <TriplexExplorer />

<template #fallback>

<p>Opening the in-memory Triplex database…</p>
</template>
</ClientOnly>

<style>
.explorer-site-links {
  display: flex;
  gap: 1.5rem;
  padding: 0.75rem 1.25rem;
  background: #faf8f3;
  color: #1f5fd1;
  font: 1rem system-ui, sans-serif;
}
.explorer-site-links a { text-decoration: underline; }
</style>
