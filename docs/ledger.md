# ledger — apps/server/src/ledger + storage/repositories/ledger.ts

Purpose: the Job Ledger (Brief §2.2) — every piece of cold-path work is a durable row with an idempotency key, a lease, retries, and a dead-letter lane. Jobs are idempotent projections of the event log; startup *is* recovery.

## Contract

- Inputs: `enqueue()` calls (engine, scheduler); registered job handlers.
- Outputs: job state transitions; `job.failed` / `job.parked` events appended in the same WriteGate transaction as the row change.
- Single-writer authority: `storage/repositories/ledger.ts` is the only SQL site for `ledger_jobs`.
- Never: auto-retry a parked job; retry a `bug`-kind failure; put prompt content in `last_error` (C7/C12); do cron work inline (croner only writes rows).

## State machine

`pending` → (claim: attempts+1, lease) → `running` → `committed` | `failed` (operational, backoff `2^attempts`s cap 300, claimable again at `run_at`) | `parked` (dead-letter: max attempts exhausted, or any `bug`). `corrupt_state` touches no row and escalates to `onFatal` (crash-only, C5). Expired leases sweep back to `pending` on every poll and at startup — a kill -9 mid-job burns one attempt and gets retried.

Per-world serialization: rows carry `serial_group` (e.g. `world_agent:<world_id>`); the claim query skips a group that already has a running job (World Agent = 1 per world).

## File table

| File | What it does / talks to |
| --- | --- |
| `storage/repositories/ledger.ts` | Sole SQL site: `enqueue` (UNIQUE-key no-op), transactional `claimNext` (serial-group aware), `markCommitted/markRetry/markParked`, `sweepExpiredLeases`, `listActive` (scene-open blocking reads it). Rows validated on read; garbage is `CorruptStateError`. |
| `ledger/handlers/reflection.ts` | First real job handler: idempotent projection — if `reflection.committed` for (scene, character) exists it no-ops, so the post-kill lease retry is safe. FakeLLM-driven in tests/harness; LLM failure rethrows operational (runner retries, C7). Fault point `mid_reflection` right before the commit append. |
| `ledger/handlers/world-agent.ts` | Same shape for the per-world World Agent pass (`serial_group` = `world_agent:<world_id>`, one running per world); commits `world_agent.committed` once per scene. |
| `ledger/runner.ts` | The ONE catch site for job execution (C7): exhaustive `switch` on error kind → retry / park / fatal; emits job events atomically with the row change. `tick()` is pull-based so tests never sleep. |
| `ledger/scheduler.ts` | croner wrapper: computes next occurrence (UTC), writes a future-dated ledger row keyed `cron:<type>:<world>:<occurrence>` — idempotent across restarts. |
| `../migrations/0002_jobs.sql` | `ledger_jobs` table: states CHECK, idempotency UNIQUE, lease columns, `serial_group`, claim indexes. |

## Events consumed/emitted

Emits `job.failed`, `job.parked` (actor `system:ledger`); handlers emit `reflection.committed` (actor = the character) and `world_agent.committed` (actor `system:world_agent`). Consumes `turn.committed` (scene transcripts) and reads its own committed events for idempotency.

## Configuration

`WELTARI_LEASE_SECONDS` (default 60) — job lease length; the kill harness shortens it so a killed-mid-job lease expires within one cycle.

## Tests

- Invariants (I3): `ledger-idempotency`, `ledger-lease-expiry`, `ledger-dead-letter`, `ledger-per-world` — all on `FakeClock`, zero sleeps.
- Unit: runner C7 mapping (one error of each kind through stub jobs, plus untyped throw and missing handler), scheduler occurrence idempotency.
