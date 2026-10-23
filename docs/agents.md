---
description: A prescriptive guide for coding agents modeling a back-office domain with Triplex. It maps domain concepts to primitives and lists the rules every command should follow.
---

# Modeling a back-office domain

This guide is for coding agents, and the people directing them, who are deciding whether and how
to model a back-office domain in Triplex. It is prescriptive on purpose: follow the rules unless
you have a specific reason not to, and each section links to the reference behind it.

Every code block on this page comes from the
[site-safety scenario](https://github.com/bjacobso/triplex/tree/main/docs/snippets/home/site-safety).
CI type-checks and runs that scenario on every change. This page is also available as
[Markdown](/agents.md), and the full documentation is available as [`/llms-full.txt`](/llms-full.txt).

## Decide whether Triplex fits

Use Triplex when the domain has one or more of these properties:

- People ask what was true, or what the system believed, at an earlier date.
- Policies, schemas, or forms change, and earlier decisions must still be explained under the
  rules that applied then.
- Work follows from the data: missing evidence, expiring certifications, cases waiting for review.
- Several actors write, whether people, services, or agents, and every change must be attributed
  and safe to retry.

Do not use it for high-volume telemetry, blobs, caches, queues, or tables that never need history
or provenance. Those belong in your existing database, and Triplex can live
[beside it](/host-integration).

Check these constraints with the people you work for before adopting it:

| Constraint     | Current contract                                                             |
| -------------- | ---------------------------------------------------------------------------- |
| Maturity       | Pre-1.0. See [Current state](/current-state)                                 |
| Effect         | Requires `effect@4.0.3`. Effect 3 is not compatible                          |
| Runtime        | ESM-only, Node.js 22+, modern browsers and edge runtimes for the core        |
| Durable stores | SQLite is supported. PostgreSQL is a production candidate                    |
| Host duties    | Authentication, authorization, task lifecycle, timers, and retries are yours |

## Map the domain

| In your domain                          | In Triplex                                                           |
| --------------------------------------- | -------------------------------------------------------------------- |
| Things: workers, sites, cases, accounts | Stable `EntityId`s and an `EntityType` per kind                      |
| Properties and relationships            | Global `Attribute` keys, with `Attribute.ref` for relationships      |
| Schemas, policies, forms                | Config nodes committed as an immutable release, pointed to by `live` |
| User and system actions                 | One `transact` call per command                                      |
| Evidence that starts or expires         | `validFrom` and `validTo` on the assertion                           |
| Corrections                             | Retract and assert in one transaction                                |
| Obligations and to-dos                  | A `Derivation` whose candidates you reconcile                        |
| Tickets, notifications, SLAs            | Your code, driven by reconciliation diffs                            |
| Audit questions                         | A temporal basis, command receipts, and the journal                  |

## 1. Name entities and attributes

- Give every entity a stable, typed ID such as `worker:maria` or `case:01J9…`. Construct IDs once
  at the application boundary with `EntityId.make`. Don't cast strings deep inside domain code.
- Attribute keys are global keywords of the form `:namespace/name`, matching
  `^:[a-z][a-z0-9_-]*/[a-z][a-z0-9_-]*$`. An attribute owns its identity and value type.
- An entity type owns how it uses an attribute: `required`, `cardinality` (`"one"` or `"many"`),
  and `unique`. The same attribute can be required in one type and optional in another.
- Model relationships as `Attribute.ref(key, TargetType)`. There are no join tables. Datalog joins
  on shared values.
- Available value types: `text`, `number`, `integer`, `boolean`, `date`, `instant`, `enumOf`,
  and `ref`.
- Set `entityType` on every assertion so type-level reads and constraints can find the entity.

<<< @/snippets/home/site-safety/app.ts#model

Read more in [Typed configuration](/configuration#ontology-dsl).

## 2. Publish rules as releases

- Commit schemas, policies, and forms together with `config.commit({ label, objects, ref: "live" })`.
  Each release is immutable and content-addressed.
- To change the rules, publish a new release. Never edit an old one. Moving `live` back
  to an earlier release doesn't roll back data.
- At command time, resolve the release you intend to enforce and keep its snapshot for the whole
  command.

<<< @/snippets/home/site-safety/app.ts#release

Read more in [Releases, refs, and rollback](/configuration-versioning).

## 3. Write each command as one transaction

Follow these rules for every write:

1. **One application command is one `transact` call.** Everything the command changes commits or
   rolls back together.
2. **Always set `actor` and a deterministic `commandId`.** Derive the command ID from the request
   so that a retry reuses it. Command IDs are atomically unique per database, and a duplicate fails
   with `CommandAlreadyCommittedError` instead of applying twice.
3. **Set `correlationId` and `causationId`.** Use the request or case for correlation and the
   triggering command or event for causation.
4. **Pin `configSnapshot` and pass `enforce` from the same release.** Pinning alone only records
   which rules applied. Constraints are checked only when you also pass them with `enforce`.
5. **Put business time on the assertion.** Use `validFrom` and `validTo` when the dates define when
   the fact holds. Intervals are half-open: `[validFrom, validTo)`.
6. **Correct facts; don't delete them.** Retract the wrong assertion and assert the correct one in
   the same transaction. For facts that other writers may also change, add a
   `{ _tag: "TripleLive", id }` precondition so a concurrent change fails with a conflict instead
   of being lost.

<<< @/snippets/home/site-safety/app.ts#command

A retry with the same command ID returns the original receipt, and the journal gains no entry:

<<< @/snippets/home/site-safety/story.ts#retry

Read more in [Operational primitives](/operational-primitives) and
[Troubleshooting](/troubleshooting#what-should-happen-on-a-duplicate-command-id).

## 4. Model obligations as derivations

- Write the obligation as a Datalog query. Positive patterns describe the situation, and a `not`
  clause describes the missing evidence. Every variable in `not` must be bound outside it.
- Set `identity` to the variables that name one obligation, such as worker and site. Candidate IDs
  are then stable across re-evaluations.
- Use `Derivation.evaluate` for reads and previews, and
  `Derivation.Materialization.materialize` for durable, freshness-tracked runs.
- Pass the difference from `Derivation.reconcile` (`added`, `removed`, `changed`) to your own task
  system. Triplex decides what should be open; your code decides what "open" means.
- Wake up at `nextTemporalBoundary` to catch expiring or future-effective evidence. Don't poll.
- Follow the journal with `triples.transactions({ after })` and a `ConsumerCheckpoint`. Advance
  the checkpoint only after downstream effects succeed.
- A `stale` or `unmaterialized` result doesn't mean there is no work. Rematerialize before
  treating an empty result as current.

<<< @/snippets/home/site-safety/app.ts#derive

The
[compliance host example](https://github.com/bjacobso/triplex/tree/main/examples/compliance-host)
adds the complete loop: journal consumer, durable task occurrences, a hypothetical preview, and a
scheduler that reopens work at expiry. Read more in [Derivations](/derivations).

## 5. Answer audit questions

- **What did we believe then about what was true then?** Set both `recordedAt` and `validAt`.
  Setting only one leaves the other at "now".
- **What did we know when we made a decision?** Use the decision's receipt `instant` as
  `recordedAt`. Find the receipt with `transactionByCommand`.
- **Who changed this entity, and why?** Page `transactionsForEntity(entityId)`, newest first.
  Each record carries its actor, command, correlation, causation, release, and typed changes.
- **What was retracted?** `history(entityId)` includes retracted assertions. `entity` and `match`
  show only facts visible at the basis you ask for.

<<< @/snippets/home/site-safety/app.ts#ask

## 6. Choose a runtime

Construct one layer per database lifetime, at the application boundary. Building an in-memory
layer again creates a new empty database, and building a SQL layer per request defeats connection
sharing.

<<< @/snippets/home/site-safety/app.ts#run

On PostgreSQL, Triplex can join your application's own Effect SQL transaction, so your rows,
Triplex facts, the journal, and an outbox row commit together. See
[Host integration](/host-integration#choose-a-runtime).

## Anti-patterns

| Don't                                                               | Do instead                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Generate a new random `commandId` on every retry                    | Derive it from the request; handle `CommandAlreadyCommittedError`  |
| Pin `configSnapshot` and assume constraints were checked            | Also pass `enforce` built from that snapshot                       |
| Retract a fact in one command and assert its replacement in another | Do both in one transaction                                         |
| Store a date attribute when the date says when the fact holds       | Use `validFrom` and `validTo`                                      |
| Re-run derivations on a fixed timer                                 | Follow the journal and wake up at `nextTemporalBoundary`           |
| Treat an empty `stale` or `unmaterialized` result as "no work"      | Check freshness and rematerialize                                  |
| Put task status, assignees, or SLAs in the derivation               | Keep the task lifecycle in host code, driven by reconciliation     |
| Call `queryAll` on request paths                                    | Use `query` and follow `nextCursor` (100 rows per page by default) |
| Encode authorization as Datalog over the same store                 | Authorize in the host before providing `Triples`                   |

## Inspect with the CLI

The CLI is non-interactive and prints one JSON envelope per command:
`{ "ok": true, "command": ..., "data": ... }` on success, and `{ "ok": false, "error": ... }` on
stderr with a nonzero exit on failure. Writes require `meta.actor` and `meta.commandId`.

```sh
npm install --global @triplex-build/triplex-cli
triplex --sqlite ./app.db describe                  # capability manifest
triplex --sqlite ./app.db entity types
triplex --sqlite ./app.db entity facts worker:maria
triplex --sqlite ./app.db entity history worker:maria --limit 25
triplex --sqlite ./app.db query explain --input query.json
triplex --sqlite ./app.db journal receipt placement:create:maria-harbor
triplex --sqlite ./app.db config release --ref live
```

The unscoped `triplex` package on npm is an unrelated project. See [CLI and dashboard](/tools) for
the full command set.

## Next

- [Getting started](/getting-started) to run a first program with expected output
- [Core concepts](/concepts) for facts, retractions, and the two clocks
- [Datalog](/datalog) for joins, negation, aggregation, recursion, and pagination
- [Host integration](/host-integration) for the full responsibility boundary
- [Troubleshooting](/troubleshooting) for empty queries, missing services, and stale projections
