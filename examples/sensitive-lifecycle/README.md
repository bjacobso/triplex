# Sensitive lifecycle

The whole life of a sensitive value on a SQLite file, with the reference key store
(`SqlKeyStore`) and a host-supplied root key:

1. Seal a national identifier and a passport number (key class `retention-1y`).
2. Restart, open them and find the person by value.
3. Rotate the data keys (`KeyCustody.rotate`, `Sensitive.rewrap`, `KeyCustody.retire`) and the
   blind key (`Sensitive.rotateBlindKey`).
4. Rotate the root key (`SqlKeyStore.rewrapRoot`), then drop the old one.
5. Erase the person (`Sensitive.erase`).
6. Restart: opening fails with `key-destroyed`, equality no longer matches, and the journal records
   who erased whom.

```sh
pnpm --filter triplex-sensitive-lifecycle start
pnpm --filter triplex-sensitive-lifecycle test   # the same run, with checks
```

The example generates its root keys in memory. A real host reads them from a secret manager and
never stores them beside the database. See [Sensitive values](../../docs/sensitive-values.md).
