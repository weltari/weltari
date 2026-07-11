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
| `db.ts` | Opens the connection (WAL, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`), probes FTS5 with a real CREATE before migrations (M7 part 1: a build without FTS5 fails loud with an actionable message — never a silent degrade), runs the hash-locked migration runner (`PRAGMA user_version` + `manifest.json` sha256 per file), exposes `transact()` (WriteGate) and the repositories, and re-projects the memory Search Index from the log at open. |
| `repositories/event-log.ts` | Sole write path into `events`: `append` / `readSince` / `lastId`. Rows are validated against `@weltari/protocol` on read — a failing row is `CorruptStateError`, never silently skipped (Guide C2). |
| `repositories/gateway.ts` | Sole write path into `gateway_inbound` (B7 exactly-once): `recordInbound` — UNIQUE(connector_id, external_msg_id) `ON CONFLICT DO NOTHING`, false = duplicate. |
| `repositories/user-profile.ts` | Sole SQL site for `user_profile` (M7 part 2, Rev 4 §9 Job 2/§4.3): the GM's profiling side store — DELIBERATELY NOT a projection of the event log (the one sanctioned mutable exception, like image pixels as files): profiling text is personal data that must be truly erasable (GDPR), so `deleteAll` physically removes rows no replay resurrects; events carry counts only. `append`/`list`/`count` + `hasContext` (the analysis job's idempotency re-check). Sole writers: the profile_analysis handler + the delete-profile command. Boot does NOT rebuild it — deletion survives restarts by construction. |
| `repositories/memory-index.ts` | The Search Index (M7 part 1, Rev 4 §4.2 — V1: SQLite FTS5, zero new deps; the interface is the fenced seam for a later embedding drop-in): BM25 search over memory deltas. A PROJECTION of `memory.delta_committed` events — `rebuild()` re-projects from the log at every boot; `add()` is called by the event-log append INSIDE the same transaction, so a committed delta is never unindexed. `search()` is participation-gated structurally (WHERE on the character column) and reduces LLM-written queries to quoted OR-tokens so hostile FTS5 syntax is inert. |
| `../migrations/0001_events.sql` | events table + `RAISE(ABORT)` triggers on UPDATE/DELETE (I1) + replay index. |
| `../migrations/0003_gateway.sql` | `gateway_inbound` dedup table (B7: messengers redeliver; the UNIQUE pair makes replay a no-op). |
| `../migrations/0004_memory_fts.sql` | `memory_delta_fts` FTS5 virtual table (content indexed; character_id/event_id UNINDEXED filter columns). Derived state — dropping it loses nothing; boot rebuilds. |
| `../migrations/0005_user_profile.sql` | `user_profile` mutable rows (actor_id, kind hypothesis\|engagement, body, context_id) + actor index — the GDPR-erasable side store above. |
| `../migrations/manifest.json` | `{file: sha256}` — append-only history lock; runner refuses tampered or unlisted files and numbering gaps. |

## Events consumed/emitted

None directly — repositories persist events; emitting on the SSE stream is `http/`'s job.

## Tests

- Unit (colocated): migration idempotency, tamper/unlisted/gap refusal, WriteGate rollback, id monotonicity, corrupt-row reads throw.
- Invariants: `tests/invariants/event-log-append-only.test.ts` (I1), `tests/invariants/repository-fence.test.ts` (I6 grep backstop).
