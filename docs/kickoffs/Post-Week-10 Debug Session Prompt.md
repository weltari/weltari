# Debug / Test Session — exercise Weltari and fix what you find (post-week-10 state)

You are testing and debugging Weltari in this repository (`D:\devproj\weltari`,
remote `https://github.com/weltari/weltari`). Do NOT build new features this
session — Week 11 (M6 part 3) is a SEPARATE future session; nothing from its
scope (character-led startscene, CRON DMs, query escalation, Wiki page) gets
built today. Your job is to break what already exists, then fix genuine
defects with small, gated commits. I am not a professional developer —
explain findings plainly: what you saw, why it's wrong, what you changed.

## Read first, in this order

1. `CLAUDE.md` — the one-page rule index.
2. `docs/handover.md` — current state and the working contract.
3. `docs/week10-results.md` — what exists and was proven, incl. demo scripts.
4. `docs/Coding Guide/Task Completion Checklist.md`.
5. The `docs/INDEX.md` module page of anything you touch; if a module is
   unfamiliar, its plain-language page in `docs/code-tour/`.

## How to run everything

- `npm ci` (if needed) → `npm run build`.
- The full gate: `npm run gate` — must exit 0 (format, lint 0 warnings,
  typecheck, all 57 test files, knip).
- Invariants only: `npx vitest run --project invariants`. One file:
  `npx vitest run path/to/file.test.ts`.
- Crash torture: the kill harness at CYCLES=25 (zero lost/duplicated events,
  $0.00 — it must never touch a real backend). Exact invocations for the
  harness and the offline consistency verifier: `docs/tools.md` and
  `docs/code-tour/tests-and-tools.md`.
- The app: launch configs in `.claude/launch.json` — `weltari-fake` (default,
  free), `weltari-masking` (fake + 7 s delay, for loading/animation UX),
  `web` (http://localhost:5173; the server listens on 7777).

## What to exercise (fake LLM, in the browser)

Work through the proven surfaces end-to-end; the demo scripts in
`docs/week5-…week10-results.md` are the source of truth for expected behavior:

1. **Scene page** — sentence pacing, Auto, fake tool triggers (`!move`,
   `!art`, `!create`, `!end`), interrupt mid-stream (no tool effects may
   persist), soft-close buttons, backdrop slides.
2. **Map** — fog, Explore, sublocation materialization, paint/extend,
   draw-on-map, click-to-enter.
3. **Chats page** — DM turns, presence rule, the `!startscene <place-slug>`
   bridge (chat closes with reason `startscene`, scene opens), reflect_chat.
4. **Lifecycle** — kill the server mid-scene and mid-chat, restart: full
   transcript rebuilt from replay, exactly once, no duplicates.
5. **Gameday / Config / History / dev mode (`?dev=1`)** — gauges, plugin
   provenance, green/red tool-call lines; schema/state rejections must
   produce ZERO new events.

## Real-provider spot check (ONLY if I say so — spends money)

Key comes from `.env` (gitignored; never committed or logged). ⚠️ The key is
shared and rotation is pending — if calls 401, ask me. Track exact spend via
`GET https://openrouter.ai/api/v1/credits` deltas before/after; a chat turn
≈ $0.003, narrator turns ≈ $0.01–0.03. Estimate before any batch >10 calls.

## Known quirks (don't chase these as bugs)

- Boot-time `update_check` parks on a 404 against the release URL in dev
  worlds — pre-existing, not a regression.
- This Windows box intermittently nears ephemeral-port exhaustion; tests
  already retry `EADDRINUSE`. A leftover server may squat on 7777 — kill only
  a `node apps/server/dist/main.js` process.
- Editing any file inside `plugins/<name>/` invalidates its manifest hash —
  the loader refusing it is CORRECT behavior.
- The FakeLLM finishes in milliseconds — use `weltari-masking` or the
  fault-pause env vars for interrupt/animation testing.
- Browser-preview tooling on this box: viewport can collapse to 0×0, and
  screenshots time out on animating pages — verify via DOM sampling and
  fetching `/v1/images/*` instead.

## Rules for fixes

- One defect = one small conventional commit (`fix(module): …`) with a test
  that pins the bug, the module's `docs/` page updated in the SAME commit,
  and `npm run gate` at 0 before it's called done. I run `git push` — hand
  me the command when commits are ready.
- Never weaken or delete a test to go green. `tests/invariants/` edits need
  my `invariant-change` label (adding new invariant tests is always fine).
  No new dependencies, no version bumps, no `.env`/keys in commits. The
  spec/session docs (Brief, UI Spec, Coding Guide/, Stack Session/, Rev 3/4)
  are read-only.
- If something looks wrong but matches the Brief/UI Spec/Guide, report it as
  a spec question instead of "fixing" it.
- End with a plain summary: what you exercised, what passed, what you fixed
  (with commit hashes), what remains suspicious, and total real spend ($0.00
  unless I authorized otherwise).
