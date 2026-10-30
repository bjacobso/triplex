---
"@triplex-build/triplex": patch
---

Make KV transactions write their assertions in one batch. The in-memory backend buffers them by
latin1 string key without a per-entry `Effect`, merges new keys into its sorted index instead of
re-sorting after every commit, and encodes ASCII keys without per-character concatenation.
`KvTransaction` gains optional `setAll` and `setAllStr` members.
