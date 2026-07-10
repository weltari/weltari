# Weltari — agent handover

You are an AI coding agent (any model — this document assumes nothing about
which) taking over development of Weltari. Everything you need is in this
repository; this page tells you what you inherit, how work is done here, and
where to start. A human-oriented companion lives at
[project-overview.md](project-overview.md); a plain-language tour of every
source module lives in [code-tour/](code-tour/README.md).

## What you inherit

Weltari is a self-hosted, single-process AI-RP world engine: a living world
map, streaming visual-novel scenes with an LLM narrator, DM chat with
characters, and an append-only event log that makes every world permanent and
crash-proof. TypeScript strict, Node 24 LTS, ESM, npm workspaces. The core is
AGPL-3.0-only; `packages/protocol` and `packages/plugin-sdk` are MIT.

State at handover (2026-07-10, end of week 11):

- **Milestones 1–5 and M6 parts 1–3 are complete and proven** — crash-safe
  engine + job ledger (100-cycle kill harness, zero lost/duplicated events),
  the full Scene page with the narrator tool surface, the living fog map
  painted by real image backends, the in-scene creation loop, the Weltari
  Chat DM core with the `startscene()` bridge and the subwiki pass, and
  since week 11 the character-led startscene (a real character negotiated
  the place and fired the tool itself), proactive CRON DMs with the
  3-unanswered freeze, the wikiquery/sessionquery escalation, and the
  read-only Wiki page.
- `npm run gate` green (397 tests); kill harness green over 14 fault points.
- Each week ended with a measured results page: `docs/week1-results.md`
  through `docs/week11-results.md`. Real-provider spend has been tracked to
  the cent throughout (week 11 cost $0.03; a chat DM turn ≈ $0.003).

## Your task

The next session is **Week 12 — Milestone 6 part 4** (the social surfaces:
startscene invitation TTL/expiry, group chats, gateway push of CRON DMs,
the Feed, wiki manual edits — likely split across two weeks, settle with
the owner). The complete briefing — owner rulings, scope, success
criteria, budget, carried-over notes — is `Week 12 Kickoff Prompt.md` at the
repo root. Treat it as the authoritative task description; where it conflicts
with anything else except the owner, it wins.

The weekly rhythm, which you should continue: kickoff prompt → agree scope
and budget with the owner at session start → build in small conventional
commits → demonstrate the success criteria → write `docs/weekN-results.md`
→ commit; the owner pushes.

## Read in this order

1. `CLAUDE.md` — the one-page index of rules and layout. Binding.
2. `Week 11 Kickoff Prompt.md` — your task, including its own reading list
   (week-10 results, the relevant Rev 4 sections, UI Spec sections).
3. `docs/Coding Guide/AI Coding Guide.md` — the full rulebook the CI
   enforces. Skim all of it once; the invariant IDs (A11, B6, B10, C7, I4 …)
   are referenced everywhere.
4. `docs/INDEX.md` — one line per module wiki page; open the pages for the
   modules you are about to touch.
5. If a module is unfamiliar, `docs/code-tour/` explains every file in plain
   language.

Spec and session documents are **read-only**: the Brief, UI Spec, Stack
Session/, Coding Guide/, Rev 3/Rev 4, ui-wireframes/. Never edit them.

## The working contract (non-negotiable)

- `npm run gate` (format:check → lint 0-warnings → typecheck → full Vitest →
  knip) must exit 0 before anything is called done. Docs page changes and
  tests ship **in the same commit** as the code.
- The six "never violate" rules in `CLAUDE.md` §Never-violate are machine
  enforced: append-only `events` table, `safeParse` via `validateAt()` at
  every trust boundary (`.parse()`, `any`, and type assertions are banned),
  byte-stable prompt prefixes, the B6 double gate on LLM output, `actor_id`
  on every event, secrets only via `boundary/config/env.ts`.
- Modifying existing `tests/invariants/` files requires the owner's
  `invariant-change` approval — adding new invariant tests is free.
- New dependencies: ask the owner first; exact-pinned versions only.
- Vocabulary is fixed (Rev 4 §3): `mailbox`, `ledger_job`, `turn_envelope`,
  `sublocation`, `proposal`, `reflection`; the event trail is `trail`, pino
  diagnostics are `logger`/`diag`, never the bare identifier `log`.
- Commit messages are conventional (`feat(engine): …`, `docs: …`);
  commitlint runs in the hooks.

## Working with the owner

- The owner is **not a professional developer**. Explain plainly, avoid
  jargon or define it, give a recommendation with the trade-off, and let
  them decide only where a genuine value judgment remains.
- After each milestone-sized step, summarize in plain words what now exists
  and what's next.
- The owner runs `git push` themselves — hand them the exact command.
- Owner decisions get recorded in the week's kickoff/results docs; the most
  recent standing rulings (2026-07-09/10): startscene is conversational and
  character-led (the button is dev-mode only); CRON DMs are real-time in V1
  with game-day stamps recorded for V2; the freeze is a durable event whose
  user-facing notice belongs to the gateway; expiry notices are hardcoded
  injected text, never an extra LLM call (full list:
  docs/week11-results.md §owner rulings).

## Cost discipline (this is why fakes exist)

- **Fake/stub is the default everywhere** (`WELTARI_FAKE_LLM=1`). Real
  backends run only when the owner has set the env for a demo. The kill
  harness must stay zero-cost.
- Before any batch of >10 real calls, estimate the cost and say it. Track
  exact spend via `GET https://openrouter.ai/api/v1/credits` deltas
  immediately before and after every real run; report the running total.
- Measured reference prices are in the Week 11 prompt's "Notes carried over"
  section. The weekly budget is set by the owner at session start.

## How to run and verify

- `npm ci` → `npm run build` → launch configs in `.claude/launch.json`:
  `weltari-fake` (stub LLM), `weltari-masking` (stub + 7 s delay),
  `weltari-real` (OpenRouter via `.env`), `web` (Vite dev server, port 5173;
  server on 7777).
- Tests: `npm test`, invariants only: `npx vitest run --project invariants`,
  single file: `npx vitest run path/to/file.test.ts`.
- Crash-safety: the kill harness in `tools/` (25 cycles per PR, 100
  nightly) — invocation and fault-point table in `docs/tools.md`.
- Windows dev-box quirks (browser preview viewport collapse, screenshot
  timeouts) are listed in the Week 11 prompt.

## Open items at handover

- ⚠️ **OpenRouter key rotation is an owner task, standing since M5.** The
  key is shared and has seen small unrelated external usage. If real calls
  suddenly return 401, the owner rotated it — ask for the new one (it lives
  only in `.env` / `openrouter_api.txt`, both gitignored).
- Pre-existing nit, not a regression: boot-time `update_check` parks on a
  404 against the release URL in dev worlds.
- M6 part 4 (week 12+): startscene invitation TTL/expiry, group chats, the
  Feed/Camera surface, wiki manual edits + review toggle, gateway push of
  CRON DMs + the frozen-thread notice. The real memory store
  (`memoryquery`) is M7; the GM agent (cold boot, Proposal authoring,
  profiling) and objects/backpacks follow before V1 closes.
