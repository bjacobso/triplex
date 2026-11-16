# Triplex explorer

A React table explorer for a Triplex SQLite database. Rows are entities, columns are the live
release's attributes, and every cell is the set of facts visible at a temporal basis. Hover a
cell for its valid and recorded intervals and the transaction that wrote it; click it to inspect
its full value history, receipt, `Why` causation chain and the attribute's declaration. Editing
happens in a record sheet that commits one attributed transaction, pinned to the live release
and enforced against its constraints. Its parts follow Forma's reading editor: a root that owns
state, and tabs, toolbar, breadcrumbs, hover card, inspector, references, quick open and a
status line that read it through `useExplorer()`.

```sh
pnpm --filter @triplex-build/triplex-explorer seed -- --sqlite ./explorer.db --fresh
pnpm explorer -- --sqlite ./explorer.db
```

Open <http://localhost:4176>. Pass `--read-only` to open the file without writing, and
`--port` to choose another port. `pnpm --filter @triplex-build/triplex-explorer activity -- --sqlite ./explorer.db`
commits small changes every 20 seconds so the live view has something to follow.

## Playground

`/playground/share/` runs the same explorer over an in-memory Triplex database built in the page, with
no host. A playground is a JSON bundle of entity types, seed commands and saved Datalog queries
(`src/playground/bundle.ts`). The page publishes the types as the live release, applies each seed
command as one attributed transaction enforced against it, and runs saved queries at the
explorer's temporal basis. **Copy share link** puts the deflated bundle in the URL hash, so a link
needs no storage and opening it gives the reader their own copy. Edits made in the table stay in
that tab.

```sh
pnpm --filter @triplex-build/triplex-explorer dev   # then open /playground/share/
```

The Alchemy `Docs` Worker serves it at `triplex.build/playground/share/`, beside the guided docs page at `/playground`:
`pnpm playground:build` writes it into the documentation output after `pnpm docs:build`. Sharing is link-only for now; stored,
immutable snapshots like Forma's playground are the planned next step.

## Reads

- Unsorted tables page with `Triples.entityPage` (exact type, by ID, one commit cut).
- Sorted or filtered tables page with `Triples.queryPage` joins over the type's own required
  attribute and the sorted and filtered attributes. Entities without the sorted value follow in a
  second pass with `not`, so blanks sort last. Joins are used instead of `optionalProjection`,
  which SQLite evaluates as per-row subqueries and is seconds slower on a few thousand rows.
- Live mode follows the ordered journal (also other processes' commits), rereads only tables a
  commit touched, flashes the cells whose facts changed, and wakes at the next valid-time
  boundary. Pinning a recorded position freezes every table at that commit.

## Security

The host binds to `127.0.0.1` and answers API requests only from its own loopback origin, plus
each exact `--allow-origin <https origin>`, such as an authenticated proxy in front of it. The
live stream is a POST, so it keeps the same Origin check.

## Known limit

Commit-time constraint enforcement in core grows roughly with the square of a type's facts:
one enforced edit takes about 10 s with 50 workers and 30 s with 100. The seed and activity
scripts therefore pin the release without enforcing it; their data is valid by construction.
Record-sheet edits enforce the release and are slow on large types until core is fixed.
