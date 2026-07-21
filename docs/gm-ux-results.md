# GM proposal UX contract results — the dedicated slot between weeks 17 and 18

The standing owner ruling of 2026-07-11 (slotted 2026-07-17, built
2026-07-21) is real: **the GM works like a coding agent's tool loop.** All
success criteria (a)–(f) PASS. Real-provider spend: **$0.0308** (exact,
from OpenRouter credits deltas: 24.123023 → 24.153861) of the $2.00
budget — three chat-class DeepSeek calls, zero images (`weltari-real`'s
stub default held). The session baseline sat **exactly at** week-17's
closing number — external usage on the shared key was $0.00 this gap;
⚠️ rotation remains the standing owner task.

## Owner rulings this session was scoped around (2026-07-21, session start)

- **Budget $2.00** (estimate was <$0.10; actual $0.0308).
- **Kickoff scope items 1–6 and success criteria (a)–(f) accepted as
  written.**
- Per the standing ruling, this doc and the Week 18 Kickoff Prompt are
  written only now, at session end.

## What was built (6 code commits)

- **Protocol 0.20.0** (`4c3c3a6`): `StreamSentence.call` gains `'gm'`
  (additive — GM prose streams display-only into the GM thread, `turn_id`
  carrying the conversation id; B6: the committed message stays the
  transcript). New command `discuss-proposal` + durable event
  `proposal.discussed` — the "Chat about this" click as a REAL signal, the
  proposal staying pending with zero domain rows (I8). The web scene
  buffer is typed `SceneStreamSentence` so a gm frame can never leak into
  scene pacing. No wire anchor was needed for inline cards: the event
  envelope's log id IS the position.
- **GM streaming** (`ab94966`): the reply loop pipes `onTextDelta` through
  the shared sentence splitter onto the StreamBus; index restarts at 0 per
  correction attempt (a retry restarts the stream; clients replace on
  index 0). The web store buffers gm frames apart from the scene
  (committed message clears) and the GM thread renders a caret-animated
  streaming bubble replacing the typing dots. Both clients already emitted
  deltas — no client change needed.
- **Inline settle-in-place cards** (`afa5f77`): `ChatMessage` carries its
  `event_id` and the `gmProposals` fold keeps every card forever — the GM
  thread interleaves prose and proposal blocks in event-log order;
  `proposal.resolved` settles a card IN PLACE (dimmed, verdict chip where
  the buttons were), `proposal.discussed` marks it "Talking it over".
  Replay rebuilds the identical interleaved transcript.
- **The durable tool-result turn** (`c42944c`): `gmTranscriptOf` folds
  chat lines WITH the proposal tool calls and their results
  (`[tool call …]`/`[tool result …]` lines, speaker Tool) in log order —
  dynamic tail only (I5). Resolving a card triggers exactly ONE follow-up
  generation whose context carries the verdict, committed under the
  deterministic message id `gm-followup-<proposal_id>` — the natural key —
  behind the new `mid_gm_followup` fault window and a fused re-check. A
  card can sit for HOURS, so the result is never delivered by holding the
  LLM call open: an eager trigger in main's resolve wrapper and a boot
  sweep (the invitation pattern) converge on the same key across restarts.
  One serialized loop per conversation orders replies and follow-ups. The
  fake scripts verdict-reacting follow-ups and returns zero tool calls on
  follow-up turns (a rejected place's freed name must not mint a twin card
  off the stale user marker — found while writing the rejection test).
- **Chat-about-this** (`848ce9b`): the button now posts the command —
  gated (unknown/resolved/second-discuss/non-approver refused, zero rows —
  I8), appends `proposal.discussed`, and the GM acknowledges through the
  same machinery (outcome `discuss`, key `gm-discuss-<proposal_id>`),
  stops proposing and listens. The card stays pending and resolvable; the
  input prefill survives as a nicety. `engine/proposals.ts` untouched.
- **The standing triad** (`ce672c7`): fault point `mid_gm_followup`
  (25 points now) with its harness cycle (approve for real, kill inside
  the detached commit window; convergence = the boot sweep commits the
  follow-up exactly once) + verify block **4q** (at most one follow-up per
  resolution and per discuss — missing is legal mid-kill, duplicates and
  orphans never are; every follow-up a GM character line whose outcome
  precedes it; discuss at most once, only while pending).

## Harness findings (the triad paid rent again)

1. **The last fault point's convergence was never verified.** With CYCLES
   an exact multiple of the point count (25/25 now), the last cycle's kill
   had no following cycle to run its pending checks — the harness gains a
   FINAL convergence pass: one extra boot after the last cycle purely to
   drain the pending checks + one more offline verify. Found because
   `mid_gm_followup` became point 25 of a 25-cycle run; the flaw was
   latent for every earlier point ordering.
2. **A loaded machine flakes the gate**: the full `npm run gate` run
   concurrent with the kill harness + two demo servers died on vitest
   fork-worker timeouts (the known cold-start flake shape). Re-run quiet:
   exit 0, 623 tests. Nothing code-side.

## Real-provider findings (deepseek-v4-pro)

1. **The model respects the interview gate.** Asked to propose a shrine on
   a FRESH world, DeepSeek declined and ran the §9 Job-0 interview first
   ("before we can place a shrine in a town, we need the world it belongs
   to") — then, given the full picture in one message, called
   `propose_world_seed` with a rich, faithful form (Brackwater: 3 places
   incl. the public+private mix, Sela + Odo, flood-recede opening).
2. **The tool-result turn reads naturally.** After Consent, the follow-up
   turn (no user input) reacted in authoring voice and offered the next
   step: "Brackwater is real now — the shrine, the landing, the
   stilt-house… Would you like to step into your stilt-house and begin, or
   shall we flesh out the wiki entries for these places first?"
3. **Streaming is visibly live** on real tokens: the caret bubble filled
   sentence-by-sentence mid-generation (screenshot in session).

## Success criteria

### (a) GM prose streams — PASS

- Invariant tests: `call:'gm'` frames with turn_id = conversation id,
  contiguous index, frames re-assembling the committed text exactly; a
  correction retry restarts at index 0 (asserted via `!badproposal`).
- Fake: SSE capture shows the frames on the wire; real: the caret bubble
  observed filling live. Thinking never streams (the GM call has no
  thinking channel); frames are display-only (B6) — the durable message
  commits whole, as before.

### (b) Proposals are inline and settle in place — PASS

- Browser (fake, $0): the card renders between the GM's messages at its
  exact log position; after Consent AND after Reject the card stays,
  dimmed, with its verdict chip ("Consented — applied to the world" /
  "Rejected — nothing changed"); a reload replays the identical
  interleaved transcript (store test + observed).

### (c) The resolution feeds back — PASS

- Browser (fake, $0): after Consent and separately after Reject, the GM's
  next message REACTS with the user typing nothing. Invariant tests:
  exactly ONE follow-up per resolution (natural key), duplicate notes and
  overlapped generations converge (fused re-check), the boot sweep heals
  the hours-later case — demonstrated live across a real server restart
  with the card pending, and by the `mid_gm_followup` kill cycle.

### (d) Chat-about-this is a real signal — PASS

- Browser (fake, $0): the click posts the command; `proposal.discussed`
  lands durably; the GM acknowledges and stops proposing ("the card can
  wait as long as you like"); the card shows "Talking it over", stays
  pending, and was later resolved normally (its own follow-up riding the
  same machinery). Second discuss / non-approver / settled card refused
  with zero rows (I8, invariant tests).

### (e) One real-provider pass of the full loop — PASS

- Findings 1–3: interview → streamed replies → `propose_world_seed` card
  → Consent → the applied world + the GM's unprompted reaction.

### (f) Stub/fake defaults, gate, harness, RSS, spend — PASS

- `npm run gate` exit 0 (format, 0-warning lint, typecheck, **623 tests**
  — 13 new this session, knip).
- Kill harness `CYCLES=25` over **25 fault points** + the new final
  convergence pass — zero duplicate or lost events, resume exact,
  **$0.00**.
- RSS: fake (masking) server after the full demo **35.4 MB**; real server
  after the full loop **51.7 MB** (< 170).
- Spend **$0.0308** of $2.00.

## Spend log (baseline `total_usage` 24.123023)

| What | Est. cost | Running total |
| --- | --- | --- |
| All builds, tests, 2 full harness runs, fake demos, browser runs | $0.00 | $0.00 |
| Real interview reply (shrine idea → language question) | ~$0.005 | ~$0.005 |
| Real seed reply (the full propose_world_seed form) | ~$0.017 | ~$0.022 |
| Real follow-up turn (the consent reaction) | ~$0.009 | **$0.0308** |

(Exact total = 24.153861 − 24.123023 from `GET /v1/credits`.)

## Notes for the next session (week 18 — the agentic scene)

- **The Week 18 Kickoff Prompt is written** (repo root) — the agentic
  scene, Rev 4 §6, per the standing map.
- The GM's follow-up machinery (deterministic-message-id natural key +
  eager trigger + boot sweep) is the freshest triad example alongside
  markers; the week-18 scene tools should reuse the same shapes.
- The demo worlds: `weltari-mask` holds the fake demo transcript;
  `weltari-real` holds the seeded Brackwater world (a fresh world was
  used deliberately — the week-17 world would have received catch-up
  follow-ups from the new boot sweep for its pre-contract resolutions;
  that behavior is by design, worth one owner-visible note: an OLD world's
  first boot on this build sends one GM catch-up line per historical
  resolution).
- **Known debts, carried deliberately** (week-19 audit items, unchanged):
  fixture-trio registry base on blank worlds; next-boot DM roster;
  `profiling_enabled` defaults OFF; compaction/CACHE/marker/CRON knobs
  Config surface; boot-time `update_check` 404 in dev worlds; position
  bubbles only after first movement.
- ⚠️ **Rotate the shared OpenRouter key** (standing owner task — zero
  external usage this gap, but the task stands).
- Process note for owner ratification: `tests/invariants/gm-chat.test.ts`
  setup() gained the now-required `streamBus` option (compile-forced by
  the engine's new constructor surface); existing assertions untouched,
  new tests added alongside. Flagged under the invariant-change rule.
