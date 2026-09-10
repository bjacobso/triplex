---
"@triplex-build/triplex": patch
"@triplex-build/triplex-cli": patch
"@triplex-build/triplex-http": patch
---

Fix large in-memory KV range collection and all-`0xff` key increments, and make the CLI's pre-1.0
status explicit in help output. Preserve typed HTTP responses when synchronous request validation
rejects malformed temporal parameters or cursors.
