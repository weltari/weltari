# protocol — @weltari/protocol (MIT edge package)

Purpose: the language-neutral wire contract between the engine and every client (built-in web app, V1.5 CLI, future external games — Brief §1). Zod v4 schemas are the single source; committed JSON Schemas are emitted for non-JS clients (Guide §0.1, B9).

## Contract

- Inputs: none (leaf package).
- Outputs: Zod schemas + inferred types + `PROTOCOL_VERSION`; `schemas/*.json` (generated — never hand-edit, Guide §8.4).
- Never: import from `apps/*` (license fence A12); contain vendored third-party source; use `.parse()` (B1 applies here too).

## File table

| File | What it does / talks to |
| --- | --- |
| `src/index.ts` | Public surface: re-exports + `PROTOCOL_VERSION` (handshake semver; major bump required for breaking changes, I7). |
| `src/events.ts` | Durable event union (`scene.started`, `scene.ended` — now with optional `end_type`/`divider_text` for the soft-close button set, `character.joined` — the scene-roster projection (0.7.0: emitted per participant at scene open; clients render the VN line-up from these), `turn.started`, `turn.committed` — now with optional `interrupted`, `sublocation.changed`, `sublocation.materialized` — the fog projection (0.8.0: explored = materialized; carries the LLM stub's name/description, the fog-grid square and the pin's world coordinates; `MAP_FOG_GRID` = 8 is the shared grid contract), `art.switched`, `reflection.committed`, `world_agent.committed`, `world.time_advanced`, `world_cron.completed`, `painter.completed`, `update.available` + `update.staged` — the self-update path (B12: available = untrusted notice; staged = verified + pointer flipped, restart to apply), `map_edit.requested` + `sublocation.created` — Flow A (0.9.0: durable lasso-edit intent with the drawn polygon + capped intent text, then the GM-formed sublocation with pin at the mask centroid and the polygon as its footprint), `map_click.resolved` — Flow B (0.9.0: `created` = the persistent spawn's row, pin at the click point; `transient` = the display-once discovery, never a sublocation), `job.failed`, `job.parked` — 0.9.0 adds optional `job_key` so clients tie failures back to their command (map-edit lock release)) — rows of the append-only event log, replayed via SSE `Last-Event-ID`. strictObject: own formats reject unknown keys (B5). |
| `src/stream.ts` | Ephemeral SSE frames (`hello` — protocol semver + log head + optional `app_version` (0.8.0), `stream` sentence) — display-only, never durable, never carry an SSE `id:` (B6). |
| `src/dev.ts` | Dev-channel frame union (`dev.gauges`, `dev.tool_call`, `dev.tool_rejected`) — the log-only trail for dev mode (UI Spec §2.8, Guide C11); ephemeral like `stream`, sent only to clients that opted in with `?dev=1`. `dev.tool_rejected` is the I8 trail subject: a B6-gate rejection lives only here, zero rows written. |
| `src/commands.ts` | POST command bodies + responses (`start-turn`, `interrupt-turn` — closes the envelope at the user's last-seen sentence, `end-scene`, `open-scene` — 0.8.0 adds optional `sublocation_id` to open the scene AT a known sublocation, `explore` — 0.8.0: one materialize job per fog square, idempotent, placement code-owned, `advance-time`, `paint-region`, `map-edit` — 0.9.0 Flow A: drawn polygon (world coordinates, 3–128 points) + intent (≤500 chars) + request_id, one idempotent `map_edit` ledger job, `map-click` — 0.9.0 Flow B: clicked point + request_id; the 202 answers `enter` (inside a radius/footprint — the named sublocation attached, nothing enqueued) or `classify` (one `map_click` job; the outcome arrives as map_click.resolved), `apply-update` — enqueue the verified-update staging job), user text capped at 8 KB (B7). |
| `src/plugins.ts` | `GET /v1/plugins` wire shapes: `PluginInfo` (name, version, provenance incl. content sha256, zero-build asset URLs) + `PluginList`; `MapJumpDetail` — the `wl-map-jump` DOM CustomEvent detail (map connector surface, §1.14: a map plugin requests a jump, the host answers with a masked scene transition). The durable `plugin.rejected` event lives in events.ts. |
| `scripts/emit.mjs` | Emits `schemas/*.json` via `z.toJSONSchema` (`npm run protocol:emit`); CI diffs the output against the committed copies. |
| `src/*.test.ts` | Valid + extra-key + boundary fixtures per schema (B5 test rule). |

## Events consumed/emitted

This package defines shapes only; emitters/consumers are listed per event in the doc-comments (builder.md §6).

## Wire conventions

- SSE frames: `event: event` + `id: <event-log seq>` + `data: <WeltariEvent JSON>` for durable events; `event: stream` / `event: hello` / `event: dev` with no `id:` for ephemeral frames (`dev` only when the client connected with `?dev=1`).
- Field names are snake_case on the wire (`world_id`, `actor_id`, `turn_id`).
