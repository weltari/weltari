# GM Proposal UX Contract Kickoff — the dedicated slot between weeks 17 and 18 (paste this to start the session)

Build the GM proposal UX contract for Weltari in this repository
(`/Users/xihson/devproj/weltari` on the MacBook, remote
`git@github.com:weltari/weltari.git`). **Milestones 1–6 are complete and
proven**, and since week 17 (`docs/week17-results.md`) so is **M7 part 4 —
the living-world loop**: protocol 0.19.0 (the `marker.*` family +
`character.location_changed` + the `marker-click` command), the markers
table as a same-transaction projection, the 1–5 live invariant with lazy
game-time expiry and first-click-wins/second-joins, CRON world movement,
and the map's "!" pins + position bubbles. All proven on the fake at $0
(25 harness cycles over 24 fault points; verify blocks 4o/4p) and once on
real DeepSeek — which closed the loop UNPROMPTED by ending a marker scene
with a `follow_up_marker` of its own invention. Week 17 cost $0.0339 of
its $2 budget. I am not a professional developer — explain plainly,
recommend, and let me decide only where a genuine value judgment remains.

**THIS session is the standing owner ruling made real** (2026-07-11,
slotted 2026-07-17): the GM must work like a coding agent's tool loop.
This is a binding requirement that must land before week 19 closes V1 —
it has waited two weeks and the week-18 kickoff must NOT be written until
this session ends.

## The V1 completion map (owner rulings — carry forward weekly)

Weather is V1.5 (owner ruling); **backpacks are V2** (owner ruling
2026-07-16); every other Rev 4 §18 "In V1" item stays V1.

| Week | Scope | Rev 4 | Status |
| --- | --- | --- | --- |
| 14 | The real memory store | §11, §4.2 | ✅ done |
| 15 | The GM agent: Proposal pipeline, cold boot, consent-gated authoring, profiling + GDPR | §9, §16 | ✅ done |
| 16 | Objects (sublocation-only) | §7, §14, §17 | ✅ done |
| 17 | The living-world loop: markers + CRON movement + position bubbles | §14, §17 | ✅ done |
| **— (this prompt)** | **The GM proposal UX contract**: streamed GM prose, inline tool-call proposal blocks that settle in place, the durable tool-result turn feeding resolutions back to the GM, the chat-about-this signal | §9, §16 | |
| 18 | The agentic scene: `make_character`, `charactercall`, set-typed `determine_who_next` (V1: size 1), `character_leave`, `move_character`, scene-side `query_wiki`, storytelling goals → subgoals, the full `next_scene_registration` payload, the context-budget warning | §6 | |
| 19 | Verification & close-out: line-by-line audit of Rev 4 §18 + module contracts against the CODE, fix findings, packaging ship, handover refresh, key rotation confirmed — only then is V1 done | all | |

Already deferred (stays deferred): user Feed posting (V1.5), Mail, the
resolve loop, FEL/DES, multiplayer, inter-agent comms, object nesting,
backpacks + `transfer_object` (V2), weather (V1.5).

## The contract (the 2026-07-11 ruling, verbatim intent)

- **Target:** the GM STREAMS its prose (thinking never streamed), and a
  proposal appears as an INLINE tool-call block at its exact position in
  the conversation — e.g. the GM says "good idea — let me look at the
  existing characters first", runs its lookup, then emits the proposal
  block with Consent / Reject / "Chat about this" under it. When the user
  clicks, the hard-coded action runs, and **the outcome (success / denied
  / chat-about-this) is sent BACK to the GM as the tool call's result**,
  so the GM reacts to the verdict in its next turn. "Chat about this"
  signals the GM to stop proposing and listen.
- **Current (unchanged since week 15):** GM replies arrive whole (no
  streaming); pending cards render APPENDED at the end of the GM thread,
  not inline (and a resolved card disappears instead of settling in
  place); the resolution is durable but **never fed back into the GM's
  context** — its transcript fold reads chat messages only, so it does
  not know whether you consented unless you say so in text; "Chat about
  this" only prefills the input box client-side, no signal reaches the GM.
- **Engineering note:** a consent card can sit for HOURS (the user walks
  away), so the tool result cannot be delivered by holding the LLM call
  open the way a coding agent does. Implement it as a **durable
  tool-result turn**: `proposal.resolved` (or the chat-about-this signal)
  triggers a GM follow-up generation whose context carries the outcome as
  the tool call's result. The mid-call seam already exists for read tools
  (the GM's `wikiquery` runs inline today — that part already matches the
  target); streaming exists for scene narration (`onTextDelta` → the SSE
  stream) and only needs turning on + rendering for the GM thread.
- Relevant code: `apps/server/src/engine/gm-chat.ts` (the reply loop),
  `apps/web/src/pages/ChatPage.tsx` + `components/ProposalCard.tsx` (card
  placement), `docs/engine.md`/`docs/web.md` rows.

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index.
2. `docs/week17-results.md` — what part 4 proved, the harness findings
   (fail() orphans, fresh-vs-due markers), and the carried debts.
3. The contract section above + `Week 16 Kickoff Prompt.md` ⚠️ section
   (the original wording, still accurate).
4. Rev 4 §9 (the GM's jobs) + §16 (the Proposal pipeline) — the consent
   semantics this UX must surface, not change: nothing the GM says is
   durable until the user approves the card.
5. `docs/Coding Guide/AI Coding Guide.md` — B6, C2/C7, I5 (prompt-prefix
   byte stability — mind it when the GM's transcript fold gains
   tool-result entries), the events table stays append-only.
6. `docs/handover.md` if anything else is unclear.

## Scope (recommended — adjust with me at session start)

1. **GM streaming**: the GM's reply streams sentence-by-sentence into the
   GM thread over the existing SSE stream (`onTextDelta` → StreamBus —
   the scene-narration machinery, pointed at the GM conversation);
   display-only frames, never durable (B6).
2. **Inline proposal blocks**: a proposal renders at its exact position
   in the conversation flow (the transcript interleaves prose and
   tool-call blocks in order); a resolved card SETTLES in place (shows
   its verdict) instead of disappearing. Protocol bump if the wire needs
   a position/anchor (decide deliberately — the proposal.submitted event
   already sits at a log position between the chat messages).
3. **The durable tool-result turn**: resolving a card (Consent OR Reject)
   triggers ONE GM follow-up generation whose context carries the
   outcome as the tool call's result — the GM reacts to the verdict
   without the user typing. Kill-safe via the standing triad (a new
   fault point inside the follow-up commit window; natural key =
   proposal_id — exactly ONE follow-up per resolution, a kill-retry
   converges). Respect the group-router tail rule in the fake.
4. **The chat-about-this signal**: a real command/event that reaches the
   GM (not just an input prefill) — the GM's next turn knows the user
   wants to discuss, stops proposing, and listens. Same durable-turn
   machinery, different outcome value.
5. **Both LLM clients** (the standing lesson): fake markers for every new
   behavior; the real client's GM call gains streaming + the tool-result
   context.
6. **The standing triad** for every new commit window: fault point(s) +
   harness cycle(s) + verify block(s) continuing at 4q, CYCLES=25 at
   $0.00.

**Named for later (NOT this session):** the agentic scene (week 18 — its
kickoff gets written at the END of this session); the onboarding page UI
(owner builds from Figma); backpacks (V2); weather (V1.5).

## Machinery to REUSE (never fork)

- `engine/gm-chat.ts` — the GM reply loop + its mid-call `wikiquery`
  executor (already the tool-loop shape for reads).
- The scene-narration streaming path (`onTextDelta` → StreamBus → SSE
  `stream` frames) — GM streaming is the same seam, new consumer.
- `engine/proposals.ts` — submit/resolve stays UNTOUCHED; the UX work
  consumes `proposal.submitted`/`proposal.resolved`, never re-implements
  consent.
- The eager+fused-re-check+natural-key triad for the follow-up turn
  (`engine/markers.ts` click + `ledger/handlers/object-gc.ts` are the
  freshest examples); `sink.appendManyWithJobs` if the follow-up rides a
  ledger job.
- The fake's group-router tail rule (`lastIndexOf('User:')`) for any new
  scripted GM markers; `ProposalCard.tsx` + the pendingProposals fold in
  `apps/web/src/store.ts` for the inline rework.

## Environment notes (the MacBook)

- Run EVERYTHING under Homebrew node@24:
  `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"` (default node 26
  violates the engines pin). First cold vitest run after a reboot may
  flake with worker timeouts — re-run before diagnosing.
- Launch configs (`.claude/launch.json`): `weltari-fake` /
  `weltari-masking` / `weltari-real` on port 7777 (DBs under
  `$TMPDIR/weltari-*`; `rm -rf` one for a fresh world). **`weltari-real`
  defaults `WELTARI_IMAGE_BACKEND=stub`** — flip to `openrouter` ONLY for
  a deliberate image demo; paints are the dominant cost every time.
- After ANY protocol bump: `npm run build --workspace @weltari/web`
  before a browser demo — the served dist silently drops unknown events.
- Push: `git push origin main` over SSH (`~/.ssh/github`); run it and let
  me approve, or hand me the command. **Check first whether the week-17
  commits are pushed** (they were, through 90f7387 + this kickoff).
- Untracked-by-design at repo root: `docs/code-tour/*_zh.md`,
  `summarise/`, `transfer.md` — never commit them (beware `git add docs`).

## Notes carried over from week 17 (they save real money)

- **Measured costs:** chat-class ≈ $0.002–0.015/call. This session is
  chat-class only — GM streaming demos + a handful of follow-up turns;
  likely under $0.10 total. Track EXACT spend via
  `GET https://openrouter.ai/api/v1/credits` deltas (week-17 baseline
  closed at `total_usage` 24.123023).
- The fake/stub stack is the default everywhere; the kill harness must
  stay ZERO-cost (**24 fault points** now; the verifier is at block 4p;
  the harness's `fail()` kills its live server and `dbMarkerState` splits
  fresh/due — don't regress either fix).
- **Real-model lessons:** wire any new toolset/behavior in BOTH
  `fake-client.ts` AND `openrouter-client.ts`; fake GM markers read only
  AFTER the last user line (the group-router rule); models act on durable
  mechanics when the fiction makes them explicit — DeepSeek used
  `follow_up_marker` unprompted in week 17.
- **Carried debts (week-19 audit list):** fixture-trio registry base on
  blank worlds; next-boot DM roster; `profiling_enabled` defaults OFF;
  compaction/CACHE/marker/CRON knobs still lack their Config surface;
  boot-time `update_check` 404 in dev worlds; position bubbles render
  only after a character's first movement event.
- ⚠️ **Key rotation** remains the standing owner task (external usage
  between sessions was $0.0045 last gap).

## Success criteria to demonstrate (proposal — confirm at session start)

(a) **GM prose streams**: in the browser, a GM reply appears
sentence-by-sentence in the GM thread (fake `weltari-masking` shows the
window; once real); thinking never streams; stream frames stay
display-only (B6 — the durable message commits whole, as today).
(b) **Proposals are inline and settle in place**: the block renders at
its exact position between the GM's sentences/messages; after Consent or
Reject the card stays visible showing its verdict; a reload/replay
rebuilds the same interleaved transcript exactly (the fold is the truth).
(c) **The resolution feeds back**: after the user clicks Consent (and
separately Reject), the GM's next message REACTS to the verdict with the
user having typed nothing — driven by the durable tool-result turn;
exactly ONE follow-up per resolution (natural key; kill inside the new
fault window converges — the standing triad); works across a server
restart while a card sat pending (the hours-later case).
(d) **Chat-about-this is a real signal**: clicking it reaches the GM (a
durable signal, not an input prefill); the GM's next turn acknowledges
and stops proposing; the proposal stays pending and can still be
resolved later.
(e) Fake at $0 for everything; ONE real-provider pass of the full loop
(propose → stream → consent → the GM reacts).
(f) Stub/fake defaults: `npm run gate` exit 0 + `CYCLES=25` harness green
at $0.00 incl. new fault points; idle RSS < 170 MB; spend within budget.

## Budget (owner)

Total real-provider budget for the session: **$[OWNER: fill in — week 17
used $0.034; this session is chat-class only, likely under $0.10]**.

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
- **At session end: write the Week 18 Kickoff Prompt** (the agentic
  scene, Rev 4 §6) so the next session starts the same way this one did.
