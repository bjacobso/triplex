---
title: Someone did this
description: Part 4 of The Database That Remembers Why. Commit a command, actor, rule context, facts, and receipt together so a retry cannot become another business event.
prev:
  text: Two clocks, two questions
  link: /blog/remembers-why/03-two-clocks-two-questions
next:
  text: A shape is not an invariant
  link: /blog/remembers-why/05-a-shape-is-not-an-invariant
---

# Someone did this

Part 04 of [The Database That Remembers Why](./) · Act I, Facts · November 8, 2026

<<< @/snippets/blog/remembers-why/04/run.ts#run

The first request committed. The retry did not. Looking up the command's
receipt finds the original position, not a second event that happens to
look like the first.

[Part 3](./03-two-clocks-two-questions) recorded when we learned something.
It didn't record who asked us to change it or identify the request that
caused the commit. Let's put those beside the facts, not in a separate log
we hope stays in sync. This remains **teaching code**, using Effect 4.1.1,
not Triplex's API.

## Name the attempt that may succeed once

Keep the temporal transaction, and attach the command that produced it:

<<< @/snippets/blog/remembers-why/04/commands.ts#model

The command ID identifies one intended submission. The actor identifies
the principal claimed by the host. The rule label records the context
the caller supplied. It does **not** yet identify executable, immutable
rules; we'll expose that hole shortly.

A receipt is the committed temporal transaction plus that command. Keeping
one object for both avoids an independent receipt write that could succeed
when the facts fail, or fail after the facts succeed. Our journal is now
the sequence of these receipts.

Neither the type nor the database authenticates `actor`. A real host must
derive it from trusted request context, not let a caller impersonate Pat by
typing a string. Attribution without authentication is just a recorded
claim.

## Lose the response, then retry

Imagine the server commits Maria's training but the response never reaches
the caller. The caller resubmits the **same command ID**:

<<< @/snippets/blog/remembers-why/04/story.ts#command

The duplicate fails with
`command already committed: record-training:maria:request-17`.
The caller can then fetch the original receipt. Both `first` and `receipt`
have position 1; the journal has one entry. The receipt records `user:pat`
and `hr-2026.1` along with the assertion and its time.

This contract is deliberately explicit: duplicates are rejected, not
silently returned as successes. A missing lookup returns `undefined`. We
don't compare the retried body with the original body and pretend that
matching IDs prove matching intent. The receipt shows what actually won.

The caller must preserve the ID across retries. Generating a new ID for
each network attempt defeats this protection. Conversely, reusing an ID
for a different business event is an error even if the facts differ.

## Claim the ID where we commit the facts

Reuse Part 3's record operation. Reject an already committed command before
staging a new transaction:

<<< @/snippets/blog/remembers-why/04/commands.ts#accept

The ID claim is the receipt's presence in the journal. There is no separate
set to update before or after it. A failed assertion or retraction leaves
no receipt, so that command ID is still available for a corrected attempt.

But a duplicate check alone isn't enough. It must share the commit boundary:

<<< @/snippets/blog/remembers-why/04/commands.ts#store

One permit covers the clock, ID lookup, staging checks, and append. If two
callers race with the same command ID but different assertion IDs, only
one can commit. This isn't accidental protection from assertion-ID
collisions; command identity itself prevents the second event.

Reads and returned receipts are copies. Changing a returned actor doesn't
rewrite who the journal says acted. As before, this protects one store
instance in memory, not multiple processes or a durable database.

## A rule label is not a rule

Try a training value that the intended domain should reject:

<<< @/snippets/blog/remembers-why/04/story.ts#rules-gap

The string `"yes"` commits. The receipt dutifully records `hr-2026.1`.
Nothing in the store knows what that label means, and nothing checks that
training must be a boolean.

The journal is more useful now, but it must not overclaim. It says Pat
submitted this statement in this named context. It does not establish that
the context was applied, much less preserve the definition of that context.
Those are two separate missing pieces, not something a metadata field
can supply on its own.

## What this version leaves out

IDs are local to this store. There is no persistence, authenticated host,
authorization policy, command-body fingerprint, or external delivery.
Rejecting a duplicate commit doesn't make an email or payment exactly-once.
Such effects need their own host-side delivery and retry contract.

Rules are still labels. Attribute values remain unchecked beyond their
primitive TypeScript types. We have preserved the submitted evidence and
its claimed author, not validated the business claim.

### This is what Triplex does

Triplex's real command envelope and journal commit command identity,
attribution, changes, and receipts atomically. Duplicate command IDs fail
with the library's own typed error; they are not silent successes. See
[Operational primitives](/operational-primitives) for the actual contract
and [Host integration](/host-integration) for the authentication and delivery
responsibilities that remain outside the database. Our three-field command
and `StoreError` are not those public APIs.

## Next: check the world we're about to publish

We can say who submitted the string `"yes"` and prove that a retry did not
submit it twice. We still accepted the wrong kind of value. And checking
one value won't prevent two workers from claiming the same employee code.
[Part 5](./05-a-shape-is-not-an-invariant) puts schemas and cross-fact
constraints inside the transaction.

The [source and tests](https://github.com/bjacobso/triplex/tree/main/docs/snippets/blog/remembers-why/04)
check the receipt, exact duplicate error, competing commands, failed-ID
reuse, copy isolation, and the unenforced rule label. [Back to the series](./).
