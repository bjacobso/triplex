---
"@triplex-build/triplex": minor
---

Make the Triples-backed `ConfigStore` read only what each operation needs. `resolveRef` and
`snapshotById` read the ref and the objects reachable from the snapshot, cache immutable records
by identity, and keep decoded trees until `:triplex/valid-under` changes; `commit`, `setRef` and
`reverseDependencies` no longer load the whole store. `ConfigStore.commit` no longer returns a
`store`: call `load()` for the whole store.
