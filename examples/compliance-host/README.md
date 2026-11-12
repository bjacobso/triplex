# Triplex compliance host

Run `pnpm example:compliance-host`. The self-verifying example also runs in `pnpm test`.

The host publishes the complete placement, evidence and requirement-occurrence schemas alongside
`Runner.schema`. A scoped runner delivers candidate diffs to handlers that use guarded
`Database.command` builders and stable per-batch command IDs. A read-only overlay previews evidence
reuse. Effect TestClock drives open → satisfied → reopened: training valid on `[120, 200)` closes
occurrence 1 at 150, and expiry opens occurrence 2 at 200 without another source command.

The runner owns journal catch-up, acknowledged snapshots, retries, checkpoints and temporal replay.
The application owns occurrence identity and the meaning of addition, removal and revision. A
production host assigns one runner owner per database and uses durable storage; in-memory KV does
not survive process loss. External integrations should append intents inside commands and use a
separate idempotent transport.
