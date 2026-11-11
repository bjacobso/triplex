---
"@triplex-build/triplex": patch
---

Refresh the live-query coordinator clock after asynchronous journal reads so a temporal deadline that elapsed during a read wakes immediately instead of scheduling a stale relative sleep.
