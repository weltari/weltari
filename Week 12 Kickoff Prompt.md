# Week 12 Kickoff — Milestone 6 part 4: the social surfaces (paste this to start the session)

Build the fourth and final part of Milestone 6 for Weltari in this repository (`D:\devproj\weltari`, remote `https://github.com/weltari/weltari`). Milestones 1–5 plus M6 parts 1–3 are complete: crash-safe engine + ledger, the VN Scene page with the full narrator tool surface, the living fog map, the in-scene creation loop, the Weltari Chat DM core, and since week 11 (`docs/week11-results.md`) the character-led `startscene` (a REAL character negotiated the place and fired the tool itself), proactive CRON DMs with the growing backoff + 3-unanswered freeze (kill-harness-proven, both clocks stamped), the `wikiquery`/`sessionquery` escalation on the proven queries seam, and the read-only Wiki page — all at $0.03 of a $1.00 budget. I am not a professional developer — explain plainly, recommend, and let me decide only where a genuine value judgment remains.

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index.
2. `docs/week11-results.md` — what part 3 proved, the owner rulings of
   2026-07-10 (real-time CRON + game-day stamps, skips suppress CRON and
   refresh random events, freeze = durable event with the Telegram notice
   deferred to THIS week, expiry notices are hardcoded injected text), and
   the week-12 notes: the character fires startscene eagerly when IT
   proposes the meeting — the invitation TTL/expiry machinery is what makes
   that safe, and it lands this week.
3. Rev 4 §8 (`docs/Weltari V1 - Architecture & Structure (Rev 4).md`) —
   Groups: the Group-chat Narrator contract (NO NARRATION, routes turns
   only, engine-enforced turn budget, no CRON into groups); §12 the Camera
   feed (CRON-driven, viewer-only, acquaintance delivery, 10-posts-per-skip
   ceiling, two-sided memory writes through mailboxes); §13 the Gateway
   (eager pushes of CRON DMs only, dedup'd return path, the 3-unanswered
   freeze notice); §7 startscene's invitation TTL (expiry entry in memory,
   character complains next trigger, presence released by a hardcoded
   routine).
4. §10 backstops + §16 for the Proposal pipeline (wiki manual edits + the
   optional review-writes toggle).
5. `docs/Coding Guide/AI Coding Guide.md` — A11 fences, B6/B7 (gateway
   validation), C2/C7, D8 (deps: ask first — the gateway may need grammY
   wiring beyond the existing echo).

## Scope (recommended split — adjust with me at session start)

1. **startscene invitation TTL/expiry** (§7 — the week-11 carry-over that
   makes character-fired scenes safe): a character-fired scene the user
   never enters expires after a TTL; on expiry the scene closes, presence
   releases (the hardcoded routine), and a hardcoded memory/prompt entry
   ("the user wasn't there…") is injected so the character complains on its
   next trigger (owner ruling 2026-07-10: never an extra LLM call to phrase
   it). New outcome events get the standing natural-key triad.
2. **Group chats** (§8): user-started only; the Group-chat Narrator routes
   turns (`character_call` / `determine_who_next` / `ENDSUBSESSION`), NO
   narration, engine-enforced turn budget per user turn; characters cannot
   fire group chats and CRON never posts into them. The /chats page grows a
   group view (UI Spec §2.4).
3. **The Feed/Camera surface** (§12, UI Spec §2.5): CRON picks 3–4
   characters per fictional day to post about something they experienced
   (10-posts-per-skip ceiling, freshest window survives); acquaintance
   delivery (same-session rule); like/comment reactions as skill-triggered
   decisions; memory writes two-sided through mailboxes; `origin: social`
   CACHE entries. Viewer-only in V1.
4. **Gateway push of proactive DMs** (§13): the Telegram bridge (the echo
   connector exists) pushes eagerly-generated CRON DMs for subscribed
   characters; the return path persists into the SAME conversation_id
   (dedup'd on messenger message ids); the frozen-thread hook fires the
   hardcoded "X is waiting for you to reply" notice off `chat.thread_frozen`
   (owner ruling 2026-07-10: Weltari Chat itself shows nothing).
5. **Wiki manual edits + the review-writes toggle** (§10/§16, UI Spec
   §2.6): user edits to sublocation wikis from the Wiki page; the optional
   config toggle routing World-Agent wiki commits through the Proposal
   pipeline.

This is likely MORE than one week — at session start, pick with me which
slices are week 12 and which spill to a part 5. My recommendation: 1 + 2 +
4 this week (they complete the chat story), 3 + 5 next (they open the
social/authoring story) — but the split is yours.

**Named for later (NOT this milestone):** the real memory store +
`memoryquery` (M7), the GM agent (cold-boot onboarding, Proposal-gated
authoring, user profiling), objects/backpacks, characters as full
independent subagents in scenes.

**Owner decisions to settle at session start:**
- The week-12/part-5 split (above).
- Invitation TTL base in V1: real minutes/hours (env-tunable, consistent
  with the CRON DM ruling) — recommendation: yes, real-time with the
  game-day stamped on the expiry entry, same V2 bridge as outreach.
- Group-chat turn budget N (engine-enforced characters-per-user-turn) —
  recommendation: 3 in V1, env-tunable.
- Gateway scope: is YOUR Telegram bot configured for a real push demo, or
  do we prove the push through the connector conformance suite + a local
  fake bridge only?
- Budget (below).

## Notes carried over from Week 11 (read these — they save real money)

- **Measured costs:** a real chat DM turn ≈ $0.003; a proactive fire ≈
  $0.003–0.005 (content quality is excellent — fires ground themselves in
  CACHE + goals unprompted); DeepSeek narrator turns ≈ $0.01–0.03; a
  backdrop ≈ $0.03–0.05 (flash); Flow-A edits ≈ $0.24 (pro model — never
  retry flash for edits). Feed posts are chat-class.
- Estimate before any batch >10 calls; report the running total each
  summary; track EXACT spend via `GET https://openrouter.ai/api/v1/credits`
  deltas immediately before and after every real run. ⚠️ The key is SHARED
  (~$0.0025 external usage appeared again between weeks 10 and 11).
  **Rotate the OpenRouter key** (owner task, standing since M5) — if real
  calls suddenly 401, ask me.
- The fake/stub stack is the default everywhere; real backends only when
  I've set the env. The kill harness must stay ZERO-cost — whatever groups/
  Feed/gateway add, fakes drive it (`WELTARI_FAKE_LLM=1`).
- The proactive-DM machinery to REUSE (never fork): `engine/outreach.ts`
  (eligibility folds), `ledger/handlers/proactive-dm.ts` (the eager-
  generation fire), `nextIntervalOccurrenceIso` (epoch-aligned cadences),
  `chat.thread_frozen` (the gateway notice hook), the fused-idempotency
  triad pattern (`mid_proactive_dm` is the freshest example). The Feed's
  daily CRON should follow the same shape.
- The DM engine's nudge loop, presence projection (WORLD-scoped since
  week 11 — the da36044 fix), idle sweep and `conversationState` are in
  `apps/server/src/engine/chat.ts`; the conduct skill (`CHAT_CONDUCT_SKILL`)
  teaches negotiation + V1 limits — extend it for groups, don't replace it.
- Character-fired startscene behavior to remember: the character fires
  eagerly when IT proposes the meeting (week-11 finding) — correct per §7's
  invitation model, but slice 1 (TTL/expiry) is what makes an unanswered
  fire safe; until it lands, an unentered character-fired scene sits open.
- Pre-existing nit, not a regression: the boot-time `update_check` parks on
  a 404 against the release URL in dev worlds.
- Windows dev box: preview viewport can collapse to 0×0 (`preview_resize`);
  browser clicks via `preview_eval` dispatch; the screenshot tool times out
  on animating pages — verify with DOM samples + fetching `/v1/images/*`.
  Launch configs: `weltari-fake` / `weltari-masking` / `weltari-real`
  (add env overrides by spawning `apps/server/dist/main.js` manually, the
  week-11 demos show the pattern).
- Git pushes to main: run the push and let me approve, or hand me the
  command. Check first whether the week-11 commits are pushed.

## Success criteria to demonstrate (proposal — confirm at session start once the split is settled)

(a) **Invitation expiry:** a character-fired startscene the user never
enters expires (short env TTL): the scene closes, presence releases, the
hardcoded absence entry lands in the character's memory, and its NEXT
trigger (a DM) makes it complain in character — real backend once,
harness-proven idempotent.
(b) **A group chat lives:** user starts a group with ≥2 characters; the
Group-chat Narrator routes turns with ZERO narration text of its own; the
engine cuts it off at the turn budget; `ENDSUBSESSION` / user exit closes
it with exactly one reflect pass per participant (fake-driven; one real
round once).
(c) **Gateway push:** a proactive CRON DM reaches the messenger bridge
eagerly (real Telegram if configured, else the conformance fake), carries
the SAME content as the thread, and a webhook redelivery does NOT twin the
return message (dedup on messenger ids). The frozen-thread notice fires off
`chat.thread_frozen` as hardcoded text.
(d) **Feed day one** (if scoped this week): a time skip generates ≤ ceiling
posts from 3–4 characters, delivered by acquaintance, rendered on the Feed
page; reactions write two-sided memory through mailboxes ($0 fake-driven;
one real post batch once).
(e) **Wiki manual edit** (if scoped this week): an edit from the Wiki page
becomes durable with actor provenance; with the review toggle ON the same
edit routes through a Proposal and applies only on my approval.
(f) Stub/fake defaults: `npm run gate` + `CYCLES=25` harness green at $0.00
incl. new fault points; idle RSS < 170 MB; spend within budget.

## Budget (owner)

Total real-provider budget for the week: **$[OWNER: fill in — week 11 used
$0.03 of $1.00; ≈$9.84 remains on the key; chat-class turns ≈ $0.003 make
even all five demo criteria likely under $0.30]**. Fake/stub remains the
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
