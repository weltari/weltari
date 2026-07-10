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

## Where the project stands (2026-07-10)

Built in ten weekly sessions, each ending with measured pass/fail criteria
(`docs/week1-results.md` … `week10-results.md`):

| Milestone | What it delivered | Status |
| --- | --- | --- |
| M1 — Walking skeleton (week 1) | End-to-end AI turn, streaming, crash-safe log with resume | ✅ |
| M2 — Durability (week 2) | Reflections, image compositing, world clock, 100-cycle kill table | ✅ |
| M3 — Player experience (weeks 3–4) | Real Scene page, plugin loader, packaging + signed self-update | ✅ |
| M4 — The UI shell (weeks 5–6) | App shell, Map/Gameday/Config pages, fog + Explore, scene lifecycle | ✅ |
| M5 — The painted map (weeks 7–8) | Real image backends paint/extend the map; draw on it, click into it | ✅ |
| M6 — Creation + Chat (weeks 9–11) | In-scene creation loop ✅, Chat DM core + startscene bridge ✅, part 3 is next | 🚧 |

Total real-AI spending across all ten weeks: **under $10**, tracked to the
cent. Recent weeks cost cents (week 10: $0.19; one chat message ≈ $0.003)
because everything runs against free fakes by default and real AI is used
only for final proof demos.

## What's left to build

- **Week 11 (M6 part 3)** — already written up in `Week 11 Kickoff
  Prompt.md` at the repo root: characters negotiate and open scenes
  themselves from chat, characters text you *first* (proactive DMs with a
  politeness freeze after 3 ignored messages), characters look things up
  mid-conversation, and a read-only Wiki page.
- **M6 part 4** — group chats, the Feed/Camera surface, manual wiki edits,
  pushing proactive DMs out through Telegram.
- **M7** — the real long-term memory store for characters.
- **V1 wrap-up** — polish, a one-command playable build for strangers
  (packaging and self-update already exist and are proven).

## How long until it's finished?

At the established pace — one focused session per week, each shipping a
proven slice — the remaining list above is roughly **3–5 sessions**: week 11,
one for M6 part 4, one or two for M7, and a wrap-up. That matches the
estimate recorded at week 6 ("~6–7 weeks to V1"). It's an estimate, not a
promise: every week so far has also surfaced one or two real-world surprises
(that's what the sessions are for).

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
