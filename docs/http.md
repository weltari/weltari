# http — apps/server/src/http (+ main.ts composition root)

Purpose: the engine's one public face (Brief §1): a server-pushed SSE event stream plus schema-validated POST commands. The frontend is just another client of this — as is `curl`, the V1.5 CLI, and future external games.

## Contract

- Inputs: HTTP requests; durable events via `EventBus`; display-only sentences via `StreamBus`.
- Outputs: SSE frames (`hello`, `event` with `id:` = log seq, `stream` without id); command replies (202/400/409).
- Never: hold game logic (render-only clients, Brief §2.5); push an event before its row is durable; give ephemeral frames an SSE id (B6).

## File table

| File | What it does / talks to |
| --- | --- |
| `bus.ts` | Generic in-process `Bus<T>`; `EventBus` (durable) + `StreamBus` (ephemeral) + `DevBus` (log-only trail, Guide C11). Listener throws are contained per-socket. |
| `sse.ts` | `attachSseClient`: hello frame → subscribe-then-replay with a shared cursor (exactly-once, no gap: replay is synchronous) → live tail + heartbeat comments. `Last-Event-ID` header or `?last_event_id=` query. Dev-channel frames (`event: dev`, no id) reach only clients that connected with `?dev=1`. |
| `server.ts` | Fastify 5 instance; `fastify-type-provider-zod` validator+serializer set once (B9); `GET /v1/events`; `POST /v1/commands/start-turn` → injected `startTurn` seam (202 / 409); `POST /v1/commands/end-scene` (202 + jobs_enqueued / 409) and `POST /v1/commands/open-scene` (202 / 409 `blocked_on_pending_jobs`) → scene-lifecycle seams. |
| `../engine/event-sink.ts` | `append` = repository write then bus publish, in that order (crash-only: durable before visible). |
| `../main.ts` | Composition root: env → logger → C6 process handlers (the only two) → storage → fixture-world seed → runner loop → HTTP listen. SIGTERM/SIGINT drain is an optimization only. Contains the placeholder canned turn until the LLM scripted turn lands. |

## Events consumed/emitted

Emits nothing itself; transports everything. The placeholder `startTurn` in main.ts emits `turn.started` / `turn.committed` (replaced by the scene engine).

## Verified by

Unit tests: hello head, exactly-once replay, live push, query fallback, 400-on-extra-key with zero appends, 202 + stream ordering (`hello, event, stream, event`). Smoke-verified with `curl -N` including `Last-Event-ID` resume.
