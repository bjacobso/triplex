---
date: "2026-11-08"
series: remembers-why
title: A shape is not an invariant
description: Part 5 of The Database That Remembers Why. Decode facts with Effect Schema, then check entity shape, uniqueness, and temporal boundaries before a transaction commits.
prev:
  text: Someone did this
  link: /blog/remembers-why/04-someone-did-this
next: false
---

# A shape is not an invariant

Part 05 of [The Database That Remembers Why](./) · Act II, Rules

<<< @/snippets/blog/remembers-why/05/run.ts#run

Maria's correction fails. The journal still has the onboarding transaction,
and no receipt claims the correction committed. We finally reject the
string `"yes"` instead of storing it as a training value.

[Part 4](./04-someone-did-this) made the author and command visible without
enforcing their named rules. This time we'll decode incoming changes and
check the world they would create, using Effect Schema. It is **teaching
code** on Effect 4.1.1, not Triplex's configuration or transaction API.

## A value can have the right shape in the wrong world

Start with a worker's shape:

<<< @/snippets/blog/remembers-why/05/story.ts#shape

That object has a worker marker, an employee code, and a boolean training
value. Decoding it succeeds. Giving the same object to a second worker
would succeed too. A Schema decoder seeing one object cannot know that
another entity already claims `M-17`.

We'll enforce two different contracts: **shape**, including required
attributes and their types, and **uniqueness** of employee codes among
workers valid at the same instant. Codes are case-sensitive in this model.
Display names aren't unique keys; Maria and another Maria may share a name.

## Decode changes, then decode entities

Here are the schemas and the earlier pieces they reuse:

<<< @/snippets/blog/remembers-why/05/validation.ts#schemas

`Changes` decodes the operation envelope and primitive fact values from
`unknown`. `Worker` describes the assembled entity, not one triple. A
string is a legitimate primitive fact value, but not a legitimate training
value. Those checks occur at different levels.

For this version every entity is a Worker, and every attribute has exactly
one value. The `:entity/type` sentinel is our teaching convention, **not**
Triplex's entity-type registration API. We are not yet designing a general
configuration language.

Assemble facts by entity and check both contracts:

<<< @/snippets/blog/remembers-why/05/validation.ts#entity

Two live assertions for the same attribute are an error even if their
values agree. Required fields and value types come from `Worker`. Unknown
attributes are rejected rather than silently stripped. The null-prototype
object lets even an incoming attribute named `__proto__` reach that check
as data, instead of interacting with an inherited property.

The set of codes is shared across the entities being checked. That is the
piece a shape decoder alone couldn't supply.

## “Now” is not the whole timeline

Checking the state at commit time is tempting and wrong. Suppose training
is required, but its assertion expires tomorrow while the worker's other
attributes continue. Today's shape is valid. Tomorrow's is missing a field.

Our interval model changes only at assertion starts and ends. Check each
boundary in the proposed recorded-time view:

<<< @/snippets/blog/remembers-why/05/validation.ts#boundaries

At an end boundary the ending assertion is already absent; an assertion
starting there is already present. This checks every distinct state on the
timeline without polling every millisecond. Before the first boundary
there are no entities to validate.

The scan uses the latest recorded view, so withdrawn evidence doesn't
create an extra current entity. Older recorded views are left intact.
All this is deliberately brute-force: replaying every boundary is a clear
teaching algorithm, not a performance claim about Triplex.

## Publish only after the checks succeed

Keep Part 4's ID check and receipt creation. Validate the proposed journal
before making it the store's journal:

<<< @/snippets/blog/remembers-why/05/validation.ts#store

Decoding, ID claiming, temporal validation, uniqueness, and append share
one permit. Otherwise two callers could both observe an unused code and
publish individually valid but jointly conflicting workers.

A rejection leaves facts, receipt, and transaction position untouched.
There is no “compensating” transaction to erase a half-accepted command.
The failed command ID remains available for a corrected attempt.

## Try the correction again

Onboard Maria with code `M-17`, then replace her boolean training value
with a string:

<<< @/snippets/blog/remembers-why/05/story.ts#onboarding

The opening error comes from Schema: `Expected boolean`, followed by
`  at [":worker/trained"]`. `Effect.flip` makes the expected failure a
value so the story can inspect it. The stored training remains `true`;
the journal has one entry, and `correct:maria` has no receipt.

Now give Lee the same employee code:

<<< @/snippets/blog/remembers-why/05/story.ts#uniqueness

Both worker shapes would decode, but the proposed world fails with
`worker code already used: M-17`. Again the journal has one entry. The
tests also race two code claims, then retry the loser with a distinct code:
one initial commit wins, and the corrected attempt gets position 2.

## What this version leaves out

One entity type, three required attributes, scalar values, and one unique
key. No references, deletions with cascading policies, schema registry, or
incremental constraint indexes. Entirely retracting an entity removes it
from validation; there is no separate existence record.

Most importantly, this validator checks the **whole proposed timeline**
against today's hard-coded rules. It doesn't distinguish newly introduced
violations from existing ones and offers no migration or grandfathering
policy. Changing the decoder can make the next write fail because of an
unrelated old entity. That is a limitation, not automatic correctness.

### This is what Triplex does

Real Triplex describes attributes and entity types with Effect Schema and
checks opted-in constraints at the transaction boundary. Its enforcement
policy rejects new or worsened violations rather than blindly using this
full-state teaching check. See [Configuration](/configuration) and the
[configuration walkthrough](/configuration-versioning) for actual schemas,
constraints, releases, and enforcement modes. [Current state](/current-state)
remains the maturity contract.

## Next: which rules accepted this fact?

The receipt still says `hr-2026.1`, but the executing rules live in a mutable
source file. Change `Worker` tomorrow and that label explains nothing about
what accepted yesterday's transaction. We need to identify and retain the
rule definitions, not just remember a name.

**Part 6, “Rules are releases,” is coming.** It will give immutable rule
content an identity and separate it from the movable reference that chooses
what accepts the next write. This installment stops here for review.

The [source and tests](https://github.com/bjacobso/triplex/tree/main/docs/snippets/blog/remembers-why/05)
check quoted results, invalid shapes, excess attributes, cardinality,
future expiry boundaries, concurrent uniqueness, and atomic rejection.
[Back to the series](./).
