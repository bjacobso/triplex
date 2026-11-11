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
| Effect         | Requires `effect@4.1.1`. Effect 3 is not compatible                          |
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
  and `unique`. The same attribute can be required in one type and optional in another. Declare a
  use with `.required()`, `.many()`, or `.unique()`; a bare attribute is optional and single-valued.
- Model relationships as `Attribute.ref(key, TargetType)`. There are no join tables. Datalog joins
  on shared values.
- Available value types: `text`, `number`, `integer`, `boolean`, `date`, `instant`, `enumOf`,
  and `ref`. `date` is a calendar string that ordered predicates (`<`, `>`) cannot compare; use
  `instant` (epoch milliseconds or a `Date`) for anything you compare or expire. See the
  [value-type table](/configuration#ontology-dsl).
- Set `entityType` on every assertion so type-level reads and constraints can find the entity.
  `Type.assert(id, values, options?)` does this for you and types each value by its attribute.

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
   `GraphConstraint.pinned(release)` returns both from one snapshot.
5. **Put business time on the assertion.** Use `validFrom` and `validTo` when the dates define when
   the fact holds. Intervals are half-open: `[validFrom, validTo)`. Omitted `validFrom` means the
   commit time.
6. **Give all of an entity's facts one interval.** Enforced constraints are checked at every
   valid-time edge of the entity, not only now. Assert every attribute of a new entity with the same
   `validFrom`, and make referenced entities valid from an earlier (or the same) time as the facts
   that point at them. Otherwise the entity exists at some instant without a required attribute, or
   references an entity that does not exist yet, and the write fails with
   `ConstraintViolationError`. Read `error.violations`: each entry carries the `validAt` at which
   it fails.
7. **Correct facts; don't delete them.** Use `Change.correct(fact, value)` or
   `Vendor.correct(fact, { status: "active" })` for a value that was wrong over its whole interval.
   Submit `change.ops` and `{ preconditions: change.preconditions }` to the same `transact` call.
   The generated `TripleLive` guard makes a concurrent change fail with `TransactionConflictError`.
8. **End a value at a time; don't erase its past.** A retraction removes the assertion from all of
   valid time. Use `Change.replace(fact, string("active"), T)` or
   `Vendor.replace(fact, { status: "active" }, T)` to preserve the past and replace from `T`.
   Use `Change.end(fact, T)` when there is no replacement, and `Change.combine` to collect changes
   to several facts. Always pass the generated preconditions to the same transaction. See
   [ending a fact at a time](/concepts#end-a-fact-at-a-time).
9. **Guard check-then-write commands with `EntityState`.** When a command reads an entity, decides,
   and then writes, pass `{ _tag: "EntityState", entityId, tripleIds }` with the live fact IDs you
   read. Another writer's change in between fails the command with `TransactionConflictError`. See
   [entity-state preconditions](/operational-primitives#entity-state-preconditions).

<<< @/snippets/home/site-safety/app.ts#command

A retry with the same command ID returns the original receipt, and the journal gains no entry:

<<< @/snippets/home/site-safety/story.ts#retry

Read more in [Operational primitives](/operational-primitives) and
[Troubleshooting](/troubleshooting#what-should-happen-on-a-duplicate-command-id).

## 4. Model obligations as derivations

- Write the obligation as a Datalog query. Positive patterns describe the situation, and a `not`
  clause describes the missing evidence. Every variable in `not` must be bound outside it.
  `Type.where(entity, { alias: "?var" })` and `Type.not(...)` build those clauses from aliases.
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
- **Who asserted the state that held at a past date?** Don't join `["?tx", ":_tx/actor", "?a"]`
  into a query with a past `validAt`: transaction facts are valid only from their commit instant,
  so the join silently returns `[]`. Bind `?tx` in the past-`validAt` query, then read provenance
  in a second query at the current basis or with `transaction(txId)`. See
  [Datalog](/datalog#query-shape).
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

| Don't                                                               | Do instead                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Generate a new random `commandId` on every retry                    | Derive it from the request; handle `CommandAlreadyCommittedError`         |
| Pin `configSnapshot` and assume constraints were checked            | Also pass `enforce` built from that snapshot                              |
| Retract a fact in one command and assert its replacement in another | Use `Change.correct` and submit its ops and preconditions together        |
| Retract an open state to change it from a date on                   | Use `Change.replace`; use `Change.end` to end without replacement         |
| Store a date attribute when the date says when the fact holds       | Use `validFrom` and `validTo`                                             |
| Backdate one attribute of an entity and let the others default      | Give all of an entity's facts the same `validFrom`                        |
| Re-run derivations on a fixed timer                                 | Follow the journal and wake up at `nextTemporalBoundary`                  |
| Treat an empty `stale` or `unmaterialized` result as "no work"      | Check freshness and rematerialize                                         |
| Put task status, assignees, or SLAs in the derivation               | Keep the task lifecycle in host code, driven by reconciliation            |
| Call `queryAll` on request paths                                    | Use `query` and follow `nextCursor` (100 rows per page by default)        |
| Encode authorization as Datalog over the same store                 | Authorize in the host before providing `Triples`                          |
| Check a write rule before `transact`, then write                    | Enforce it in a commit validator, which reads the state that would commit |

## Inspect with the CLI

The CLI is non-interactive and prints one JSON envelope per command:
`{ "ok": true, "command": ..., "data": ... }` on success, and `{ "ok": false, "command": ..., "error": Diagnostic }` on
stderr with a nonzero exit on failure. The diagnostic has `code`, `message`, `retryable`,
and optional `path`, `fix`, and `details`. Branch on `code`; use `fix` to correct the input.
Only retry a retryable conflict after reloading facts. Add `--debug` to include the original
`cause` string; see [Error diagnostics](/errors). Writes require `meta.actor` and `meta.commandId`.

```sh
npm install --global @triplex-build/triplex-cli
triplex --sqlite ./app.db describe                  # capabilities and live release schema
triplex --sqlite ./app.db entity types
triplex --sqlite ./app.db entity facts worker:maria
triplex --sqlite ./app.db entity history worker:maria --limit 25
triplex --sqlite ./app.db query explain --input query.json
triplex --sqlite ./app.db journal receipt placement:create:maria-harbor
triplex --sqlite ./app.db config release --ref live
```

Start with `describe`: `data.schema` includes the release identity, all entity types and attributes,
usage constraints and sensitivity, graph constraints, configuration/derivation objects, write rules,
and one `{ entityType, input }` example per type. Each input pins and enforces the same release.
Replace its synthetic placeholders with application values, create referenced targets first, and
submit the input to `transaction apply`. Use `describe --ref preview` to inspect another ref.
If the ref has no release, `data.schema` is `null` and `data.hint` explains how to publish one.

The unscoped `triplex` package on npm is an unrelated project. See [CLI and dashboard](/tools) for
the full command set.

## Next

- [Getting started](/getting-started) to run a first program with expected output
- [Core concepts](/concepts) for facts, retractions, and the two clocks
- [Datalog](/datalog) for joins, negation, aggregation, recursion, and pagination
- [Host integration](/host-integration) for the full responsibility boundary
- [Troubleshooting](/troubleshooting) for empty queries, missing services, and stale projections
