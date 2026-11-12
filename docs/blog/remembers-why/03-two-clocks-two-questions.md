---
date: "2026-11-08"
series: remembers-why
title: Two clocks, two questions
description: Part 3 of The Database That Remembers Why. Ask whether Maria was trained on March 2, as known then and as known now, with independent valid and recorded times.
prev:
  text: Nothing is overwritten
  link: /blog/remembers-why/02-nothing-is-overwritten
next:
  text: Someone did this
  link: /blog/remembers-why/04-someone-did-this
---

# Two clocks, two questions

Part 03 of [The Database That Remembers Why](./) · Act I, Facts

<<< @/snippets/blog/remembers-why/03/run.ts#run

Three answers, no contradiction. On March 2, our evidence said Maria was
trained. On March 10, we learned her training had ended on March 1. Our
corrected view no longer covers March 2, but it still covers January.

[Part 2](./02-nothing-is-overwritten) preserved the statements. Now we need
to distinguish **when a statement holds** from **when we recorded it**.
This is teaching code using Effect 4.1.1, not Triplex's API.

## Two coordinates for one question

An assertion gets a valid interval. A transaction gets a recorded time.
A read must supply both coordinates explicitly:

<<< @/snippets/blog/remembers-why/03/temporal.ts#model

`validFrom` is inclusive; `validTo` is exclusive. An omitted end means the
interval is open-ended, not that the certificate can never expire.
`recordedAt` belongs to the transaction: everything in one commit becomes
known together.

Both coordinates use epoch milliseconds. Valid time is supplied with the
statement. Recorded time comes from the store's clock, not a per-write
timestamp chosen by the client. `DateTime.now` supplies the default; the
store accepts a clock Effect so the story and tests can control time
without waiting or backdating a live request.

Here are the story's UTC instants; JavaScript numbers months from zero:

<<< @/snippets/blog/remembers-why/03/story.ts#dates

All five dates are in 2026. These are precise boundaries at midnight UTC,
not a model of local working days or time zones.

## Record a correction when it arrives

On January 5, we record training effective from January 1. On March 10, we
replace that open interval with one ending on March 1:

<<< @/snippets/blog/remembers-why/03/story.ts#correction

The correction does not assert that Maria was untrained forever. It
withdraws the old assertion and supplies a narrower interval. An empty
answer on March 2 means **no matching training assertion**, not a stored
boolean `false`.

Notice that the retraction has no valid interval of its own. At its recorded
time it withdraws the entire old assertion from our newer view, including
the old assertion's claims about January. The replacement explicitly
preserves January. Earlier recorded-time views still see the old assertion.

## Recorded time first, valid time second

The order of the read matters:

<<< @/snippets/blog/remembers-why/03/temporal.ts#read

First select transactions known at the requested recorded time. Then replay
their assertions and retractions using Part 2. Finally select assertions
whose valid intervals cover the requested instant.

If we replayed the entire journal first, the March 10 retraction would leak
into the March 2 view. We'd have preserved the old statement in the journal but
still lost the ability to reconstruct the earlier belief.

The opening results follow from those steps:

| Question                           | Valid time | Recorded time | Answer                |
| ---------------------------------- | ---------- | ------------- | --------------------- |
| What did we believe then?          | March 2    | March 2       | `training:1`          |
| What do we believe now about then? | March 2    | March 10      | No matching assertion |
| Did the correction erase January?  | January 5  | March 10      | `training:2`          |

Two time coordinates are not an extra filter on today's rows. They select
which history is allowed to participate in the answer.

## Keep the clock honest

Reuse Part 2's staging checks and add interval and clock checks:

<<< @/snippets/blog/remembers-why/03/temporal.ts#record

This teaching model permits finite, nonnegative valid starts and finite
ends strictly after the start. A zero-length or reversed interval for the
original assertion fails with `invalid valid interval: training:1`.
The recorded clock cannot go backwards; that failure says
`recorded clock must not move backwards`. Neither failure appends anything.

Equal recorded times are allowed. A read at that millisecond includes all
commits at that time. Positions still order them, but this version has no
read coordinate for selecting between same-millisecond commits.

The store is the same small ownership boundary as before:

<<< @/snippets/blog/remembers-why/03/temporal.ts#store

The semaphore protects clock sampling, staging, and publication together.
`readAt` is pure over the journal supplied to it; the store supplies a
consistent array and returns copied answers.

## What this version leaves out

No persistence or temporal indexes. Every query replays history. No
automatic expiry notifications: asking after an interval ends changes the
answer, but nothing wakes a host up. Part 9 will address that.

The attributes still accept any primitive value. There are no authenticated
actors, command IDs, receipts, or versioned rules. Our clocks describe what
was recorded, not an independent proof that the real-world event happened.

### This is what Triplex does

Real Triplex reads facts with independent valid and recorded coordinates
and keeps correction history. Read [Core concepts](/concepts) for its
interval semantics and actual query contract. This miniature's numeric
`Basis` and `makeStore` are not library exports; backend maturity is still
documented in [Current state](/current-state).

## Next: a timestamp isn't an author

We can reconstruct what the store knew before the correction. We cannot
say who submitted it, or tell a retried request from a new business event.
“It was recorded on March 10” isn't an answer to “who did this?”
[Part 4](./04-someone-did-this) puts a command and its receipt in the same
commit as the facts.

The [source and tests](https://github.com/bjacobso/triplex/tree/main/docs/snippets/blog/remembers-why/03)
pin the dates, all three answers, both interval boundaries, retraction
visibility, and failed clock checks. [Back to the series](./).
