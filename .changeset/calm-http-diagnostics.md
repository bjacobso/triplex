---
"@triplex-build/triplex-cli": minor
"@triplex-build/triplex-http": minor
---

Replace CLI and HTTP failure bodies with stable core Diagnostic envelopes.

CLI failures now emit { ok: false, command, error: Diagnostic } to stderr and exit
nonzero, including argument and input failures with cli.\* codes. Original causes
are available only with --debug.

HTTP failures now emit { error: Diagnostic }, retain existing statuses, and send
Retry-After: 0 for retryable conflicts. HTTP-owned error class code literals
change to http.\* codes. OpenAPI describes the diagnostic envelope. Consumers must
update old top-level code/message body parsing and HTTP error constructors.
