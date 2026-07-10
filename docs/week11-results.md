# Week 11 results — M6 part 3: Weltari Chat, part two

All six success criteria PASS. Real-provider spend for the week:
**$0.0326 of the $1.00 budget** (exact, from OpenRouter's credits endpoint
deltas: 23.129315 → 23.161938). The session baseline sat $0.0025 above
week-10's closing number — small external usage on the SHARED key again
(the standing rotation task remains, see notes).

## Owner rulings this week was built around (settled 2026-07-10)

- startscene is conversational and character-led (2026-07-09); the web
  button survives only behind dev mode (`?dev=1`) as a testing shortcut.
- CRON DMs run on REAL time in V1 (env cadence); every outreach records the
  fictional game-day too, so V2's future-event list changes only the
  trigger, never the data. Characters never plan future sends in V1 — no
  scheduling tool exists; a game-clock jump never retro-fires CRON.
- Retry pacing: growing backoff (base ×2 ×4), then the 3-unanswered freeze.
- The freeze is a durable event and shows NOTHING in Weltari Chat (the
  unread state suffices); the hardcoded "waiting for you to reply" notice
  is the M6-part-4 Telegram-gateway push, hooked off that event.
- Scene-invitation expiry notices (when they land) are hardcoded injected
  text — never an extra LLM call. If a skip jumps past an event's entry
  window ("see you tomorrow!" but the user skipped 48 h), the event AND its
  marker expire; in V1 the character learns of the user's absence via that
  hardcoded memory entry and reacts on its next trigger (V2: it texts).
- When the in-game clock jumps from a USER event (scene-end acceleration,
  manual skip), all CRON planned inside the skipped span is skipped — and
  random map events should be REFRESHED afterwards (a character's position
  must not survive a 24 h skip unchanged unless a fresh roll lands it
  there). The map-CRON half of this is recorded for the week that builds
  world movement; this week's real-time DM cadence is untouched by skips.
- V1 limits reaffirmed and now taught in the conduct skill: characters
  refuse character-to-character interaction (no texting each other, no
  meetings without the user) and the user must be present in every scene.
- Budget: $1.00.

## What was built (5 commits)

- **Character-led startscene** (`6c1751d`): `CHAT_CONDUCT_SKILL` rides the
  chat stable prefix — the negotiation (gather the place, one question at a
  time, don't re-ask what the user volunteered), the firing rule (the
  character calls `startscene` ITSELF; the user cannot), and the V1 limits
  declined in-character (no char-to-char texting/meetings, no acting on the
  user's behalf). The bridge gained the one-active-scene transition (the
  debug-session carry-over): a scene still open is ended FIRST with full
  fan-out, then the open retries bounded; both the dev button and the
  character tool share it. "Meet in a scene" hides behind `?dev=1`.
- **Presence is world-scoped** (`da36044`, a real bug the new harness cycle
  exposed): a scene left open in ANY world holding the same character id
  kept it `in_scene` everywhere, silencing its DMs forever — the harness's
  cross-world probe scene was the live reproducer.
- **Proactive CRON DMs** (`3c51e70`, protocol 0.12.0): `chat.outreach_recorded`
  (natural key world + occurrence; stamped with BOTH clocks) and
  `chat.thread_frozen` (the durable gateway hook). A real-time env cadence
  (`WELTARI_CRON_DM_MINUTES`, default 0 = off; epoch-aligned boundaries,
  future-dated idempotent rows, serial group per world) drives the
  `proactive_dm` job: deterministic eligibility (presence available ∧ quiet
  thread or backoff due ∧ not frozen — a kill-retry re-derives the same
  pick), EAGER generation, message + CACHE + outreach (+ freeze on the
  third) in ONE transaction. Standing triad: fused lease-overlap re-check,
  interleaved-execution test, fault point `mid_proactive_dm` + harness
  cycle, verify-consistency block 4i.
- **Chat query escalation** (`37e0da7`, Rev 4 §11): `wikiquery` (registry +
  SUBWIKI projection, latest per sublocation wins) and `sessionquery`
  (scene-query, participation-gated STRUCTURALLY) as read-only mid-call
  executors on the proven `LlmCall.queries` seam; dev-trail frames per
  execution; the fake scripts `!wikiquery`/`!sessionquery` at $0.
  `memoryquery` is DEFERRED to M7 (the real memory store), not stubbed.
- **The Wiki page** (`98abb71`, UI Spec §2.6 read-only slice): route
  `/wiki` live in the NavRail; list-left/entry-right over the store's new
  `subwikiBySublocation` projection, provenance = "written after <scene
  title>"; stub names project from `sublocation.stub_created` so interiors
  never show a raw id. Manual edits + review toggle stay part 4 / config.

## Success criteria

### (a) Character-led startscene on the real backend — PASS

`weltari-real` (week-10 world, DeepSeek), in the browser, no button:
- User: "enough texting, we should meet up. I found something I need to
  show you." → Elias ASKED for the missing place instead of firing:
  *"Found something? Now you've got my attention. Where should I meet you —
  the workshop, or somewhere else?"*
- User named the shrine → Elias replied in character (*"I'll bring a
  lantern — the lamps back there always die first. On my way."*) and fired
  `startscene` HIMSELF in the same reply, with a premise he authored. The
  scene opened (free text rode `place_request`), Elias joined (the
  reservation), the chat closed with reason `startscene` — exactly ONE open
  scene. Later the same session he fired a second organic startscene after
  proposing a meeting himself.

### (b) A proactive DM arrives unprompted — PASS

Real backend, 30 s demo cadence, one fire: committed to log + CACHE at
fire time and rendered in the thread like any message — and the content was
GROUNDED: *"I'm at the shrine now. The bell's still — crack and all — but
there's fresh wax on the beam beneath it."* (he was mid-way to the meeting
HE arranged in criterion (a), and the bell is his goal). Full server
restart → the transcript replayed with exactly ONE copy (natural key;
offline verify-consistency green on the real DB). Bonus: the queued next
occurrence fired at boot as a natural re-ask (*"Still here. Wax is still
warm. You'd tell me if you got held up, wouldn't you"* — unanswered_count
2), demonstrating Rev 4's re-ask intervals unscripted.

### (c) The freeze rule — PASS (fake-driven, $0)

Live fake server, 1.2 s cadence: three backoff-spaced fires
(unanswered_count 1, 2, 3), `chat.thread_frozen` appended atomically with
the third; 6 further seconds of occurrences produced ZERO sends; one user
reply + range close → proactive sends RESUMED with the counter reset to 1.
Kill-safety of the fire is harness-proven (`mid_proactive_dm`).

### (d) Query escalation live — PASS

Real backend: *"that night at the charcoal burners camp… What exactly did
we find there? Check your notes."* → the model ran BOTH `sessionquery` and
`wikiquery` mid-call (dev trail shows the frames) and the reply visibly
used the session read — kiln-crown details from the week-10 scene history,
far beyond the CACHE one-liner. The reply then proposed meeting at the
shrine and fired startscene again, unprompted.

### (e) The Wiki page — PASS

- The real world's week-10 entry renders: "The Charcoal Burners' Camp",
  provenance *written after "Meeting Elias: the charcoal camp"*, the
  observable-now snapshot text.
- Live update (fake world, same projection): with `/wiki` open, a driven
  scene (`!createwild the-salt-merchants-wharf` + `!end`) made "the salt
  merchants wharf" appear in the list WITHOUT a reload the moment the
  World-Agent pass committed.

### (f) Stub/fake defaults, harness, RSS, spend — PASS

- `npm run gate` exit 0 (format, 0-warning lint, typecheck, 397 tests, knip).
- Kill harness `CYCLES=25` over **14 fault points** incl. the new
  `mid_proactive_dm`: zero duplicate/lost events, zero corrupted images,
  zero torn flips, resume exact — **$0.00** (also run at CYCLES=15 to
  prove the proactive convergence wrap explicitly).
- Idle RSS of the real server: **112.9 MB** (< 170).
- Spend **$0.0326 / $1.00**.

## Spend log (budget $1.00; baseline `total_usage` 23.129315)

| What | Est. cost | Running total |
| --- | --- | --- |
| All builds, tests, 25-cycle harness, freeze demo (fakes) | $0.00 | $0.00 |
| (a) negotiation: 2 real chat turns | ~$0.007 | ~$0.007 |
| Scene-end fan-outs (2 empty meeting scenes, World-Agent passes) | ~$0.01 | ~$0.017 |
| (d) escalation turn (2 queries mid-call) + second startscene | ~$0.006 | ~$0.023 |
| (b) proactive fire + boot re-ask + courtesy reply | ~$0.010 | **$0.0326** |

(Exact total = 23.161938 − 23.129315 from `GET /v1/credits`.)

## Notes for week 12 (M6 part 4)

- **The character fires startscene eagerly when IT proposes the meeting**
  (fired alongside its own "meet me at the shrine" without waiting for a
  yes). Rev 4 §7's invitation-TTL model expects exactly this (the user may
  never come; expiry writes a memory entry) — but the TTL/expiry machinery
  is NOT built yet, so an unanswered character-fired scene sits open until
  ended. Named for part 4 alongside the gateway push.
- Proactive DM quality on the real model is exceptional at chat prices:
  fires ground themselves in CACHE + goals unprompted ($0.003–0.005/fire).
- The freeze/thaw needs NO reset event — the counter is a projection of
  outreaches after the last user line. Keep it that way.
- The wikiquery/sessionquery instruction line ("check before answering")
  was enough for DeepSeek to call both tools first try — no retry loop
  needed.
- Remaining M6 part 4 surface: group chats (the Group-chat Narrator), the
  Feed/Camera surface, wiki manual edits + the review-writes toggle,
  gateway push of CRON DMs + the frozen-thread notice, startscene
  invitation TTL/expiry (hardcoded injected notice — owner ruling
  2026-07-10). The real memory store (`memoryquery`) is M7.
- Pre-existing, unrelated: the boot-time `update_check` 404 in dev worlds.
- Owner task still standing: **rotate the shared OpenRouter key** (~$0.0025
  external usage appeared again between sessions).
