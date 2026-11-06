---
"@triplex-build/triplex": minor
---

Accept `validTo` in `Attribute.AssertionOptions` and carry it on the emitted `Attribute.Assertion`,
so `handle.assertion(value, { validFrom, validTo })` produces a bounded valid interval. Previously
`validTo` was not part of the options type, and a non-literal options object silently dropped it.
A non-finite `validTo`, or one not later than `validFrom`, throws.
