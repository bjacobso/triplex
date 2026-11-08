---
title: Nothing is overwritten
description: Part 2 of The Database That Remembers Why. Correct a fact without deleting the evidence, using assertions, retractions, and an atomic transaction log.
prev:
  text: A fact is a triple
  link: /blog/remembers-why/01-a-fact-is-a-triple
next:
  text: Two clocks, two questions
  link: /blog/remembers-why/03-two-clocks-two-questions
---

# Nothing is overwritten

Part 02 of [The Database That Remembers Why](./) · Act I, Facts · November 8, 2026

<<< @/snippets/blog/remembers-why/02/run.ts#run

The current answer is `false`. The earlier assertion still says `true`.
Unlike [Part 1](./01-a-fact-is-a-triple), this version can distinguish a
correction from a history in which nobody ever said Maria was trained.

We haven't made the earlier statement true. We've stopped destroying the
evidence that someone made it. This is still **teaching code**, not Triplex's
API, using the repository's Effect 4.1.1. Each block comes from the tested
files linked below.

## Give statements identities

Keep Part 1's triples and pattern queries. Add an identity to each
assertion, and replace `put` with two operations:

<<< @/snippets/blog/remembers-why/02/log.ts#model

An assertion introduces a statement. A retraction withdraws that particular
assertion, not every fact about its entity and attribute. The ID names
evidence; it is not the entity's ID. Maria keeps her entity identity when
her training record changes.

A transaction groups changes under one increasing position. The generic
type lets later parts attach time to assertions without rewriting this
log. `StoreError` gives invalid transitions a typed failure channel.

## Correct, don't replace

Here is the program behind the opening result:

<<< @/snippets/blog/remembers-why/02/story.ts#correction

Position 1 asserts `training:1`. Position 2 retracts it and asserts
`training:2`, whose value is `false`. Those last two operations belong
together. A reader must not see the withdrawal without the replacement.

The journal keeps both transactions. The current answer is a projection of
that journal, not a second history we edit independently:

<<< @/snippets/blog/remembers-why/02/log.ts#replay

Replay walks transactions in order. Its temporary Map is keyed by assertion
ID, rather than by entity and attribute. Deleting an entry from that Map
doesn't delete the earlier journal entry. We can throw the projection away
and compute it again.

Pattern matching retains Part 1's exact comparisons and wildcard omissions.
We're changing how facts survive a correction, not inventing a query
language yet.

## Check the whole batch before publishing it

A retraction of an unknown assertion is probably a mistake. Reusing an
assertion ID would make the evidence ambiguous. Check both before appending:

<<< @/snippets/blog/remembers-why/02/log.ts#stage

`used` includes assertions that were later retracted. An ID cannot become
available again just because its statement is no longer live. The checks
also see earlier operations in the same batch: asserting and then
retracting a new ID is allowed; asserting it twice is not. Reuse fails with
`assertion ID already used: training:1` in the tested example.

Staging changes local sets, not the stored log. Only a successful stage
reaches the append:

<<< @/snippets/blog/remembers-why/02/log.ts#store

One semaphore permit protects the check and append together. Two callers
cannot both check the same old state and successfully retract the same
assertion. Input and output copies keep callers from mutating the journal
through references they hold.

This is atomicity inside one in-memory store. It is **not** crash safety or
a lock shared by multiple processes.

## Failure must leave no half-correction

Try a batch whose first retraction is valid and whose second isn't:

<<< @/snippets/blog/remembers-why/02/story.ts#rollback

The error is `assertion is not live: missing`. Maria's original assertion
is still current. The journal still has only position 1. A rejected batch
doesn't consume a position or leave the first retraction behind.

There is another difference from Part 1's single-value Map:

<<< @/snippets/blog/remembers-why/02/story.ts#ambiguity

Without a retraction, both `true` and `false` are current. We deliberately
allow multiple assertions for the same entity and attribute. Whether an
attribute must have exactly one value is a rule, not a property of triples.
Part 5 will give that rule somewhere to run.

## What this version leaves out

We scan and replay the whole journal. There is no persistence, indexing,
external input decoding, actor, command identity, or rule enforcement.
Assertion IDs come from the caller. Transactions have an order, but no
timestamps and no public as-of query yet.

### This is what Triplex does

Real Triplex also distinguishes assertions from retractions and commits
transaction changes atomically. Its assertion representation and service
API are not these teaching types. See [Core concepts](/concepts) for its
correction model and [Getting started](/getting-started) for library calls.
The backend guarantees remain those in [Current state](/current-state),
not those of this closure over an array.

## Next: when was it true, and when did we know?

The journal can now prove that Maria's record changed. It still cannot say
whether training ended before her March 2 assignment or whether we learned
about that ending later. A transaction position answers neither question.
[Part 3](./03-two-clocks-two-questions) gives the history two clocks.

The [source and tests](https://github.com/bjacobso/triplex/tree/main/docs/snippets/blog/remembers-why/02)
check the correction, rollback, ID reuse, competing retractions, and copy
isolation. [Back to the series](./).
