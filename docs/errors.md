---
description: Stable diagnostic codes, recovery hints, paths, and retry rules for public Triplex errors.
---

# Error diagnostics

Import `diagnose` and the `Diagnostic` type from `@triplex-build/triplex`. Pass the
actual error from an Effect failure to `diagnose(error)`; it returns a JSON-serializable
object containing `code`, `message`, `retryable`, and optional `path`, `fix`, and `details`.
Branch on the stable code rather than parsing the message. Messages and fixes can gain detail.

`path` identifies the input location when the error provides one, such as `where[2] alternative 1`,
`find`, or `match.attribute`. `$` means the whole query. Errors without a known location omit it;
sensitive errors do not infer a location by inspecting values or causes.

Only transaction conflicts are retryable: reload current facts and retry the **whole command**.
Repeating a conflicting command unchanged without reloading its preconditions will still fail.
A duplicate command ID is a receipt lookup, not a retry.

Diagnostics preserve the error message and allowlist structured details. They never copy raw
queries, predicate operands, SQL, causes, sealed envelopes, or constraint value identities into
`details`. Constraint details contain `violations`, an array of `{ constraintKey, subject, validAt }`.
`validAt` is an epoch-millisecond instant. The diagnostic path names the first violation; the array
includes them all. See the [valid-time modeling rule](/agents#_3-write-each-command-as-one-transaction): all of
an entity's facts should share one interval so required facts remain present at every boundary.

## Code reference

The table covers every class exported by the core error module and the more specific Datalog
validation and transaction conflict codes. Fixes below describe the default recovery action;
individual diagnostics can supply a more specific hint or suggested attribute spelling.

| Code                                    | Meaning                                                          | Suggested fix                                                                                       | Retryable |
| --------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------- |
| `write.failed`                          | A storage write failed.                                          | Check the write input and storage availability.                                                     | No        |
| `operational.entry-conflict`            | An inbox or outbox idempotency key is already claimed.           | Read the existing inbox or outbox entry for this idempotency key.                                   | No        |
| `triple.duplicate`                      | The fact already exists.                                         | Read the existing fact before asserting it again.                                                   | No        |
| `triple.invalid`                        | A fact field is invalid.                                         | Correct the named field and submit the fact again.                                                  | No        |
| `transaction.failed`                    | A transaction failed outside a recognized concurrency conflict.  | Inspect the transaction input and storage availability before resubmitting.                         | No        |
| `transaction.conflict.precondition`     | Observed facts no longer match the transaction preconditions.    | Reload current facts and retry the whole command.                                                   | Yes       |
| `transaction.command-already-committed` | This command ID already has a committed receipt.                 | Read the original receipt with `transactionByCommand`.                                              | No        |
| `constraint.violation`                  | The proposed post-state introduces or worsens graph constraints. | Correct the violated constraints and ensure all of an entity's facts share one valid-time interval. | No        |
| `read.failed`                           | A storage read failed.                                           | Check the read input and storage availability.                                                      | No        |
| `entity.not-found`                      | The requested entity does not exist at this basis.               | Check the entity ID and temporal basis.                                                             | No        |
| `triple.not-found`                      | The requested fact does not exist.                               | Reload the entity and use a current fact ID.                                                        | No        |
| `query.failed`                          | Query execution failed.                                          | Check the query and storage availability.                                                           | No        |
| `query.invalid-pattern`                 | A triple match pattern is invalid.                               | Supply a valid triple match pattern.                                                                | No        |
| `datalog.parse`                         | The query text could not be parsed.                              | Correct the query syntax at the reported line and column.                                           | No        |
| `datalog.unexpected-token`              | The parser encountered an unexpected token.                      | Replace the unexpected token with the expected token.                                               | No        |
| `datalog.undefined-variable`            | The parser encountered an undefined variable.                    | Define the variable before referencing it.                                                          | No        |
| `validation.failed`                     | An input field failed validation.                                | Correct the named input field.                                                                      | No        |
| `schema.unknown-attribute`              | An attribute is absent from the bound release.                   | Use an attribute defined in the bound release.                                                      | No        |
| `datalog.failed`                        | A Datalog operation failed.                                      | Correct the Datalog query before submitting it again.                                               | No        |
| `datalog.unbound-variable`              | A variable lacks a positive relation binding.                    | Bind the variable in a positive pattern or rule application before using it.                        | No        |
| `datalog.invalid-predicate`             | Predicate operands or their types are invalid.                   | Use a supported predicate with bound operands and numeric ordered comparisons.                      | No        |
| `datalog.invalid-shape`                 | The query does not match the Datalog or wrapper schema.          | Supply a query matching the Datalog query schema.                                                   | No        |
| `sensitive.query`                       | The operation requires unsupported access to a sealed value.     | Use blind-index equality for sensitive values and open them explicitly with Sensitive.open.         | No        |
| `sensitive.value`                       | A sensitive value or codec operation failed.                     | Check the sensitive attribute policy and codec key availability.                                    | No        |
| `pagination.invalid-cursor`             | The cursor is invalid or belongs to a different query or basis.  | Restart pagination without a cursor using the intended query and database.                          | No        |
| `migration.failed`                      | A database migration failed.                                     | Inspect the failed migration and repair its prerequisites before rerunning it.                      | No        |
| `database.not-found`                    | The requested database does not exist.                           | Use an existing database name or create the database first.                                         | No        |
| `database.already-exists`               | The requested database name is already in use.                   | Use the existing database or choose a different name.                                               | No        |
| `database.internal`                     | A database-manager internal operation failed.                    | Inspect the database logs and resolve the underlying failure.                                       | No        |
| `transaction.conflict.serialization`    | The database lost a serialization race.                          | Reload current facts and retry the whole command.                                                   | Yes       |
| `transaction.conflict.deadlock`         | The database aborted a deadlock participant.                     | Reload current facts and retry the whole command.                                                   | Yes       |
| `datalog.and-clause`                    | An unsupported `and` clause groups conditions.                   | Put conjunctive clauses directly in `where` or in `not`.                                            | No        |
| `datalog.not-with-and`                  | A negation contains an `and` wrapper.                            | Write `["not", clause1, clause2, ...]`.                                                             | No        |
| `datalog.or-branch-not-single-clause`   | An `or` alternative contains multiple conjunctive clauses.       | Use a conjunctive `not` alternative or run one query per alternative.                               | No        |
| `datalog.invalid-query`                 | A query uses an unsupported relation, rule or wrapper form.      | Use a positive relation and supported rule and wrapper forms.                                       | No        |
| `datalog.invalid-aggregate`             | Aggregate targets or `having` are invalid.                       | Use unique aggregate targets in `find` and valid aggregate predicates.                              | No        |
| `datalog.invalid-projection`            | Projection variables or optional targets conflict.               | Project each bound variable once and use unique optional targets in `find`.                         | No        |
| `internal`                              | The input is not a recognized Triplex error.                     | Inspect the original failure in the calling application.                                            | No        |
