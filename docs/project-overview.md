# Weltari — project overview (for humans)

This page is for a person — the owner, a friend, a future collaborator — who
wants to understand the project without reading code. The companion page for
an AI agent taking over development is [handover.md](handover.md); a
plain-language explanation of every source file is in
[code-tour/](code-tour/README.md).

## What is the app?

Weltari is a single program you run on your own computer that hosts a living,
AI-driven roleplay world. You stand on a **World Map** that is really painted
(an AI image model draws and extends it). Stepping into a place opens a
**Scene** — a streaming visual novel where an AI narrator and AI characters
play out you *being there*. Between scenes you can **chat** with characters
in a DM inbox, and a chat can naturally turn back into a scene ("should we
meet at the pond?" → the character opens the scene itself). Everything that
happens — every line, every scene, every image — is written to a permanent
event log that can never be edited, only added to. Kill the program at the
worst possible moment and restart it: nothing is lost, nothing is duplicated.
That property is not a hope; it is re-proven by an automated "kill harness"
that murders the process hundreds of times mid-write and checks the world
survived.

You bring your own AI provider (currently OpenRouter). There is no
subscription and no company server; the world lives in a single SQLite file
on your disk. The core is AGPL-licensed; the two small packages plugin
authors need are MIT.

## How the code is organized

Everything lives in one repository with three kinds of code:

| Where | What it is |
| --- | --- |
| `packages/protocol` | The shared "language" — exact definitions of every message the server and browser exchange. MIT. |
| `packages/plugin-sdk` | The contract plugin authors build against. MIT. |
| `apps/server` | The engine itself. Split into strict rooms: `storage` (the only code that touches the database), `engine` (world rules + building AI prompts), `llm` (the only code that calls AI providers), `ledger` (crash-safe background jobs), `painter` (the only code that edits images), `gateway` (Telegram and other messengers), `boundary` (plugins, self-update, config — the trust checks), `http` (the web server + live event stream), `observability` (logging). |
| `apps/web` | The browser app (React). It only *displays* what the server streams and sends your clicks back — it never decides game logic. |
| `plugins/` | Drop-in folders: themes, maps, screens. Fingerprint-verified at load. |
| `tests/`, `tools/`, `scripts/` | The safety net: invariant tests, the kill harness, CI checks. |
| `docs/` | The wiki — one page per module ([INDEX.md](INDEX.md)), weekly results, the binding Coding Guide and specs, and now this code tour. |

"Strict rooms" is enforced by the linter, not politeness: code outside
`storage` cannot write SQL, code outside `llm` cannot call an AI, and so on.

## Where the project stands (2026-07-21)

**V1 is complete.** Built in nineteen weekly sessions, each ending with
measured pass/fail criteria (`docs/week1-results.md` …
`week19-results.md`); week 19 was a dedicated verification week that
audited the whole spec against the code before declaring V1 done:

| Milestone | What it delivered | Status |
| --- | --- | --- |
| M1 — Walking skeleton (week 1) | End-to-end AI turn, streaming, crash-safe log with resume | ✅ |
| M2 — Durability (week 2) | Reflections, image compositing, world clock, 100-cycle kill table | ✅ |
| M3 — Player experience (weeks 3–4) | Real Scene page, plugin loader, packaging + signed self-update | ✅ |
| M4 — The UI shell (weeks 5–6) | App shell, Map/Gameday/Config pages, fog + Explore, scene lifecycle | ✅ |
| M5 — The painted map (weeks 7–8) | Real image backends paint/extend the map; draw on it, click into it | ✅ |
| M6 — Creation + Chat + Social (weeks 9–13) | In-scene creation loop, Chat DM core + character-led startscene, proactive DMs, invitation expiry, group chats, the Telegram bridge, the Feed + wiki manual edits | ✅ |
| M7 — GM + memory + objects + the living world (weeks 14–17 + the GM-UX session) | The real memory store (deltas + search + compaction), the GM agent (guided world creation, Proposal-gated authoring, profiling with GDPR controls), objects at places, chance-encounter markers + world movement | ✅ |
| The agentic scene (week 18) | ONE narrator call drives the whole turn: it decides who speaks, calls characters, can mint new ones mid-scene, moves people, tracks story goals, and registers the next scene as a true continuation | ✅ |
| Verification & close-out (week 19) | Line-by-line spec audit with per-line evidence, eight fixes, packaging re-verified, docs refreshed — **V1 declared done** | ✅ |

Total real-AI spending across all nineteen weeks: **under $10**, tracked
to the cent. Recent weeks cost cents (week 18: $0.048; a full agentic
turn ≈ $0.015–0.02) because everything runs against free fakes by default
and real AI is used only for final proof demos.

## What's next (V1 is done)

Nothing is *required* — the app is a complete, packaged, self-updating
V1. The agreed follow-up lists (owner rulings, details in
[week19-results.md](week19-results.md)):

- **V1.5** — private character "attempts" (the player sees only what an
  onlooker would); the GM actually *using* what it learns about you;
  generated art for characters minted mid-story; weather; posting on the
  Feed yourself; a settings panel for the knobs that are
  environment-variables today.
- **V2** — backpacks and item hand-overs, multiplayer, and the
  longer-horizon storytelling machinery (planned future events, a
  Director).

## How to run and try it

Prerequisites: Node.js 24 and npm. Then, from the repo root:

```
npm ci            # install exact-pinned dependencies
npm run build     # compile server + web
```

Launch configurations live in `.claude/launch.json` (usable from Claude Code
or by copying the commands out of the file):

- **`weltari-fake`** — the server with a fake AI. Free, instant, no key
  needed. This is the default way to poke at the app.
- **`web`** — the browser app dev server on <http://localhost:5173> (the
  server itself listens on port 7777).
- **`weltari-masking`** — fake AI with a 7-second delay, to see the loading
  UX.
- **`weltari-real`** — real AI via OpenRouter; needs `OPENROUTER_API_KEY` in
  `.env` (copy `.env.example`, fill in values; the file is gitignored and
  must never be committed). Real runs cost real money — cents, but real.

## How to test it

- `npm run gate` — the project's definition of done: formatting, linting
  (zero warnings), type checking, the full test suite, and dead-code
  detection. Everything must pass before any change counts as finished.
- `npx vitest run --project invariants` — just the invariant tests, the
  rules that must never break (append-only log, no duplicate events, …).
- The kill harness in `tools/` — starts the real server, kills it at brutal
  random moments, restarts, and verifies nothing was lost or corrupted. See
  [tools.md](tools.md) for invocation; it runs 25 cycles per PR and 100
  nightly, always against fakes, always at $0.00.
