# Week 18 Kickoff Prompt — the agentic scene (paste this to start the session)

Build week 18 of Weltari in this repository (`/Users/xihson/devproj/weltari`
on the MacBook, remote `git@github.com:weltari/weltari.git`). **Milestones
1–7 and the GM proposal UX contract are complete and proven**
(`docs/gm-ux-results.md`): protocol 0.20.0, GM prose streaming, inline
settle-in-place consent cards, the durable tool-result turn (natural key
`gm-followup-<proposal_id>`, eager trigger + boot sweep), the real
chat-about-this signal, verify block 4q, 25 fault points, CYCLES=25 green
at $0.00. The contract session cost $0.0308 of its $2.00 budget; DeepSeek
ran the cold-boot interview properly, proposed a full world seed, and
reacted to the consent unprompted. I am not a professional developer —
explain plainly, recommend, and let me decide only where a genuine value
judgment remains.

**THIS week builds the agentic scene (Rev 4 §6)**: the Narrator stops
being a scripted three-call turn and becomes a real tool loop the Scene
Engine orchestrates — the last feature week before week 19 closes V1.

## The V1 completion map (owner rulings — carry forward weekly)

Weather is V1.5 (owner ruling); **backpacks are V2** (owner ruling
2026-07-16); every other Rev 4 §18 "In V1" item stays V1.

| Week | Scope | Rev 4 | Status |
| --- | --- | --- | --- |
| 14 | The real memory store | §11, §4.2 | ✅ done |
| 15 | The GM agent: Proposal pipeline, cold boot, consent-gated authoring, profiling + GDPR | §9, §16 | ✅ done |
| 16 | Objects (sublocation-only) | §7, §14, §17 | ✅ done |
| 17 | The living-world loop: markers + CRON movement + position bubbles | §14, §17 | ✅ done |
| — | **The GM proposal UX contract** | §9, §16 | ✅ **done** (`docs/gm-ux-results.md`) |
| **18 (this prompt)** | **The agentic scene**: `make_character`, `charactercall`, set-typed `determine_who_next` (V1: size 1), `character_leave`, `move_character`, scene-side `query_wiki`, storytelling goals → subgoals (`update_goals` + persisted snapshots), the full `next_scene_registration` payload, the context-budget warning | §6 | |
| 19 | Verification & close-out: line-by-line audit of Rev 4 §18 + module contracts against the CODE, fix findings, packaging ship, handover refresh, key rotation confirmed — only then is V1 done | all | |

Already deferred (stays deferred): user Feed posting (V1.5), Mail, the
resolve loop, FEL/DES, multiplayer, inter-agent comms, object nesting,
backpacks + `transfer_object` (V2), weather (V1.5).

## Target vs. current (the engineering delta)

- **Current (`engine/scene-turn.ts`):** one user turn = a FIXED
  `CallPlan[]` — narrator (2-3 sentences, tools) → the ONE hardwired
  fixture character (Elias) → a closing narration. Who speaks is code, not
  the Narrator; characters can never join, leave, or move mid-scene; no
  goals/subgoals exist; `end_scene`'s continuation carries only
  `next_scene: {sublocation_id, premise_seed?}` — not the full §6
  registration payload; no context-budget warning.
- **Target (Rev 4 §6):** the Scene Engine stays a deterministic state
  machine + orchestration loop, but the Narrator DRIVES the turn through
  tools: `determine_who_next` (returns a SET of character ids — V1 policy
  always size one, the set type keeps V2 group fan-out open),
  `charactercall` (the engine builds the character prompt and feeds the
  reply back mid-loop — the same mid-call seam the GM's wikiquery and the
  durable tool-result turn already use), `make_character(present|absent)`,
  `character_leave`, `move_character` (mailbox hot-path exception),
  scene-side `query_wiki`; storytelling goals ride the stable prefix
  (chapter seed → story goals, Narrator only, never characters) and
  `update_goals` persists a structured subgoal snapshot each turn so
  resume restores story position; turn BUDGETS cap character turns per
  user turn (then yield); `end_scene(new_scene_available)` must register
  the full `next_scene_registration` payload
  (`{sublocation, time_offset, expected_participants[], premise_seed,
  brief_history, carried_goals[]}` — engine-validated, error + re-call on
  a missing payload); the engine checks context size each round and warns
  the Narrator near the budget (`context_limit_reached` end type).
- **Presence discipline stays engine-owned**: scene start reserves
  characters, `make_character`/`character_leave` flow through the same
  presence gates chat and CRON movement already read; every tool call
  validates against state before execution (present characters only, valid
  sublocations — the existing `createToolStage` pattern).

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index.
2. `docs/gm-ux-results.md` — what the UX contract proved, the final
   convergence pass added to the harness, and the carried debts.
3. Rev 4 §6 (Scene System — the whole section: Scene Engine contract,
   Narrator contract, sublocation workflow, output & pacing) + §7 (the
   C-Module the character calls run through) — this is the binding spec.
4. `docs/engine.md` rows for scene-turn.ts / scene-tools.ts / markers.ts +
   `docs/llm.md` (tools.ts + both clients).
5. `docs/Coding Guide/AI Coding Guide.md` — B6 (both gates on every new
   tool), I5 (goals enter the STABLE prefix — mind byte stability), C2/C7.
6. `docs/handover.md` if anything else is unclear.

## Scope (recommended — adjust with me at session start)

1. **The Narrator toolset grows** (`llm/tools.ts`, both clients):
   `determine_who_next`, `charactercall`, `make_character`,
   `character_leave`, `move_character`, `query_wiki`, `update_goals`, and
   `end_scene` gains the full `next_scene_registration` union. Gate 1
   schemas + gate 2 state checks for every one (B6 twice).
2. **The orchestration loop** (`engine/scene-turn.ts`): replace the fixed
   CallPlan[] with the §6 loop — Narrator streams, tool calls validate and
   execute mid-call (charactercall runs the C-Module and feeds the reply
   back), turn budget caps the rounds, the envelope closes on yield. The
   scripted three-call shape survives only as the fake's default script.
3. **Goals → subgoals**: chapter seed + story goals in the Narrator's
   stable prefix (I5 — byte-stability tests extend); `update_goals`
   snapshots ride the turn's transaction; resume injects the snapshot.
4. **The context-budget warning**: the engine estimates prompt size each
   round and warns the Narrator inside the dynamic tail near the ceiling;
   `end_scene(context_limit_reached)` becomes a legal reason.
5. **The full `next_scene_registration`**: engine-validated payload, error
   + re-call on missing fields; a `new_stub` walks the standard
   `create_sublocation` workflow (query-first rule).
6. **Both LLM clients** (the standing lesson): fake markers for every new
   tool (`!who`, `!callchar <id>`, `!join <id>`, `!leave <id>`,
   `!movechar <id> <subloc>`, `!goals …` — or whatever fits the existing
   marker grammar); the real client's narrator call gains the new tool
   descriptions (stable strings).
7. **The standing triad** for every new commit window: fault point(s) +
   harness cycle(s) + verify block(s) continuing at 4r, CYCLES=25 at
   $0.00 (the harness now runs a final convergence pass — keep it green).

**Named for later (NOT this session):** week 19's audit + packaging; the
onboarding page UI (owner builds from Figma); backpacks +
`transfer_object` (V2); weather (V1.5); group fan-out (V2 — the set type
is the only V1 obligation).

## Machinery to REUSE (never fork)

- `engine/scene-turn.ts`'s `runCall` + `createToolStage` — the streaming,
  gating, and staging seams; the new loop re-plans instead of iterating a
  fixed list.
- The mid-call query executor seam (`queries` on LlmCall) — charactercall
  is the same shape with a C-Module call inside; the GM's `wikiquery` and
  `runWikiquery` are the model for scene-side `query_wiki`.
- The presence gates (`engine/chat.ts` availability, markers'
  `in_scene` checks) for make_character/character_leave/move_character;
  `character.location_changed` is move_character's event (actor = the
  scene, not world-cron — mind verify 4p's actor check: it will need a
  deliberate extension for the narrator-driven move).
- The eager+fused-re-check+natural-key triad (`engine/gm-chat.ts`
  follow-ups + `engine/markers.ts` click are the freshest examples).
- The fake's marker grammar + the group-router tail rule
  (`lastIndexOf('User:')`) for new scripted tools.

## Environment notes (the MacBook)

- Run EVERYTHING under Homebrew node@24:
  `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"` (default node 26
  violates the engines pin). A cold or LOADED vitest run may flake with
  fork-worker timeouts — re-run on a quiet machine before diagnosing
  (bit us again this session during a concurrent harness run).
- Launch configs (`.claude/launch.json`): `weltari-fake` /
  `weltari-masking` / `weltari-real` on port 7777 (DBs under
  `$TMPDIR/weltari-*`; `rm -rf` one for a fresh world). **`weltari-real`
  defaults `WELTARI_IMAGE_BACKEND=stub`** — flip to `openrouter` ONLY for
  a deliberate image demo; paints are the dominant cost every time.
  `weltari-real` currently holds the seeded Brackwater world (Sela, Odo,
  3 places) from the UX-contract demo — a good agentic-scene testbed.
- **An OLD world's first boot on ≥ this build sends one GM catch-up line
  per historical resolution** (the follow-up boot sweep healing
  pre-contract resolutions) — expected, by design, real-model cost a few
  cents per line; wipe the world if you want silence.
- After ANY protocol bump: `npm run build --workspace @weltari/web`
  before a browser demo — the served dist silently drops unknown events.
- Push: `git push origin main` over SSH (`~/.ssh/github`); run it and let
  me approve, or hand me the command. **Check first whether the
  UX-contract commits are pushed** (through `ce672c7` + the close-out
  commit).
- Untracked-by-design at repo root: `docs/code-tour/*_zh.md`,
  `summarise/`, `transfer.md` — never commit them (beware `git add docs`).

## Notes carried over (they save real money)

- **Measured costs:** chat-class ≈ $0.002–0.017/call (the seed form was
  the priciest at ~$0.017). Scene-class narration with the full agentic
  loop will run several calls per user turn — estimate before the real
  demo and keep the loop count visible. Track EXACT spend via
  `GET https://openrouter.ai/api/v1/credits` deltas (UX-contract baseline
  closed at `total_usage` 24.153861).
- The fake/stub stack is the default everywhere; the kill harness must
  stay ZERO-cost (**25 fault points** + the final convergence pass; the
  verifier is at block 4q).
- **Real-model lessons:** wire any new toolset/behavior in BOTH
  `fake-client.ts` AND `openrouter-client.ts`; fake markers read only
  AFTER the last user line (the group-router rule); models act on durable
  mechanics when the fiction makes them explicit — DeepSeek respected the
  interview gate and closed the marker loop unprompted in earlier weeks.
- **Carried debts (week-19 audit list):** fixture-trio registry base on
  blank worlds; next-boot DM roster; `profiling_enabled` defaults OFF;
  compaction/CACHE/marker/CRON knobs Config surface; boot-time
  `update_check` 404 in dev worlds; position bubbles render only after a
  character's first movement event.
- ⚠️ **Key rotation** remains the standing owner task (external usage
  this gap was $0.00 — the task still stands).

## Success criteria to demonstrate (proposal — confirm at session start)

(a) **The Narrator drives the turn**: on the fake at $0, one user input
produces a Narrator round that calls `determine_who_next` →
`charactercall` → narration reacting to the reply, all inside ONE turn
envelope; the turn budget provably cuts a scripted ping-pong.
(b) **Characters join, leave, and move by tool**: `make_character` /
`character_leave` / `move_character` flow through the presence gates
(a reserved character is skipped by CRON movement and chat presence shows
in_scene; a leave frees them) — invariant tests + browser demo.
(c) **Goals persist**: `update_goals` snapshots ride the turn transaction;
a server restart mid-scene resumes with the exact subgoal state (kill
cycle + byte-stable prefix tests for the goals block).
(d) **The full registration**: `end_scene(new_scene_available)` without a
valid `next_scene_registration` is refused with the reason and the
Narrator re-calls; the registered payload opens the next scene as a real
continuation (brief_history + carried_goals in its context).
(e) **The context warning**: a (test-rigged) small budget triggers the
warning in the dynamic tail and `context_limit_reached` closes legally.
(f) Fake at $0 for everything; ONE real-provider scene of a few agentic
turns on the Brackwater world (budget-estimated first).
(g) Stub/fake defaults: `npm run gate` exit 0 + `CYCLES=25` harness green
at $0.00 incl. new fault points; idle RSS < 170 MB; spend within budget.

## Budget (owner)

Total real-provider budget for the session: **$[OWNER: fill in — the UX
contract used $0.031; an agentic scene runs several calls per turn, so a
real demo of a few turns likely lands $0.10–0.30]**.

## Process rules (unchanged)

- Small conventional commits; `npm run gate` exit 0 before anything is
  called done; tests + docs page in the same commit.
- Never modify the spec/session documents in `docs/` — spec edits need
  fresh owner authorization every time; ask before any.
- Modifying existing `tests/invariants/` files needs my `invariant-change`
  label — add new invariant tests freely.
- Zero new deps expected; versions exact-pinned; secrets only via env.
- After each milestone-sized step, summarize plainly what exists and
  what's next.
- **At session end: write the Week 19 Kickoff Prompt** (verification &
  close-out — the audit list above plus everything the map still owes).
