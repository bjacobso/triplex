---
"@triplex-build/triplex": patch
---

Name the first two violations in `ConstraintViolationError.message` with their constraint key,
subject, and valid-time instant, instead of only a count, and add `Constraint.describeViolations`.
Document that enforced graph constraints hold at every valid-time edge of an entity.
