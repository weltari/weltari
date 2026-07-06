# storage — apps/server/src/storage (the only SQLite site)

Purpose: one WAL SQLite file behind hand-written repositories; the import fence (Guide A11) plus Invariant I6 make this the only directory that can touch the database. Everything durable in Weltari commits through here.

## Contract

- Inputs: repository calls from engine/http/ledger code; numbered `.sql` migrations.
- Outputs: repository interfaces (`EventLogRepository`, …); `transact()` — the WriteGate.
- Single-writer authority: this module owns every table's write path; the `events` table additionally has database-level append-only triggers.
- Never: export the raw db handle; UPDATE/DELETE on `events` (forbidden action §8.8); edit a shipped migration (hash-locked manifest refuses to boot).

## File table

| File | What it does / talks to |
| --- | --- |
| `db.ts` | Opens the connection (WAL, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`), runs the hash-locked migration runner (`PRAGMA user_version` + `manifest.json` sha256 per file), exposes `transact()` (WriteGate) and the repositories. |
| `repositories/event-log.ts` | Sole write path into `events`: `append` / `readSince` / `lastId`. Rows are validated against `@weltari/protocol` on read — a failing row is `CorruptStateError`, never silently skipped (Guide C2). |
| `repositories/gateway.ts` | Sole write path into `gateway_inbound` (B7 exactly-once): `recordInbound` — UNIQUE(connector_id, external_msg_id) `ON CONFLICT DO NOTHING`, false = duplicate. |
| `../migrations/0001_events.sql` | events table + `RAISE(ABORT)` triggers on UPDATE/DELETE (I1) + replay index. |
| `../migrations/0003_gateway.sql` | `gateway_inbound` dedup table (B7: messengers redeliver; the UNIQUE pair makes replay a no-op). |
| `../migrations/manifest.json` | `{file: sha256}` — append-only history lock; runner refuses tampered or unlisted files and numbering gaps. |

## Events consumed/emitted

None directly — repositories persist events; emitting on the SSE stream is `http/`'s job.

## Tests

- Unit (colocated): migration idempotency, tamper/unlisted/gap refusal, WriteGate rollback, id monotonicity, corrupt-row reads throw.
- Invariants: `tests/invariants/event-log-append-only.test.ts` (I1), `tests/invariants/repository-fence.test.ts` (I6 grep backstop).
