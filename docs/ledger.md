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

Lease-expiry overlap (week-8 hardening, the week-7 painter bug class — [painter.md](painter.md)): a slow LLM call can outlive its lease; the sweep reclaims the "dead" job and a second execution overlaps the first. Every handler with an `await` between its idempotency check and its commit append therefore re-checks the natural key **synchronously fused to the append** (no `await` between them — executions interleave only at await points in this single-process runtime): reflection, world-agent, world-cron (both classes), materialize, painter. The overlap costs one duplicate generation and a `warn`; never a duplicate event. Each handler has an interleaved-execution regression test (gated slow client, two executions of one job, exactly one event).

## File table

| File | What it does / talks to |
| --- | --- |
| `storage/repositories/ledger.ts` | Sole SQL site: `enqueue` (UNIQUE-key no-op), transactional `claimNext` (serial-group aware), `markCommitted/markRetry/markParked`, `sweepExpiredLeases`, `listActive` (scene-open blocking reads it). Rows validated on read; garbage is `CorruptStateError`. |
| `ledger/handlers/reflection.ts` | First real job handler: idempotent projection — if `reflection.committed` for (scene, character) exists it no-ops, so the post-kill lease retry is safe. FakeLLM-driven in tests/harness; LLM failure rethrows operational (runner retries, C7). Fault point `mid_reflection` right before the commit append. |
| `ledger/handlers/world-agent.ts` | Same shape for the per-world World Agent pass (`serial_group` = `world_agent:<world_id>`, one running per world); commits `world_agent.committed` once per scene. |
| `ledger/runner.ts` | The ONE catch site for job execution (C7): exhaustive `switch` on error kind → retry / park / fatal; emits job events atomically with the row change. `tick()` is pull-based so tests never sleep. |
| `ledger/scheduler.ts` | croner wrapper: computes next occurrence (UTC), writes a future-dated ledger row keyed `cron:<type>:<world>:<occurrence>` — idempotent across restarts. Also the pure fictional-calendar helpers the engine's WorldClock uses (`addMinutesIso`, `occurrencesBetween` — croner never reads the wall clock there). |
| `ledger/handlers/world-cron.ts` | Time-skip replay handlers (`world_cron.code` / `world_cron.llm`): idempotent per (cron_type, scheduled_for) via the committed event; code = pure projection, llm = FakeLLM/real narration; fault point `mid_cron` before the commit append. |
| `ledger/handlers/painter.ts` | Painter job handler — documented in [painter.md](painter.md). |
| `ledger/handlers/materialize.ts` | The materialize job (M4 part 2, Rev 4 §14): LLM invents ONLY the stub (name + description) — placement is code-owned (the square is in the payload, from the user's Explore click). Full B6 double gate: `validateAt('llm', 'materialize.stub', …)` over the parsed JSON (via `llm/structured.ts`), then engine-state gate (square still empty, world exists); the only durable write is one `sublocation.materialized`. Idempotent per square (deterministic `subloc:sq-<col>-<row>` id + occupancy check) — the post-kill lease retry converges. Fault point `mid_materialize` before the commit append. |
| `ledger/handlers/map-edit.ts` | The map_edit job (M5 part 2, Rev 4 §14 Flow A): the GM form — LLM invents ONLY name + description from the user's intent (delimiter-wrapped external text, B14); geometry (bounding box, mask, centroid) is code-owned via `editGeometry`. Full B6 double gate (schema gate on the form, engine-state gate: world exists, centroid on explored ground); the only durable write is one `sublocation.created` (actor = the requesting user; pin at the mask centroid, footprint = the drawn polygon), then the edit's painter job enqueues (key `painter:map:<world>:edit-<edit_id>`, deduped — the created-exists path re-enqueues to heal a kill in between). Fault point `mid_map_edit` + the fused lease-overlap re-check. |
| `ledger/handlers/map-click.ts` | The map_click job (M5 part 2, Rev 4 §14 Flow B steps 2–5): crops the CURRENT composite around the click (painter-owned `clickWindow`/`cropRegionPng`), the VLM classifies it with nearby DB labels as anchors (`classify_click`), the story LLM invents INSIDE the classification (`jump_in` kind), the invention's creation flag decides persist-or-discard. Two model outputs, each through the full B6 double gate (garbage classification/invention → rejected, zero rows, retry regenerates). The ONLY durable write is one `map_click.resolved`: outcome `created` IS the persistent spawn's sublocation row (registry-projected, pin at the click point); `transient` never becomes a sublocation. Fault point `mid_map_click` + the fused lease-overlap re-check. |
| `ledger/handlers/update-check.ts` | update_check job (startup + croner, FINAL item 12): fetch the release channel, `validateAt('update', …)`, announce a strictly-newer version as ONE `update.available` event (idempotent). Never downloads — see [update.md](update.md). |
| `ledger/handlers/update-apply.ts` | update_apply job (serial_group `update_apply`): re-fetch release, download artifact trio, verify SHA-256 + minisign, stage + pointer flip (B12), append `update.staged` once — kill -9 retries converge. Fault point `mid_update` inside stageUpdate. |
| `../migrations/0002_jobs.sql` | `ledger_jobs` table: states CHECK, idempotency UNIQUE, lease columns, `serial_group`, claim indexes. |

## Events consumed/emitted

Emits `job.failed`, `job.parked` (actor `system:ledger`); handlers emit `reflection.committed` (actor = the character), `world_agent.committed` (actor `system:world_agent`) and `sublocation.materialized` (actor `system:engine`). Consumes `turn.committed` (scene transcripts) and reads its own committed events for idempotency.

## Configuration

`WELTARI_LEASE_SECONDS` (default 60) — job lease length; the kill harness shortens it so a killed-mid-job lease expires within one cycle.

## Tests

- Invariants (I3): `ledger-idempotency`, `ledger-lease-expiry`, `ledger-dead-letter`, `ledger-per-world` — all on `FakeClock`, zero sleeps.
- Unit: runner C7 mapping (one error of each kind through stub jobs, plus untyped throw and missing handler), scheduler occurrence idempotency.
