---
"@triplex-build/triplex": minor
---

Add entity-level write helpers to the ontology DSL. `EntityType.assert(id, values, options?)`
builds typed `assert` operations for a whole entity from alias-keyed values, with arrays for
cardinality-many uses. `Attribute.assertion` and the attribute handles now accept `validTo`, and
reject non-finite bounds or an empty `[validFrom, validTo)` interval. `GraphConstraint.pinned(release)`
returns the `configSnapshot` and `enforce` transaction metadata from one release. `Attribute.use`
now records a literal cardinality in its type, and `assert` is a reserved entity attribute alias.

Declare attribute uses concisely: attribute definitions now have `.required()`, `.many()`, and
`.unique()`, and `EntityType.make(name, fields)` accepts aliased fields directly, with a bare
definition as an optional single-valued use. **Breaking:** the wrapped
`EntityType.make(name, { attributes: fields })` declaration is removed; pass `fields` directly.
The compiled node content IDs are unchanged. `Type.where(entity, patterns)` and `Type.not(entity, patterns)` build Datalog
pattern and negation clauses by alias, with typed constants. `where` and `not` are now reserved
attribute aliases as well.

Publish several entity types with `EntityType.nodesOf(...types)`, which deduplicates shared
attribute nodes by content ID. Sensitive attribute modifiers preserve their sensitive node,
and query builders use the same blind-token equality as handwritten patterns under
`Sensitive.layer`. `GraphConstraint.pinned` memoizes enforcement per release root content ID.
Conditional `validFrom` and `validTo` values may explicitly be `undefined`.

Breaking type changes: `Attribute.Use` now carries literal cardinality (including changes to
inferred assignment compatibility), and `assert`, `where`, and `not` are reserved entity
attribute aliases. Attribute definitions now require the three modifier methods when
constructed structurally.
