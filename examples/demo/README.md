# Triplex demo

This demo uses the self-contained in-memory backend to write linked entities, read
raw triples, filter with Datalog, and traverse a relationship with a Datalog join.

From the repository root:

```sh
pnpm exec tsx --tsconfig docs/snippets/tsconfig.json examples/demo/demo.ts
```

The same program can use SQLite or a candidate/experimental backend by replacing
`KvTriples.layer` with one of the layers documented in the root README's support matrix.
