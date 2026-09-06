# Triplex Dashboard

A standalone, browser-local explorer for Triplex. The dashboard uses Effect and
Foldkit end to end, with accessible controls from `@foldkit/ui` and Tailwind CSS.

```sh
pnpm dashboard
```

Open <http://localhost:4173>. The app starts a fresh in-memory Triplex database,
loads an optional students/courses/teachers demo fixture, and then reflects the
resulting database through six domain-independent views:

- overview and configured derivation candidates;
- entity-type discovery with temporal-basis-pinned, opaque-cursor tables whose columns
  are reflected from stored attributes, plus entity-scoped transaction timelines;
- generic form previews for configuration nodes that opt into `triplex.form/v1`;
- editable raw Datalog with query plans;
- the causal transaction journal;
- content-addressed releases, refs, logical config objects, immutable revision ancestry,
  dependency closures, and canonical stored bodies.

The entity workbench can create and edit typed facts as one attributed transaction. It
reflects configured attributes and value types—falling back to observed facts—into an editable form,
provides a searchable entity picker for reference attributes, allows individual attributes to be
included or cleared, and retains a Raw JSON mode for exact bitemporal or multi-valued edits.
The configuration workbench can create, edit, or remove top-level logical objects;
validate typed attributes and cross-object references; publish without changing an
environment; and explicitly promote or roll back `live` and `test` to any release.
Earlier revisions remain immutable and browseable. Nested children are preserved when
editing an object but are read-only in this dashboard. The demo database is
browser-local, so these writes reset when the runtime restarts.

The data path is real: Foldkit commands require `DashboardApi` from an app-lifetime Effect layer;
its local implementation requires `Triples` and `ConfigStore`. The dashboard renderer contains no knowledge of
students, quizzes, or grading. Its only form knowledge is the explicit, versioned
renderer contract; interpreting a submission and executing an application command
remain host responsibilities. The standalone layer composes the fixture from
`src/demo/learning.ts`; a host can provide any other Triplex database layer without
changing the inspector.

## Open a real database

Build the dashboard and start its local Effect HTTP host with either a SQLite file or a PostgreSQL
connection URL:

```sh
pnpm dashboard:serve -- --sqlite /absolute/path/to/triplex.db
pnpm dashboard:serve -- --postgres postgresql://user:password@localhost:5432/database
```

Pass `--port 4180` to choose another port. The host prints the dashboard URL and binds to
`127.0.0.1`; it is an operator tool with mutation capabilities and is not an authenticated public
server. The browser uses the same Schema-decoded `DashboardApi` contract in demo and remote modes.
SQLite and PostgreSQL layers are created once for the server lifetime, and configuration is
composed over the same `Triples` transaction boundary.

The footer's temporal-basis control independently sets recorded time (what the database knew) and
valid time (when a fact was true). Recorded time can snap to the transaction instant selected by a
journal position. The selected basis
is applied to overview/entity reads, snapshot-stable entity pagination, and Datalog execution;
configuration and the causal journal remain current so operators can see the context around a
historical read.

## Source layout

- `src/model.ts` and `src/messages.ts` define serializable application state and messages.
- `src/commands.ts` is the Foldkit command boundary.
- `src/api.ts` defines local and HTTP-backed `DashboardApi` layers.
- `src/data.ts` translates Triplex services into presentation models.
- `src/main.ts` owns update and view composition.
- `src/server.ts` composes a real backend, API routes, and static assets.

Potential reusable Foldkit component work is captured as upstream-ready prompts in
[`../../docs/foldworks-component-prompts.md`](../../docs/foldworks-component-prompts.md).
