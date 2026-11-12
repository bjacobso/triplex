---
"@triplex-build/triplex": minor
---

Read the selected database release in `describe`, defaulting to `live` with a `--ref` override.
Retain the command manifest and add schema, constraints, config objects, write rules, and attributed,
release-pinned transaction examples with enforcement. Missing releases return a publishing hint.

Behavior change: `describe` now opens the selected database and can apply its pending migrations,
like other data commands; it requires a working database connection.
