# data-model — the SQLite schema as a document (builder.md §4)

How agents understand the database **without ever opening it**: read this page,
the commented migrations ([apps/server/migrations/](../apps/server/migrations/)),
and the repository modules — every table has exactly ONE code module that
touches it (Brief §2.7, fence A11: `storage/db.ts` is the only connection
site, `storage/repositories/*` the only SQL). To look at real rows, load the
seeded example world: `node fixtures/load-example-world.mjs`
([fixtures/README.md](../fixtures/README.md)).

Migrations are plain ordered SQL (`0001_…` …), hash-locked by
`migrations/manifest.json` — a shipped migration is never edited (Guide §8.3);
schema change = a new numbered file + manifest entry in the same commit.

## `events` — the append-only event log (migration 0001)

- **Entity:** the event log (Brief §2.1; Rev 4 §17 "events"). The single
  source of truth — everything else in the system is a rebuildable projection
  of this table.
- **Sole writer:** `storage/repositories/event-log.ts` (`append` only).
  UPDATE/DELETE are refused **by SQLite triggers**, not convention
  (Invariant I1).
- **Shape notes:** `id` is the monotonic rowid and doubles as the SSE
  `Last-Event-ID`; `type`/`payload` are the closed union in
  `@weltari/protocol` `events.ts` (validated on read with `safeParse` — a row
  that stops parsing is surfaced, never silently skipped); `ts` is wall-clock
  append time — **fictional time lives in payloads** (`world.time_advanced`),
  never here; every row carries `actor_id` (Brief §2.8).
- **Projections (who rebuilds what from it):** the web client store (scene,
  roster, transcript, world clock + cron replay progress, update surface) via
  SSE replay; the engine's scene state (participants, open/ended checks,
  current sublocation); the sublocation registry (fixture trio ∪
  `sublocation.materialized` — the map's fog grid and every sublocation
  gate are projections of it); the WorldClock (`currentTime` = latest
  `world.time_advanced.to`); the update path's already-announced /
  already-staged idempotency checks; `tools/verify-consistency.mjs` (the
  offline auditor).

## `ledger_jobs` — the job ledger (migration 0002)

- **Entity:** `ledger_job` (Rev 4 §3/§4.2; Brief §2.2). Durable cold-path
  work: reflections, World-Agent passes, world-cron occurrences, painter
  composites, update check/apply.
- **Sole writer:** `storage/repositories/ledger.ts` (enqueue/claim/complete/
  fail/park/sweep). The runner (`ledger/runner.ts`) is the only claimant.
- **Shape notes:** `idempotency_key` UNIQUE makes duplicate enqueues silent
  no-ops (I3) — keys are natural (`reflection:<char>:<scene>`,
  `wcron:<type>:<world>:<scheduled_for>`, `update_apply:<version>`,
  `materialize:<world>:<col>:<row>` — one reveal per fog square, ever);
  `state ∈ pending/running/committed/failed/parked` (parked = dead-letter,
  never auto-retried); `lease_until` expiry + sweep makes a crash mid-job
  claimable again — attempts count crashes because they increment at claim
  time; `serial_group` serializes (at most one running per group, e.g.
  `world_agent:<world_id>`); `last_error` holds truncated
  `{kind, code, message}` JSON, never prompt content (C7).
- **Projections:** jobs are idempotent projections OF the event log; their
  outcomes append events back to it (`reflection.committed`,
  `world_cron.completed`, `painter.completed`, `update.staged`, `job.failed`,
  `job.parked`). No rollback anywhere — saga-style forward recovery.

## `gateway_inbound` — exactly-once messenger ingestion (migration 0003)

- **Entity:** the gateway ingestion ledger (Brief §7c / B7).
- **Sole writer:** `storage/repositories/gateway.ts`.
- **Shape notes:** `UNIQUE (connector_id, external_msg_id)` makes messenger
  redeliveries and replay attacks silent no-ops — one update can never open
  two turns; `text` is already capped at 8 KB by the connector host (B7).
- **Projections:** none — it is a dedup fence, not state; the resulting turn
  lives in `events` like any other.

## What is deliberately NOT in the database

- **Image pixels** — files under `WELTARI_IMAGES_DIR`; the `painter.completed`
  event (path + sha256) is the truth about which file is current (Brief §1).
- **Update artifacts** — version dirs + the `current` pointer under
  `WELTARI_VERSIONS_DIR` (B12); `update.staged` events record the flips.
- **Secrets** — env vars only, read once in `boundary/config/env.ts` (B15).
