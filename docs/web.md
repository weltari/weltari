# web — apps/web (React 19 + Vite 8 client)

Purpose: the bare Week-1 client: renders the server-pushed stream and posts commands. Render-only by constitution (Brief §2.5) — zero game logic, no polling; on reconnect `EventSource` resumes with `Last-Event-ID` natively.

## Contract

- Inputs: SSE frames (`hello`/`stream`/`event`), all safeParse-checked against `@weltari/protocol` before touching state.
- Outputs: `POST /v1/commands/start-turn`.
- Never: import anything from `apps/server` (fence A13 — the frontend is just another client); trust an unvalidated frame; invent state the stream didn't push.

## File table

| File | What it does / talks to |
| --- | --- |
| `index.html` / `src/main.tsx` | Vite entry; StrictMode root. |
| `src/App.tsx` | One page: streamed sentences render dimmed (display-only, B6); `turn.committed` replaces them as the authoritative transcript; input box posts the next turn. |
| `vite.config.mjs` | Dev proxy `/v1` → `127.0.0.1:7777`; the built app is later served by Fastify itself (FINAL item 2). |
| `tsconfig.json` | Extends the same strict base; only the sanctioned web variations (jsx, DOM libs, bundler resolution, noEmit — Guide A14). |

## Deviations recorded

- zustand (FINAL item 5) is deferred: the Week-1 kickoff asks for a "bare React page"; the SSE-reducer-owns-stores pattern arrives with the real Scene page (M3).
- Frontend is excluded from coverage gates (Guide E3); no web tests this week.
