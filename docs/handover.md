# Weltari — agent handover

You are an AI coding agent (any model — this document assumes nothing about
which) taking over Weltari. Everything you need is in this repository; this
page tells you what you inherit, how work is done here, and where to start.
A human-oriented companion lives at [project-overview.md](project-overview.md);
a plain-language tour of every source module lives in
[code-tour/](code-tour/README.md).

## What you inherit

Weltari is a self-hosted, single-process AI-RP world engine: a living world
map, streaming visual-novel scenes driven by an agentic LLM narrator, DM
and group chat with characters, a GM agent, a character Feed, and an
append-only event log that makes every world permanent and crash-proof.
TypeScript strict, Node 24 LTS, ESM, npm workspaces. The core is
AGPL-3.0-only; `packages/protocol` and `packages/plugin-sdk` are MIT.

State at handover (2026-07-21, end of week 19):

- **V1 is COMPLETE and verified.** Weeks 1–18 built milestones 1–7 plus
  the agentic scene; week 19 audited every Rev 4 §18 "In V1" line and
  every module contract against the code, fixed the audit's findings, and
  declared V1 done — the full audit tables with per-line evidence live in
  [week19-results.md](week19-results.md).
- What that means concretely: crash-safe engine + job ledger (kill harness
  over **26 fault points**, zero lost/duplicated events, verified again at
  CYCLES=100 scale), the agentic Scene page (ONE narrator call runs the
  whole turn: routing, character calls, minting, moves, goals, the full
  next-scene registration — protocol 0.21.0), the living fog map with real
  image backends, Weltari Chat (DMs, group chats, character-led
  `startscene()`, proactive CRON DMs, the Telegram bridge), the GM agent
  (cold-boot world interview, Proposal-gated authoring, profiling with
  GDPR guardrails), the World Agent (summaries + subwiki with
  narration-only sourcing), the tiered memory store (core + deltas +
  FTS5 + compaction), objects (sublocation-only, per the owner's V2
  backpack ruling), markers + CRON world movement, the Feed, self-update
  (B12, signed artifacts), drop-in plugins (B10), Docker + Windows
  packaging.
- `npm run gate` green (**670 tests**); idle RSS well under the 170 MB
  budget; real-provider spend tracked to the cent every week (week 18:
  $0.048; week 19: see its results doc).

## Your task

**There is no prescribed next week — V1 is closed.** The natural
candidates, all owner-ruled, in rough order of value:

- **V1.5 items (owner rulings, 2026-07-21 unless noted):** the
  message/attempt tool split (structural attempt privacy — the character's
  raw attempt becomes log-only and the player sees only the narrated
  surface; speech is already verbatim-committed today); the GM profiling
  consumption legs (hypotheses → Narrator injection, World Agent
  engagement signal — the collection + GDPR side is live); minted-character
  art sets (generated pose sets — today `switch_art` correctly refuses for
  minted characters); weather (V1.5 by the week-13-era ruling); user Feed
  posting; config-panel UI for the env-only CRON/CACHE/marker knobs.
- **V2 (deferred by Rev 4 §18 + owner rulings):** backpacks +
  `transfer_object` (character/user holders), multiplayer, the resolve
  loop, FEL/DES + Director, inter-agent comms, object nesting, group
  fan-out (the set-typed `determine_who_next` contract already permits it).

Whatever the owner picks: write a kickoff prompt at the repo root in the
established shape (read `Week 19 Kickoff Prompt.md` as the template),
agree scope + budget at session start, and carry the owner rulings
forward. The documented-known list (deliberate V1 deviations the owner
signed off) is in week19-results.md — do not "fix" those without a ruling.

## Read in this order

1. `CLAUDE.md` — the one-page index of rules and layout. Binding.
2. `docs/week19-results.md` — the V1-done declaration, the audit tables,
   the documented-known list, and the owner rulings that shape V1.5/V2.
3. `docs/Coding Guide/AI Coding Guide.md` — the full rulebook the CI
   enforces. Skim all of it once; the invariant IDs (A11, B6, B10, C7,
   I4 …) are referenced everywhere.
4. `docs/INDEX.md` — one line per module wiki page; open the pages for
   the modules you are about to touch.
5. If a module is unfamiliar, `docs/code-tour/` explains every file in
   plain language (refreshed at the week-19 close-out).

Spec and session documents are **read-only**: the Brief, UI Spec, Stack
Session/, Coding Guide/, Rev 3/Rev 4, ui-wireframes/. Never edit them —
spec edits need fresh owner authorization every time.

## The working contract (non-negotiable)

- `npm run gate` (format:check → lint 0-warnings → typecheck → full Vitest
  → knip) must exit 0 before anything is called done. Docs page changes
  and tests ship **in the same commit** as the code.
- The six "never violate" rules in `CLAUDE.md` are machine-enforced:
  append-only `events` table, `safeParse` via `validateAt()` at every
  trust boundary (`.parse()`, `any`, and type assertions are banned),
  byte-stable prompt prefixes, the B6 double gate on LLM output,
  `actor_id` on every event, secrets only via `boundary/config/env.ts`.
- Modifying existing `tests/invariants/` files requires the owner's
  `invariant-change` approval — adding new invariant tests is free.
- New dependencies: ask the owner first; exact-pinned versions only, with
  a `docs/dependencies.md` entry in the same PR.
- Vocabulary is fixed (Rev 4 §3): `mailbox`, `ledger_job`,
  `turn_envelope`, `sublocation`, `proposal`, `reflection`; the event
  trail is `trail`, pino diagnostics are `logger`/`diag`, never the bare
  identifier `log`.
- Commit messages are conventional (`feat(engine): …`, `docs: …`);
  commitlint runs in the hooks.

## Working with the owner

- The owner is **not a professional developer**. Explain plainly, avoid
  jargon or define it, give a recommendation with the trade-off, and let
  them decide only where a genuine value judgment remains.
- After each milestone-sized step, summarize in plain words what now
  exists and what's next.
- Push over SSH (`git push origin main`, key `~/.ssh/github`) — run it
  and let the owner approve, or hand them the command.
- Owner decisions are recorded in the week's kickoff/results docs. The
  standing ones that shape everything: the world clock NEVER advances
  without a user-present event; ALL CRON rides the world clock as
  game-time occurrences; scenes idle = paused forever (no timers);
  critical tool chains retry ≤10 then roll back with a red-line notice;
  backpacks are V2 (2026-07-16); the week-19 rulings above (2026-07-21).

## Cost discipline (this is why fakes exist)

- **Fake/stub is the default everywhere** (`WELTARI_FAKE_LLM=1`). Real
  backends run only when the owner has set the env for a demo. The kill
  harness must stay zero-cost. `weltari-real` defaults
  `WELTARI_IMAGE_BACKEND=stub` — flip to `openrouter` only for a
  deliberate image demo; paints dominate cost every time.
- Before any batch of >10 real calls, estimate the cost and say it. Track
  exact spend via `GET https://openrouter.ai/api/v1/credits` deltas
  immediately before and after every real run; report the running total.
  Measured prices: chat-class ≈ $0.002–0.017/call; a full agentic turn
  ≈ $0.015–0.02. The weekly budget is set by the owner at session start.

## How to run and verify (macOS since 2026-07-19)

- Run EVERYTHING under Homebrew node@24:
  `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"` (default node
  violates the engines pin). A cold or loaded vitest run may flake once
  with fork-worker timeouts — re-run on a quiet machine before diagnosing.
- `npm ci` → `npm run build` → launch configs in `.claude/launch.json`:
  `weltari-fake` (stub LLM), `weltari-masking` (stub + 7 s delay),
  `weltari-real` (OpenRouter via `.env`), `web` (Vite dev, port 5173;
  server on 7777). DBs live under `$TMPDIR/weltari-*`; `rm -rf` one for a
  fresh world. `weltari-real` holds Brackwater with the played agentic
  scene (`s-agentic-demo`, ended); `weltari-fake` holds the week-18
  criteria transcript.
- After ANY protocol bump: `npm run build --workspace @weltari/web`
  before a browser demo — a stale served dist silently drops unknown
  events.
- Tests: `npm test`; invariants only: `npx vitest run --project
  invariants`; single file: `npx vitest run path/to/file.test.ts`.
- Crash-safety: the kill harness in `tools/` (CYCLES=26 per PR — full
  26-fault-point coverage — and 100 nightly); invocation + fault-point
  table in `docs/tools.md`. The offline verifier
  `tools/verify-consistency.mjs` runs blocks 1–4r — extend, never fork.
- Untracked-by-design at the repo root: `docs/code-tour/*_zh.md`,
  `summarise/`, `transfer.md` — never commit them (beware `git add docs`).

## Open items at handover

- ⚠️ **The owner rotates the shared OpenRouter key** right after the
  week-19 session (owner ruling 2026-07-21) — the single post-close step
  outside the repo. If real calls return 401, the rotation happened: ask
  the owner for the new key (it lives only in `.env` /
  `openrouter_api.txt`, both gitignored).
- The V1.5 / V2 lists above are the whole backlog; nothing else is
  pending. The documented-known list in week19-results.md names every
  deliberate deviation so nobody "fixes" working designs by accident.
