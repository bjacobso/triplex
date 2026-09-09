## Summary

Describe the behavior changed and why.

## Verification

- [ ] `pnpm check`
- [ ] `pnpm pack:check`
- [ ] Relevant opt-in PostgreSQL, FoundationDB, or stress tests (when targeted)

## Architecture and release

- [ ] The one-way package graph in `ARCHITECTURE.md` is preserved.
- [ ] External dependency versions are pinned in the root pnpm catalog.
- [ ] Public exports resolve only to built files in `dist`.
- [ ] User-visible package changes include a Changeset when appropriate.
