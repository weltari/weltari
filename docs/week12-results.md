# Week 12 results — M6 part 4: the social surfaces, part one

Scope settled at session start (owner): **slices 1 + 2 + 4** — invitation
expiry, group chats, the Telegram gateway push — plus the UI renames and the
i18n scaffold. Slices 3 (Feed) and 5 (wiki manual edits + review toggle)
spill to **M6 part 5** as recommended.

All scoped success criteria PASS. Real-provider spend:
**$0.0333 of the $2.00 budget** (exact, from OpenRouter credits deltas:
23.348390 → 23.381688). ⚠️ The session baseline sat **$0.186 above**
week-11's closing number — much larger external usage on the SHARED key
than the ~$0.0025 seen before. **Rotate the key** (standing owner task,
now urgent).

## The owner rulings this week was rebuilt around (2026-07-10/11)

The session opened with a fundamental design ruling that reshaped the time
structure (recorded in the Rev 4 spec itself with explicit owner
authorization — commits `33f786a`, `8753230`, `e63ac9a`):

- **No background world evolution.** The fictional clock NEVER advances on
  real time; only events the user is present for move it (manual skips,
  scene-end acceleration, entering a later-scheduled marker). Rev 4 §16's
  "passive advance" paragraph is dead. Storytelling and a self-evolving
  world pull in opposite directions — the user must be present to be told
  the story. V2's future-event list needs re-ruling before V2.
- **ALL CRON rides the world clock**: occurrences are game-time boundaries
  fired only when the clock advances (a paused world sends nothing); only
  world-inert maintenance may run on wall time. Proactive DMs are ON by
  default (1440 game-min cadence, `WELTARI_CRON_DM_GAME_MINUTES`); a
  character may DECLINE a fire via the explicit `stay_silent` tool (neutral
  prompt); the pick is 5 salted hash attempts over ALL characters — the few
  available ones are never forced to carry every fire.
- **The invitation window is the character's own decision**, in GAME time:
  `wait_hours` is a REQUIRED `startscene` parameter (never an env default);
  a call without it gets a hardcoded correction and the reply regenerates
  (critical-tool ceiling 10, then rollback + the `chat.notice` red line).
  Expiry is judged LAZILY — while the user is away the clock is paused and
  the character has fictionally waited no time at all.
- **The scene idle timeout is removed**: an abandoned scene stays paused
  indefinitely and ends lazily (end-before-open / explicit end). Returning
  is a true mid-sentence resume.
- Group turn budget default **3**, user-tunable (`WELTARI_GROUP_TURN_BUDGET`).
- Social posts default **2 per game day** (spec updated; the Feed itself is
  part 5). Gateway onboarding is a GM unread message, never cold boot (the
  GM agent is M7 — until then, config panel only).
- UI: the "Scene" tab is **"Play"**; the splash's "Open Map" is
  **"Go Somewhere…"** (the map is a tool, never the entrance). The frontend
  is multilingual-READY (typed `en` catalog + `t()`, zero deps, no packs yet).
- Budget: $2.00.

## What was built (9 code/spec commits)

- **Spec edits** (owner-authorized, §1/§4.2/§6/§7/§8/§12/§13/§16): the
  time-structure rulings above, inked into Rev 4.
- **Protocol 0.13.0** (`248a4be`): `scene.started` optional `invitation`
  (character-chosen `wait_hours` + engine-stamped `expires_at_game`);
  `scene.expired` (natural key scene_id); `chat.notice` (the red line).
- **startscene wait_hours + the correction loop** (`a2f47a7`): gate-1
  rejection → hardcoded `## Correction` → the whole reply regenerates
  (nothing committed yet — retries replace); ceiling 10 → rollback +
  `chat.notice`. Fake scripts: `!startscene-nowindow` / `!startscene-stubborn`.
- **Invitation expiry** (`eb3022f`): `engine/invitation.ts` — the lazy sweep
  after every clock advance + at boot (recovery path = startup path); ONE
  transaction appends `scene.expired` + the HARDCODED day-stamped absence
  CACHE entry behind a fused re-check. Presence releases like scene.ended;
  the character complains on its next trigger. Standing triad: fault point
  `mid_invitation_expiry` + harness cycle + verify block 4j.
- **Proactive DMs retargeted to the world clock** (`db02500`): the week-11
  "both clocks stamped" bridge paid off — only the trigger changed. The
  real-time interval is gone; main's advance-time wrapper enqueues the
  newest ≤3 crossed boundaries (`intervalOccurrencesBetween`); backoff +
  freeze run on the game axis unchanged.
- **Group chats** (`e8c5e8b`, protocol 0.14.0): user-started only; the
  Group-chat Narrator (kind `group_route`, data-only route/endsubsession)
  routes turns and NEVER narrates — its text is dropped un-surfaced; the
  ENGINE enforces the turn budget; a range close fans out exactly ONE
  reflect_chat per member (keys carry the character id). Mara the
  Ferrywoman joins the fixture as the second DM-able character (chat-side
  only). /chats grew the group view. + the member resolver fix (`39a2405`,
  the week-12 real-backend finding: routers return "mara" for `char:mara`).
- **The gateway chat bridge** (`1646e47`, Rev 4 §13): the messenger is a
  VIEW of Weltari Chat. `chat.outreach_recorded` on the LIVE bus pushes
  `<Name>: <the SAME committed text>`; `chat.thread_frozen` pushes the
  hardcoded "waiting for you to reply" notice (Weltari Chat shows nothing);
  inbound routes into the SAME conversation_id (request_id = the messenger
  message id, on top of the gateway_inbound UNIQUE dedup) and the reply
  echoes back. Subscription V1: messaging the bot once IS subscribing. The
  M3 scene echo is retired. grammY unchanged — zero new deps.
- **Web** (`29590d3` + slice-2 web): scene.expired + the red-line notice
  render; Play / Go Somewhere… renames; `src/i18n.ts`; the groups section.

## Success criteria

### (a) Invitation expiry — PASS (real backend + harness-proven)

Real DeepSeek, the week-10/11 world:
- *"you pick the spot, and tell me honestly how long you are willing to
  wait"* → Elias fired `startscene` FIRST TRY with
  `{place: "Elias's workshop above the Rainy Inn", wait_hours: 3}` — his
  own window, no correction round needed; the engine stamped
  `expires_at_game 10:00`.
- The user never entered; a 12 h skip crossed the window →
  `scene.expired` + the absence entry (*"I waited at Elias's workshop…
  the User never came. After 3 hours I gave up and left (day
  2000-01-01)."*), presence released.
- The NEXT trigger (an apologetic DM) produced the in-character complaint:
  *"Gave up an hour ago. I'm down at Marta's bar now, nursing a sour ale.
  Want to try again — here, or somewhere else?"*
- Kill-safety: harness cycle `mid_invitation_expiry` (kill inside the
  sweep → the BOOT sweep converges exactly once; pair atomicity = verify
  block 4j).

### (b) A group chat lives — PASS (fake-driven + one real round)

- Fake: the scripted router ping-pongs deliberately; the ENGINE cut it at
  exactly 3 member turns per user line; `!endsub`/exit closed the range
  with exactly one reflect_chat job per member; both reflected over the
  same range without blocking (the per-character idempotency fix).
- Real round (DeepSeek router + members): the router routed by bare name
  ("mara") — the new resolver landed it on `char:mara`; Mara answered in
  HER voice, grounded in her memory core (*"practically married by river
  standards"*, the eels debt), Elias returned the teasing, 3 turns then
  yield. Exit → both members' reflections committed exactly once, each in
  character. ZERO narration text anywhere in the transcript.

### (c) Gateway push — PASS (conformance fake; real bot validated, live push = owner step)

- Bridge tests: the pushed text is byte-identical to the thread message
  (prefixed `<Name>: `); the frozen notice is the hardcoded string; no
  subscriber → no push; a webhook REDELIVERY produced exactly ONE user
  line in the SAME `conversation_id` and exactly one echoed reply.
- The owner's test bot (`@xihsontestbot`) validated live via getMe; the
  token lives in env only (never committed; the bot is disposable). The
  end-to-end phone demo needs one message from the owner to the bot (that
  message IS the V1 subscription) — instructions in the session summary;
  the machinery is identical to the conformance-proven path.

### (f) Stub/fake defaults, harness, RSS, spend — PASS

- `npm run gate` exit 0 (format, 0-warning lint, typecheck, **446 tests**,
  knip).
- Kill harness **CYCLES=25 over 15 fault points** incl. the new
  `mid_invitation_expiry` and the game-time-driven `mid_proactive_dm`
  rework: zero duplicate/lost events, zero corrupted images, zero torn
  flips, resume exact — **$0.00**.
- Idle RSS of the real server: **118.5 MB** (< 170).
- Spend **$0.0333 / $2.00**.

## Spend log (budget $2.00; baseline `total_usage` 23.348390)

| What | Est. cost | Running total |
| --- | --- | --- |
| All builds, tests, 3 harness rotations, fake demos | $0.00 | $0.00 |
| (a) negotiation + startscene fire + expiry + complaint (4 real turns + fan-out) | ~$0.017 | ~$0.017 |
| (b) two real group rounds (router + member calls) + 2 reflects | ~$0.016 | **$0.0333** |

(Exact total = 23.381688 − 23.348390 from `GET /v1/credits`.)

## Notes for M6 part 5

- **Remaining part-4 surface → part 5:** the Feed/Camera page (§12, daily
  CRON now trivially rides the world-clock replay — default 2 posts/game
  day) and wiki manual edits + the review-writes toggle (§10/§16).
- **The live Telegram phone demo** is one owner message away (the bot token
  is disposable — delete the bot after).
- The group-router works but is chatty on a narrator-class model — §16
  suggests router-class models per function; per-function routing config is
  future Config work.
- Proactive DMs are ON by default now but fire only when the clock moves —
  a demo world shows them after any skip/scene-end (freshest ≤3 boundaries).
- ⚠️ **Rotate the shared OpenRouter key** — $0.186 external usage between
  sessions (an order of magnitude above previous leaks).
- Pre-existing, unrelated: the boot-time `update_check` 404 in dev worlds.
