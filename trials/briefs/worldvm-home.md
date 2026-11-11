# WorldVM subject homes

Build a synthetic reconciliation model with one PostgreSQL database per world and one home entity
per subject. The production shape targets 100,000 subjects and 16 concurrent runners; this trial
uses a small deterministic fixture, not a scale certification. Use synthetic identifiers, values
and keys only. Never read or modify a WorldVM checkout.

Each home command must commit its fact changes, a queryable command receipt and outgoing intents
in one serializable transaction. A failed command must leave none of those effects behind. Retrying
an already committed command must not apply its changes or create outgoing intents twice. An
intent is durable work to deliver later; successful commit must not be confused with successful
external delivery. Keep application dispatch and authorization responsibilities explicit.

Replay must reconstruct a subject's home at an exact earlier commit position, excluding later
commits even if their wall-clock timestamps coincide. Include at least two subjects, two commands
on one home, a failed command and a retried command. Sensitive values are sealed by the host with
keys scoped per vault and retention class; demonstrate what public APIs support and report gaps
rather than inventing unsupported sealing or key-domain guarantees.

Tests must answer:

1. Does each subject have its own home, and do reads and commands stay inside the selected world
   and home? Can two worlds use the same subject identifier without leaking facts?
2. After success, can facts, receipt and outgoing intents be retrieved together and attributed
   to the command? After forced failure, are all three absent?
3. What happens on duplicate command submission and competing runners? Is there one committed
   effect and one set of intents, with retry behavior and any rejected attempts observable?
4. At a saved earlier commit position, does replay return exactly the earlier home after later
   updates and corrections? Does the cut remain exact for same-millisecond commits?
5. Are sensitive plaintext values absent from persisted facts, journal and ordinary query output?
   Can the authorized host open them, and what happens with another vault or retention-class key?
6. Can a worker discover committed outgoing intents after restarting, without claiming an external
   side effect was delivered exactly once? Which guarantees belong to the host?

Run portable parts on KV and SQLite. Record PostgreSQL serializable/ambient transaction coverage
separately when a service is available; otherwise mark those requirements untested. Clearly report
any public-surface limitation instead of substituting timestamp replay or separate commits.
