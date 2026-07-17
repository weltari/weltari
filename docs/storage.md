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
| `db.ts` | Opens the connection (WAL, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`), probes FTS5 with a real CREATE before migrations (M7 part 1: a build without FTS5 fails loud with an actionable message — never a silent degrade), runs the hash-locked migration runner (`PRAGMA user_version` + `manifest.json` sha256 per file), exposes `transact()` (WriteGate) and the repositories, and re-projects the memory Search Index, the objects table and the markers table from the log at open. |
| `repositories/event-log.ts` | Sole write path into `events`: `append` / `readSince` / `lastId`. Rows are validated against `@weltari/protocol` on read — a failing row is `CorruptStateError`, never silently skipped (Guide C2). |
| `repositories/gateway.ts` | Sole write path into `gateway_inbound` (B7 exactly-once): `recordInbound` — UNIQUE(connector_id, external_msg_id) `ON CONFLICT DO NOTHING`, false = duplicate. |
| `repositories/user-profile.ts` | Sole SQL site for `user_profile` (M7 part 2, Rev 4 §9 Job 2/§4.3): the GM's profiling side store — DELIBERATELY NOT a projection of the event log (the one sanctioned mutable exception, like image pixels as files): profiling text is personal data that must be truly erasable (GDPR), so `deleteAll` physically removes rows no replay resurrects; events carry counts only. `append`/`list`/`count` + `hasContext` (the analysis job's idempotency re-check). Sole writers: the profile_analysis handler + the delete-profile command. Boot does NOT rebuild it — deletion survives restarts by construction. |
| `repositories/memory-index.ts` | The Search Index (M7 part 1, Rev 4 §4.2 — V1: SQLite FTS5, zero new deps; the interface is the fenced seam for a later embedding drop-in): BM25 search over memory deltas. A PROJECTION of `memory.delta_committed` events — `rebuild()` re-projects from the log at every boot; `add()` is called by the event-log append INSIDE the same transaction, so a committed delta is never unindexed. `search()` is participation-gated structurally (WHERE on the character column) and reduces LLM-written queries to quoted OR-tokens so hostile FTS5 syntax is inert. |
| `repositories/objects.ts` | Sole SQL site for `objects` (M7 part 3, Rev 4 §7): durable items, materialize-on-touch. A PROJECTION of the `object.*` event family — `apply()` is called by the event-log append INSIDE the same transaction (a kill can never commit an object event without its row); `rebuild()` re-projects from the log at every boot; `object.swept` deletes the row while the tombstone event keeps the log append-only (I1). V1 holders are sublocations only (owner ruling 2026-07-16: backpacks are V2), so every row is public. Reads: `byId` / `heldAt` (the explore listing, creation order) / `resolveName` (Rev 4 §7 reachable-holder resolution — normalized via the exported `objectNameKey`, ambiguous names return all matches) / `strayCandidates` (GC pre-filter: payload-less, scene-created, never touched outside the creating scene). Dedup by (world, holder, name_key) is a UNIQUE index — the engine gates resolve matches before any append, so a collision here is corruption. |
| `repositories/markers.ts` | Sole SQL site for `markers` (M7 part 4, Rev 4 §14/§17): chance-encounter markers as lazy intents. A PROJECTION of the `marker.*` event family — `apply()` is called by the event-log append INSIDE the same transaction; `rebuild()` re-projects from the log at every boot. Unlike objects, terminal rows STAY: `state` walks dropped → instantiated \| expired guarded IN SQL (`WHERE state = 'dropped'` — a transition on a settled row is corruption, the engine's fused re-check makes it unreachable); an instantiated row answers the join race with its one scene, an expired row is the audit trail. Reads: `byId` / `live` (state 'dropped', oldest drop first — the 1–5 invariant, the sweep and the pins all read this). |
| `../migrations/0001_events.sql` | events table + `RAISE(ABORT)` triggers on UPDATE/DELETE (I1) + replay index. |
| `../migrations/0003_gateway.sql` | `gateway_inbound` dedup table (B7: messengers redeliver; the UNIQUE pair makes replay a no-op). |
| `../migrations/0004_memory_fts.sql` | `memory_delta_fts` FTS5 virtual table (content indexed; character_id/event_id UNINDEXED filter columns). Derived state — dropping it loses nothing; boot rebuilds. |
| `../migrations/0005_user_profile.sql` | `user_profile` mutable rows (actor_id, kind hypothesis\|engagement, body, context_id) + actor index — the GDPR-erasable side store above. |
| `../migrations/0006_objects.sql` | `objects` projection table (name + normalized name_key, holder_sublocation_id, prose payload, creation/touch provenance, `version` for optimistic concurrency) + holder index + the (world, holder, name_key) UNIQUE dedup index. Derived state — dropping it loses nothing; boot rebuilds. |
| `../migrations/0007_markers.sql` | `markers` projection table (kind, sublocation, JSON cast, premise seed, game-time drop/TTL/expiry stamps, drop source + proposing scene, `state` + instantiated scene, `version` for the first-click-wins race) + (world, state) index. Derived state — dropping it loses nothing; boot rebuilds. |
| `../migrations/manifest.json` | `{file: sha256}` — append-only history lock; runner refuses tampered or unlisted files and numbering gaps. |

## Events consumed/emitted

None directly — repositories persist events; emitting on the SSE stream is `http/`'s job.

## Tests

- Unit (colocated): migration idempotency, tamper/unlisted/gap refusal, WriteGate rollback, id monotonicity, corrupt-row reads throw.
- Invariants: `tests/invariants/event-log-append-only.test.ts` (I1), `tests/invariants/repository-fence.test.ts` (I6 grep backstop).
