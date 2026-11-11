---
"@triplex-build/triplex": minor
---

Add Database.preview(meta, build, options?) to inspect compiled operations and guards,
assertion/retraction descriptions, newly introduced graph violations, optional derivation
candidate diffs, and existing command receipts without committing. Sensitive values remain
sealed. Preview and command share their builder compiler. No breaking changes.
