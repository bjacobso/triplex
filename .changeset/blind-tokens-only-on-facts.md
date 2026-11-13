---
"@triplex-build/triplex": minor
---

Blind tokens of sealed values now live only on the fact and its blind index. Journal `:_tx/change`
payloads, transaction records and entity snapshots carry a sealed value's key ID and ciphertext without its
blind token, so erasure can remove a subject's tokens in one place. **Existing SQLite and PostgreSQL databases
must run SQL migration v11** (`runMigrations`, or the layers that migrate on start): it removes blind tokens
from stored journal payloads and drops entity snapshots that committed to one; `SnapshotWriter.backfill` and the
next write recreate them. Entity snapshot content IDs of entities with sealed values change. Frozen Cloudflare
and FoundationDB storage keeps any earlier copies.
