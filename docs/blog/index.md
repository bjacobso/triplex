---
title: Blog
description: Building Triplex in public, one working piece and one broken assumption at a time.
prev: false
next: false
---

# Blog

Working code, the questions it cannot answer yet, and the decisions that
shape Triplex.

## The Database That Remembers Why

**A twelve-part build-in-public series · Effect TypeScript**

Facts change. Rules change. The record of what happened shouldn't.
Build a tiny bitemporal fact store from first principles, discovering why
each piece exists by watching the previous version fail.

[Explore the series](/blog/remembers-why/) or start with
[Part 1: A fact is a triple](/blog/remembers-why/01-a-fact-is-a-triple).

### Latest · November 8, 2026

**[05 · A shape is not an invariant](/blog/remembers-why/05-a-shape-is-not-an-invariant)**

Decode values with Effect Schema, then check the proposed timeline inside
the transaction. A valid worker shape doesn't make an employee code unique.

**[04 · Someone did this](/blog/remembers-why/04-someone-did-this)**

Commit the actor, command ID, rule context, and receipt with the facts.
A lost response must not turn a retry into another business event.

**[03 · Two clocks, two questions](/blog/remembers-why/03-two-clocks-two-questions)**

Was Maria trained on March 2, as known then and as known now? A late
correction changes our view of the past, not the record of our earlier belief.

**[02 · Nothing is overwritten](/blog/remembers-why/02-nothing-is-overwritten)**

Assertions, retractions, and one atomic append. Correct the answer without
erasing the statement that made the earlier answer possible.

**[01 · A fact is a triple](/blog/remembers-why/01-a-fact-is-a-triple)**

An entity, an attribute, a value. Put them in a Map, ask a few questions,
then make a correction. The current answer is right. The evidence is gone.
