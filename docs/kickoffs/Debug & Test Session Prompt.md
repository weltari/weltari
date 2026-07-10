# Debug / Test Session — exercise Weltari and fix what you find (paste this to start the session)

You are testing and debugging Weltari in this repository (`D:\devproj\weltari`, remote `https://github.com/weltari/weltari`). Do NOT build new features this session — your job is to break what exists, then fix genuine defects with small, gated commits. I am not a professional developer — explain findings plainly, with what you saw, why it's wrong, and what you changed.

## Read first

`CLAUDE.md` → `docs/Coding Guide/Task Completion Checklist.md` → `docs/week3-results.md` (current state + known quirks) → the module page (`docs/INDEX.md`) of anything you touch.

## How to run everything

| What | Command | Expect |
| --- | --- | --- |
| The full gate | `npm run gate` | exit 0 (format, lint 0 warnings, typecheck, all tests, knip) |
| One test file | `npx vitest run path/to/file.test.ts` | green |
| Invariants only | `npx vitest run --project invariants` | green (I1–I14 subjects incl. tool gates + plugin hash) |
| Crash torture | `npx tsc -b && CYCLES=25 node tools/kill-harness.mjs` | `25 cycles … zero duplicate or lost events` |
| Plugin drop-in proof | `node tools/m3-plugin-proof.mjs` | `M3-PROOF PASS`, idle RSS < 170 MB |
| RSS under load | `node tools/m2-rss-check.mjs` | peak < 256 MB |
| The server | `WELTARI_FAKE_LLM=1 node apps/server/dist/main.js` (after `npx tsc -b`) | listens on 127.0.0.1:7777, protocol 0.4.0 in the hello frame |
| The UI (dev) | `npm run dev --workspace @weltari/web` | http://localhost:5173 (proxies /v1 + /plugins to 7777) |
| Terminal client proof | `curl -N http://127.0.0.1:7777/v1/events` | hello + event replay, resumable via `Last-Event-ID` |

## Manual test script (browser, fake LLM)

1. Open http://localhost:5173 — green dot, "The Rainy Inn", Elias on stage.
2. Type anything → sentences pace one per click; toggle **Auto**; ▼ shows buffered text.
3. Tools via triggers: `!move subloc:cellar` (backdrop slides, chip updates, map pin moves), `!art char:elias smile` (pose + accent change), `!end continuation` (divider + Stay/Jump/Map buttons; input disabled until you continue).
4. Interrupt: restart the server with `WELTARI_EMIT_FAULT_POINTS=1 WELTARI_FAULT_PAUSE_MS=2500` to widen the window, type mid-stream, press **✋ Interrupt** — the transcript must show only what you saw, marked `— interrupted —`, and NO tool effects from that turn may persist.
5. Dev mode: reload with `?dev=1` — gauges strip, plugin provenance lines (`⬡ wl-map@… sha256:…`), green `dev.tool_call` / red `dev.tool_rejected` lines (`!move subloc:moon` and `!badshape` should produce state/schema rejections with ZERO new events).
6. Map: top-bar **Map** button → `<wl-map>` modal; `POST /v1/commands/paint-region` (image_id `map:w1`) → tile appears; `!move` → pin at world coordinates.
7. Mobile: devtools mobile viewport — stage stacks, Transcript button slides the pane over.
8. Reconnect: kill the server mid-scene, restart — the page must rebuild the full transcript from replay, exactly once, no duplicates.

## Real-provider spot check (only if I ask — spends money)

`OPENROUTER_API_KEY` from `openrouter_api.txt` (gitignored, env-only, never committed/logged); ~$1.9 remains — a few turns cost cents. Unset `WELTARI_FAKE_LLM`. Watch `cached_tokens` in the debug log (cache-hit discipline) and whether the Narrator's SDK toolset produces valid tool calls — the tools have never run against a real provider.

## Known quirks (don't chase these as bugs)

- **This Windows box intermittently nears ephemeral-port exhaustion** (external process; `netstat -ano -p tcp | grep -c TIME_WAIT` near 16k = that's it). Tests/harness already retry `EADDRINUSE` persistently and rotate ports. Remedy if it blocks you: wait it out, or (admin) `netsh int ipv4 set dynamicport tcp start=32768 num=32768`.
- A leftover server from an old session may squat on 7777 — check `netstat -ano | grep :7777` and kill only a `node apps/server/dist/main.js` process.
- Editing any file inside `plugins/<name>/` invalidates its manifest hash — recompute with `node -e "import('./packages/plugin-sdk/dist/index.js').then(m => console.log(m.computePluginContentHash('plugins/<name>')))"` and update `plugin.json`, or the loader will (correctly) refuse it.
- The FakeLLM finishes turns in milliseconds — interrupt/animation testing needs the fault-pause env vars above.

## Rules for fixes

- One defect = one small conventional commit (`fix(module): …`) with a test that pins the bug, the module's `docs/` page updated in the same commit, and `npm run gate` at 0 before it's done. Push as you go — I approve.
- Never weaken/delete a test to go green; `tests/invariants/` edits need my `invariant-change` label (adding new invariant tests is always fine); no dependency version bumps; no `.env`/keys in commits.
- If something looks wrong but is actually specified behavior (check Brief/UI Spec/Guide first), report it as a spec question instead of "fixing" it.
- End with a plain summary: what you exercised, what passed, what you fixed (with commits), what remains suspicious.
