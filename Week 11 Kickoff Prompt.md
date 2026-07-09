# Week 11 Kickoff — Milestone 6 part 3: Weltari Chat, part two (paste this to start the session)

Build the third part of Milestone 6 for Weltari in this repository (`D:\devproj\weltari`, remote `https://github.com/weltari/weltari`). Milestones 1–5 plus M6 parts 1–2 are complete: crash-safe engine + ledger, VN Scene page with the full narrator tool surface (now with mid-call gate feedback — a refused tool call returns to the model as an ERROR and self-corrects in one turn), the living fog map, the in-scene creation loop, and since week 10 the Weltari Chat DM core (`docs/week10-results.md`): durable conversations on the ONE event stream, the presence rule, the CACHE store first slice (latest-per-origin catch-up), `reflect_chat` exactly-once, the `startscene()` bridge (proven on real DeepSeek end-to-end: free-text place → parentless stub + backdrop + map tile in one turn), the `/chats` page, and the World-Agent subwiki pass — all at $0.19. I am not a professional developer — explain plainly, recommend, and let me decide only where a genuine value judgment remains.

## The owner ruling this week is built around (2026-07-09)

**startscene must be conversational and character-led, not a button.** The
user asks in chat ("should we meet?"); the CHARACTER reacts with
intelligence — asks what's missing ("when?", "where?", "what do you want to
do?"), or accepts what the user already volunteered — and then fires its
OWN `startscene` tool (Rev 4 §7/§8, as always documented). The week-10
"Meet in a scene" button was an unfinished slice, not the feature. The tool
plumbing already exists and is fake-proven (`!startscene <place-slug>`);
what's missing is the negotiation behavior in the chat skill text and a
real-backend proof of a character-fired startscene.

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index.
2. `docs/week10-results.md` — what part 2 proved, measured costs (a real
   chat DM turn ≈ $0.003 — the cheapest class yet), and the week-11 notes:
   the real model handles the chat toolset first try; free-text places
   resolve SEMANTICALLY to existing sublocations (pick genuinely novel
   names when a demo needs a create); character-fired startscene not yet
   observed on a real backend.
3. Rev 4 §8 (`docs/Weltari V1 - Architecture & Structure (Rev 4).md`) —
   Proactive (CRON) messaging: eager generation (the push IS the message),
   unanswered-outreach counters, the 3-per-thread freeze; §7 startscene's
   full contract (expiry entry in memory, character complains next trigger);
   §11 CACHE + the query escalation ("latest-per-origin instantly; escalate
   to scene-query → session read for specifics").
4. §10 + §16 for the Wiki surface (provenance, the optional review toggle
   is config, NOT this week); UI Spec §2.6 (Wiki page stubs) and §2.4
   (frozen-thread state).
5. `docs/Coding Guide/AI Coding Guide.md` — A11 fences, B6 double gate,
   C2/C7, D8 (deps: ask first).

## Scope (recommended split — adjust with me at session start)

**Weltari Chat, part two — the living side (owner-directed, 2026-07-09):**

1. **Character-led startscene (the ruling above).** Chat skill text that
   teaches the negotiation (gather place — existing or free text — before
   firing; suggest meeting when the user wants to DO something); the web
   button demoted or removed (owner decision below). Criterion: a REAL
   character-fired startscene from a natural conversation.
2. **Proactive CRON DMs** (Rev 4 §8): a scheduler-driven ledger job picks a
   character (random in V1) and eagerly generates a DM — committed to the
   log + CACHE at fire time, arriving over the stream like any message.
   Unanswered-outreach tracking: each proactive DM records as unanswered;
   retries at natural re-ask intervals; after 3 unanswered the thread
   FREEZES (no further proactive sends) until the user replies. Cadence
   env-tunable (the demo needs minutes; real play wants game-day rhythm).
   New natural-key outcome events get the fused idempotency re-check +
   interleaved test + `verify-consistency` entry + fault point (the
   standing pattern — `mid_reflect_chat` is the freshest example).
3. **Chat query escalation** (Rev 4 §11): `wikiquery` + `sessionquery` as
   read-only mid-call executors on the chat toolset — reuse the PROVEN
   `LlmCall.queries` seam (week 9/10), never reinvent. sessionquery is
   participation-gated (a character reads only sessions it was in).
   `memoryquery` can wait for the real memory store (M7) if it would be a
   stub — name it if deferred.
4. **The Wiki page** (UI Spec §2.6, read-only slice): browse sublocation
   wikis from the `subwiki.updated` projection (latest per sublocation
   wins, provenance shown — "written after scene X") — the week-10 camp
   entry is already in the real world's log to render. Manual edits and the
   review-writes toggle stay M6 part 4 / config.

**Named for part 4 (NOT this week):** group chats (the Group-chat
Narrator), the Feed/Camera surface, wiki manual edits, gateway push of
CRON DMs.

**Owner decisions to settle at session start:**
- **The button's fate:** remove "Meet in a scene" entirely (the character
  path is the feature), or keep it hidden behind dev mode as a testing
  shortcut while the conversational path matures?
- **CRON DM trigger base in V1:** real-time cadence (simple, env-tunable
  minutes/hours) or fictional game-time (Rev 4's game-day stamps — but the
  world clock only moves on manual skips today, so pure game-time means no
  DMs unless you skip). Recommendation: real-time cadence for V1, game-day
  stamps recorded on the outreach entries so V2 can switch.
- **Frozen-thread UX:** silent freeze (Rev 4 minimum) or a visible "Elias
  is waiting for you to reply" hint in the thread?
- Budget (below).

## Notes carried over from Week 10 (read these — they save real money)

- **Measured costs:** a real chat DM turn ≈ **$0.003** (measured exactly);
  DeepSeek multi-step narrator turns ≈ $0.01–0.03; a backdrop ≈ $0.03–0.05
  (flash); Flow-A edits ≈ $0.24 (pro model — never retry flash for edits).
  Proactive DMs are chat-class: even a generous demo cadence is pennies.
- Estimate before any batch >10 calls; report the running total each
  summary; track EXACT spend via `GET https://openrouter.ai/api/v1/credits`
  deltas immediately before and after every real run. ⚠️ The key is SHARED
  (~$0.005 external usage appeared between weeks 9 and 10). **Rotate the
  OpenRouter key** (owner task, standing since M5) — if real calls suddenly
  401, ask me.
- The fake/stub stack is the default everywhere; real backends only when
  I've set the env. The kill harness must stay ZERO-cost — whatever CRON
  DMs add, fakes drive it (`WELTARI_FAKE_LLM=1`).
- Free-text place resolution is semantically smart (week-10 finding): the
  Narrator reused The Round Pond for "the reed cutter's jetty". When a demo
  needs a CREATE, pick genuinely novel places (the charcoal camp worked).
- The chat engine's nudge loop, presence projection, idle sweep
  (`WELTARI_CHAT_IDLE_MINUTES`), and `conversationState` projection are in
  `apps/server/src/engine/chat.ts` — CRON DMs should reuse them, not fork.
- Pre-existing nit, not a regression: the boot-time `update_check` parks on
  a 404 against the release URL in dev worlds.
- Windows dev box: preview viewport can collapse to 0×0 (`preview_resize`);
  browser clicks via `preview_eval` dispatch; the screenshot tool times out
  on animating pages — verify with DOM samples + fetching `/v1/images/*`.
  Launch configs: `weltari-fake` / `weltari-masking` / `weltari-real`.
- Git pushes to main: run the push and let me approve, or hand me the
  command. Check first whether the week-10 commits are pushed (they were at
  session end).

## Success criteria to demonstrate (proposal — confirm at session start)

(a) **Character-led startscene on the real backend:** in the browser, a
natural conversation — "should we meet?" with details missing — where the
character asks for what it needs and then fires `startscene` ITSELF; the
scene opens (existing place or the create workflow) and the chat closes
with reason `startscene`. No button involved.
(b) **A proactive DM arrives unprompted** (short env cadence, real backend
once): committed to log + CACHE at fire time, rendered in the thread like
any message; a restart never duplicates it (natural key, harness-proven).
(c) **The freeze rule:** after 3 unanswered proactive DMs the thread stops
receiving them (fake-driven); one user reply resets the counter and
proactive sends resume.
(d) **Query escalation live:** a DM question about a past scene or a known
place triggers `sessionquery`/`wikiquery` mid-call and the reply visibly
uses the result (real backend once; the dev trail shows the query).
(e) **The Wiki page** renders the charcoal camp's week-10 entry with
provenance, and updates live when a new scene-end writes an entry.
(f) Stub/fake defaults: `npm run gate` + `CYCLES=25` harness green at $0.00
incl. new fault points; idle RSS < 170 MB; spend within budget.

## Budget (owner)

Total real-provider budget for the week: **$[OWNER: fill in — week 10 used
$0.19; ≈$8.48 remains on the topped-up key; chat-class turns ≈ $0.003 make
even criterion (b)+(d) demos likely under $0.25]**. Fake/stub remains the
default everywhere — real backends run only when I've set the env.

## Process rules (unchanged)

- Small conventional commits (one logical change each); `npm run gate` must
  exit 0 before anything is called done; tests + docs page in the same
  commit.
- Never modify the spec/session documents in `docs/` (Brief, UI Spec, Stack
  Session/, Coding Guide/, Rev 3/Rev 4, ui-wireframes/).
- Modifying existing `tests/invariants/` files needs my `invariant-change`
  label — add new invariant tests freely.
- Zero new deps expected without asking; versions exact-pinned; secrets only
  via env.
- After each milestone-sized step, summarize plainly what exists and what's
  next.
