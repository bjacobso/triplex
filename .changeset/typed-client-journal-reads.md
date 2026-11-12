---
"@triplex-build/triplex": minor
---

Add Database receipt lookup, paged entity transaction history with alias-discriminated typed changes, and read-only inbox/outbox access with deterministic entry IDs. Receipt and history reads honor the recorded cut of asOf views; operational mailbox reads remain live-only. Sealed journal values remain sealed.
