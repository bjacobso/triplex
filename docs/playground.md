---
title: Playground
description: Run an in-memory Triplex database, Datalog queries, and transactions in your browser.
aside: false
---

# Playground

See how facts become answers. Pick a domain, try a change, and watch a real Triplex database
update in your browser. No installation or JSON editing needed to get started.

<ClientOnly>
  <TriplexPlayground />

<template #fallback>

<p>Loading the in-memory Triplex runtime…</p>
</template>
</ClientOnly>

## What this demonstrates

The sample query runs automatically. Add a score or a training record to change its answer, then
use **Retract this change** to see the original result return. Retraction changes which facts are
currently visible; the journal keeps both writes. **Reset database** starts a fresh session,
including a fresh journal.

Open **Go further: edit queries and transactions** to experiment with the underlying JSON. The
guided actions populate the transaction editor, so you can inspect the exact assertion or
retraction you just ran. Raw entity facts include IDs you can use in your own retractions.

The playground keeps one `ManagedRuntime` alive while you interact with a domain, so every command
resolves the same `Triples` service and in-memory KV store. Switching domains or resetting disposes
that runtime and builds a new one. This is the browser equivalent of the layer-lifetime guidance in
[Getting started](/getting-started#what-the-effect-code-is-doing).

The query and transaction editors decode the same public `DatalogQuery` and `TransactRequest`
schemas used by Triplex hosts and the CLI. Results are bounded to 100 rows. For durable data, graph
constraints, configuration authoring, or a larger operator interface, continue to [CLI and
dashboard](/tools).
