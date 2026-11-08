---
title: The Database That Remembers Why
description: Build a tiny bitemporal fact store with Effect TypeScript in twelve parts, discovering each feature when the previous version fails.
outline: 2
prev:
  text: Blog
  link: /blog/
next:
  text: A fact is a triple
  link: /blog/remembers-why/01-a-fact-is-a-triple
---

# The Database That Remembers Why

**Building a bitemporal fact store from first principles with Effect TypeScript.**

Facts change. Rules change. The record of what happened shouldn't.

This twelve-part build-in-public series starts with a Map and ends with a
small compliance host. Each installment adds one missing piece, then asks a
question that version cannot answer. Part 1 is published; the other eleven
are coming. [Start with a fact](./01-a-fact-is-a-triple).

## The tension: an update destroys evidence

Maria's training record says she was qualified. Someone corrects it. A month
later, an auditor asks why she was assigned to a site on March 2.

Today's row is not an answer. We need what was true on March 2, what we
believed when we assigned her, who recorded it, and which rules accepted it.
Updating in place destroys exactly the evidence needed to answer those
questions. That makes **“why?” the most expensive question a back-office
system gets asked**: someone has to reconstruct a decision from whatever
survived.

The bet here is that history, time, and rule identity belong in the data
model—not in a retrospective logging project. We will earn that design one
failure at a time, rather than begin with a finished database's vocabulary.

## Act I · Facts

Give a statement an identity, a history, two clocks, and an author.

### 01 · [A fact is a triple](./01-a-fact-is-a-triple)

**Published.** Entity, attribute, value. Store facts in a Map, query by
pattern, and watch a correction erase the evidence it replaced.

### 02 · Nothing is overwritten

**Coming.** Assertions, retractions, and an atomic transaction log. Preserve
the earlier statement without pretending it is still the current answer.

### 03 · Two clocks, two questions

**Coming.** Valid time and recorded time. Ask “was Maria trained on March 2?”
as known then and as known now. A late correction changes one answer, not
the record of the earlier belief.

### 04 · Someone did this

**Coming.** Commands, actors, idempotent command IDs, receipts, and the
journal. Record who acted and the rule context supplied with the command;
Part 6 will give those rules immutable release identities. A retry must not
become a second business event. Attribution records a claim about an actor;
authentication stays with the host.

## Act II · Rules

Give facts a checked shape, give rules an identity, and make work queryable.

### 05 · A shape is not an invariant

**Coming.** Attributes and entity types described with Effect Schema.
Decode values at the boundary; enforce cross-fact constraints inside the
transaction, where a concurrent writer cannot invalidate the check.

### 06 · Rules are releases

**Coming.** Immutable, content-addressed rule versions and a movable `live`
ref. Pin the accepting release so old decisions remain explainable under
their rules, without claiming old facts satisfy today's rules.

### 07 · A query is data

**Coming.** A small Datalog interpreter with shared-variable joins and
negation. Ask for related facts and missing evidence without hard-coding
every question as another method.

### 08 · Obligations are queries, not queues

**Coming.** Derive candidates from facts and reconcile added, removed, and
changed obligations. The host owns tickets, delivery, and workflow state.

## Act III · Operations

Make the model survive time, persistence, and questions from other programs.

### 09 · Time moves without writes

**Coming.** An expiring certificate changes an answer even when nobody
writes. Find the next temporal boundary and let the host schedule a wake-up
instead of polling.

### 10 · Storage is an Effect layer

**Coming.** Run the same teaching contract in memory, on SQLite, and on
PostgreSQL. Separate storage substitution from claims about durability,
isolation, and operational readiness.

### 11 · Show your work

**Coming.** Carry source provenance on every supported candidate, expose
as-of HTTP reads, and provide a JSON CLI for agents. Say where explanations
are incomplete instead of manufacturing certainty.

### 12 · A host, not just a database

**Coming.** Bring the pieces together around the repository's
[compliance host](https://github.com/bjacobso/triplex/tree/main/examples/compliance-host).
Show the real Triplex implementation alongside the teaching model, and
where [WorldVM](https://worldvm.com/) and
[Forma](https://github.com/bjacobso/forma) pick up execution and policy-language
concerns. They are related projects, not hidden prerequisites.

## How this relates to Triplex

This is teaching code, written from scratch, not an alternate public API.
Later parts reuse earlier parts and replace pieces only when their limits
become visible. The code lives in
[docs/snippets/blog/remembers-why](https://github.com/bjacobso/triplex/tree/main/docs/snippets/blog/remembers-why).
Published code blocks are imported from named regions of tested files;
CI type-checks them and tests the values, outputs, and errors quoted in the posts.

When a post says **“this is what Triplex does,”** it links to the real
library's guides. Use [Getting started](/getting-started) to build with
Triplex today, and [Current state](/current-state) for its maturity contract.
Triplex is pre-1.0: in-memory KV and SQLite are supported, PostgreSQL is a
production candidate, and Cloudflare and FoundationDB are experimental.

Preserving records is not the same as proving they were true. Triplex does
not supply authentication, authorization, workflow delivery, or an
independent witness to an actor's claims. Those boundaries stay visible as
the series grows.
