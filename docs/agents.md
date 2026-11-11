---
description: A prescriptive guide for coding agents modeling a back-office domain with Triplex. It maps domain concepts to primitives and lists the rules every command should follow.
---

# Modeling a back-office domain

This guide is for coding agents, and the people directing them, who are deciding whether and how
to model a back-office domain in Triplex. It is prescriptive on purpose: follow the rules unless
you have a specific reason not to, and each section links to the reference behind it.

Start with `@triplex-build/triplex/database`: declare your model, publish it, then open the
[schema-bound client](/database). The examples below come from the checked, executable
[client site-safety scenario](https://github.com/bjacobso/triplex/blob/main/docs/snippets/client-site-safety.ts).
CI type-checks and runs it alongside the lower-level homepage scenario. This page is also available as
[Markdown](/agents.md), and the full documentation is available as [`/llms-full.txt`](/llms-full.txt).

Agents can also inspect and write a database through the private, experimental [MCP server](/mcp).
Start with its `describe` tool to discover the live release and example transactions, then use the
same CLI operations through MCP with an actor and command ID on every write.

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
| User and system actions                 | One `db.command` call per action                                     |
| Evidence that starts or expires         | `validFrom` and `validTo` on the assertion                           |
| Corrections                             | `tx.correct`, `tx.end` or `tx.replace` inside one command            |
| Obligations and to-dos                  | A `Derivation` whose candidates you reconcile                        |
| Tickets, notifications, SLAs            | Your code, driven by reconciliation diffs                            |
| Audit questions                         | A temporal basis, command receipts, and the journal                  |

## 1. Declare entity types and attributes

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
- The client's `tx.create` and `tx.put` set `entityType` and encode values through the declared
  attributes so type-level reads and constraints can find the entity.

<<< @/snippets/client-site-safety.ts#model

Read more in [Typed configuration](/configuration#ontology-dsl).

## 2. Publish rules as releases

- Commit schemas, policies, and forms together with `config.commit({ label, objects, ref: "live" })`.
  Each release is immutable and content-addressed.
- To change the rules, publish a new release. Never edit an old one. Moving `live` back
  to an earlier release doesn't roll back data.
- Publish before acquiring the client; acquisition checks that your declarations match the release.
  The client resolves and pins the current release when each new command is admitted.

<<< @/snippets/client-site-safety.ts#release

Read more in [Releases, refs, and rollback](/configuration-versioning).

## 3. Open the client and write commands

The client requires `actor` and `commandId` on every command; derive the ID from the request and
reuse it on retries. It pins and enforces the same release automatically. A retry returns the
original receipt without running the callback or applying another write.

<<< @/snippets/client-site-safety.ts#command

<<< @/snippets/client-site-safety.ts#retry

- Run builder Effects sequentially: one `db.command` callback becomes one atomic transaction.
- Authenticate and authorize in the host before calling the client. `correlationId` and
  `causationId` can connect the command to its request, case, or triggering event.
- Put business time in `validFrom` and `validTo`; intervals are half-open: `[validFrom, validTo)`.
  Omitted `validFrom` means commit time. Builder writes share an interval across the entity's
  attributes. Referenced targets must be valid from an earlier or equal time. Constraint failures
  report the failing `validAt` in `error.violations`.
- Use `tx.get(Type, id)` for check-then-write decisions; it decodes through `Type.decode` and
  automatically guards the entity's observed history against concurrent writes.
- For temporal edits, fetch a fact with `tx.fact(Type, tripleId)`, then use `tx.correct`,
  `tx.replace`, or `tx.end`. These include the needed concurrency preconditions.
  `correct` replaces the whole interval; `replace` changes from a date on; `end` preserves only
  the past. A retraction alone removes the whole valid interval from current recorded knowledge.
- Keep irreversible external actions outside callbacks. Record outgoing intents with
  `tx.outbox.append`; the host delivers them after commit.

Read [Database client](/database) for typed `get`, bounded queries with Schema projections, builder
semantics and stable `asOf` views. See [Operational primitives](/operational-primitives) for the
underlying transaction contract.

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

<<< @/snippets/client-site-safety.ts#derive

The
[compliance host example](https://github.com/bjacobso/triplex/tree/main/examples/compliance-host)
adds the complete loop: journal consumer, durable task occurrences, a hypothetical preview, and a
scheduler that reopens work at expiry. Read more in [Derivations](/derivations).

## 5. Answer audit questions

- **What did we believe then about what was true then?** Set both `recordedAt` and `validAt`.
  Setting only one leaves the other at "now".
- **What did we know when we made a decision?** Use `db.asOf({ recordedPosition: receipt.position, validAt })` for an exact read cut.
  The receipt is returned by `db.command`; raw journal lookup uses `transactionByCommand`.
- **Who changed this entity, and why?** Page `transactionsForEntity(entityId)`, newest first.
  Each record carries its actor, command, correlation, causation, release, and typed changes.
- **Who asserted the state that held at a past date?** Bind the assertion transaction in a
  fourth tuple term and join `["?tx", ":_tx/actor", "?actor"]` in the same query.
  Reserved `:_tx/*` metadata uses the recorded cut and ignores valid time, so the join works
  for backdated assertions. A recorded cut before the commit still hides its metadata. See
  [Datalog](/datalog#query-shape).
- **What was retracted?** `history(entityId)` includes retracted assertions. `entity` and `match`
  show only facts visible at the basis you ask for.

<<< @/snippets/client-site-safety.ts#ask

## 6. Choose a runtime

Publish first, then provide `Database.layer({ schema: Model })` to the application. Keep publishing
and the client over the same `ConfigStore` and `Triples` instance. The complete example creates the
referenced site and worker before placing them.

Construct one layer per database lifetime, at the application boundary. Building an in-memory
layer again creates a new empty database, and building a SQL layer per request defeats connection
sharing.

<<< @/snippets/client-site-safety.ts#run

On PostgreSQL, Triplex can join your application's own Effect SQL transaction, so your rows,
Triplex facts, the journal, and an outbox row commit together. See
[Host integration](/host-integration#choose-a-runtime).

## Underneath the client

Use raw `Triples` explicitly for host infrastructure, migrations, derivations and journal consumers.
It is the primitive API; it does not add the client's defaults. Derivations above still take a
`Triples` service and an explicit release.

A raw write supplies `actor` and a stable `commandId`, plus both `configSnapshot` and `enforce` from
`GraphConstraint.pinned(release)`. The lower-level equivalent of the placement command is:

<<< @/snippets/home/site-safety/app.ts#command

Raw duplicate commands fail with `CommandAlreadyCommittedError`; recover the receipt with
`transactionByCommand`. Raw read-decide-write commands must pass `EntityState` preconditions, and
`Change.correct`, `Change.replace` and `Change.end` return operations and preconditions that must
be submitted together. Install [SchemaBound](/datalog#query-shape) for release-checked raw queries.
The [homepage scenario](https://github.com/bjacobso/triplex/tree/main/docs/snippets/home/site-safety)
executes this primitive form and its receipt recovery as a separate checked example.

## Anti-patterns

| Don't                                                               | Do instead                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Generate a new random `commandId` on every retry                    | Reuse the request ID; `db.command` returns the original receipt           |
| Pin `configSnapshot` and assume constraints were checked            | Use `db.command`, which pins and enforces together                        |
| Retract a fact in one command and assert its replacement in another | Use `tx.correct` inside one command                                       |
| Retract an open state to change it from a date on                   | Use `tx.replace`; use `tx.end` to end without replacement                 |
| Store a date attribute when the date says when the fact holds       | Use `validFrom` and `validTo`                                             |
| Backdate one attribute of an entity and let the others default      | Give all of an entity's facts the same `validFrom`                        |
| Re-run derivations on a fixed timer                                 | Follow the journal and wake up at `nextTemporalBoundary`                  |
| Treat an empty `stale` or `unmaterialized` result as "no work"      | Check freshness and rematerialize                                         |
| Put task status, assignees, or SLAs in the derivation               | Keep the task lifecycle in host code, driven by reconciliation            |
| Read provenance in a second query with a different recorded cut     | Join the asserting transaction and `:_tx/actor` at one recorded cut       |
| Call `queryAll` on request paths                                    | Use `query` and follow `nextCursor` (100 rows per page by default)        |
| Encode authorization as Datalog over the same store                 | Authorize in the host before providing the client                         |
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
