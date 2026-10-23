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
definition as an optional single-valued use. The `{ attributes }` form still works and compiles to
identical nodes. `Type.where(entity, patterns)` and `Type.not(entity, patterns)` build Datalog
pattern and negation clauses by alias, with typed constants. `where` and `not` are now reserved
attribute aliases as well.
