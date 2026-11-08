---
title: A fact is a triple
description: Part 1 of The Database That Remembers Why. Build a Map-backed fact store with Effect, query by pattern, and watch an update destroy evidence.
prev:
  text: The series
  link: /blog/remembers-why/
next: false
---

# A fact is a triple

Part 01 of [The Database That Remembers Why](./) · Act I, Facts · November 8, 2026

<<< @/snippets/blog/remembers-why/01/story.ts#first-fact

Maria is trained. The program records that statement, asks for Maria's
facts, and returns it. By the end of this post, that program runs on a tiny
store we wrote ourselves. Then we correct Maria's record and discover what
the store can no longer tell us.

This is **teaching code**, not Triplex's API. It needs TypeScript and the
repository's Effect 4.1.1. The source files and tests are linked below; they
already run in this repository's docs check.

## Three slots for a statement

A fact has an **entity** (what we're talking about), an **attribute** (what
we're saying about it), and a **value** (the answer).

<<< @/snippets/blog/remembers-why/01/facts.ts#model

The entity is a stable name, not a person's display name. Maria could change
her name without becoming a different worker. The attribute is a string
with a namespace so training and payroll can name different properties
without negotiating every word. Neither convention is validated yet.

For now values are strings, numbers, or booleans. Relationships can use
strings too, but nothing distinguishes a reference from ordinary text.
There are no dates or objects hiding behind this type.

`Partial<Fact>` means a question may specify any subset of the three slots.
Omitted slots are wildcards; supplied slots must all match exactly.

## A Map is enough—for now

Here is the entire store:

<<< @/snippets/blog/remembers-why/01/facts.ts#store

We key the Map by the entity and attribute together. JSON encoding the pair
keeps a separator inside either string from confusing two different pairs.
The value isn't in the key: writing the same entity and attribute again
**replaces** its value. This store allows one value per pair. That is a
choice for this version, not an inherent property of triples.

`match` scans every fact and requires every supplied field to agree. An
empty pattern returns everything. A boolean `false`, numeric zero, or empty
string is still a value to match, not a missing filter. Strict equality
keeps numeric zero different from the string containing zero.

We copy facts on the way in and out so a caller cannot change the stored
statement by mutating an object it already holds. Copies aren't history;
they only separate the caller's objects from the Map's objects.

### Why Effect already?

The Map is mutable, so reading or writing it is an operation, not a pure
value. `Effect.sync` delays each operation until the Effect runs. Merely
calling `put` doesn't write anything; yielding it in `Effect.gen` does.
`Effect.runSync` runs these synchronous programs at the outer boundary.

There is no typed failure channel yet. We accept the TypeScript types and
don't decode untrusted input. Later, Schema will check values and the
transaction boundary will check constraints. Effect doesn't invent either
guarantee just because we imported it.

## Ask a few questions

Give Maria a name and a training record, then add Lee, who is not trained:

<<< @/snippets/blog/remembers-why/01/story.ts#questions

Running `questions` produces four answers:

- `trained` contains only Maria's training fact, not her name.
- `untrained` contains only Lee's training fact, whose value is `false`.
- `absent` is an empty array: no facts mention Jo.
- `all` contains all three facts, in their insertion order.

Notice what an empty answer means. Jo isn't recorded as untrained; Jo isn't
recorded at all. Absence of evidence and evidence of absence are already
different, even before we have a query language.

We can ask for one entity or find every entity with a particular property
without defining a new table for each kind of thing. But we cannot yet join
workers to sites or ask for workers missing a required training record.
Part 7 will turn those questions into data too.

## Make a correction

An auditor discovers that Maria's certificate was entered in error. Change
her training value to `false`:

<<< @/snippets/blog/remembers-why/01/story.ts#correction

The current answer is right. The store now says Maria is not trained.
The earlier array in `before` still contains `true`, because we read a
copy before the overwrite. But ask the **store** for the earlier statement
and `evidence` is empty. Keeping a local variable alive isn't an audit trail.

This isn't a missing query helper. Consider a different history:

<<< @/snippets/blog/remembers-why/01/story.ts#indistinguishable

That program records only `false`. Its complete stored state is identical
to the corrected store's state. One history had a mistaken `true`; the other
never did. No query over the remaining Map can distinguish them.

Now someone asks why Maria was assigned to a site. The assignment may have
been reasonable given the training record at the time. We cannot establish
that from today's value. The update didn't just change an answer. It
destroyed the evidence needed to explain an earlier answer.

## What this version leaves out

We have a synchronous, in-memory, single-value store with linear scans.
No persistence, indexes, atomic multi-fact transactions, validation,
authorization, retractions, timestamps, actors, or rule versions. Map
insertion order is not a transaction log. There are no modeled errors to
quote yet; malformed external input isn't supported.

Most importantly, this is **not bitemporal yet**. We cannot ask when a fact
held in the world or when we learned it. Adding a date attribute wouldn't
recover an overwritten statement either.

### This is what Triplex does

The real Triplex retains assertions and retractions and reads facts using
independent valid and recorded times. Its `Triples` service is not this
`makeStore`, and its write contract isn't `put`. See
[Core concepts](/concepts) for facts, corrections, and the two clocks,
and [Getting started](/getting-started) for runnable library code.

Those guarantees don't make every assertion true. They let us preserve and
inspect what was asserted. The rest of the series builds toward that
distinction; [Current state](/current-state) describes what the real library
supports today.

## Next: preserve the statement

**Part 2, “Nothing is overwritten,” is coming.** We will stop replacing
facts and record assertions and retractions in a transaction log. A
correction must change the current answer without erasing the statement
that made an earlier answer possible. Only then can Part 3 give that
history two clocks.

The [source and tests](https://github.com/bjacobso/triplex/tree/main/docs/snippets/blog/remembers-why/01)
live together. Every code block above is a named-region import from those
files; CI checks the opening result, every question, and the two
indistinguishable histories. [Back to the series](./).
