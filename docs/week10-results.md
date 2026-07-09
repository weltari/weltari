# Week 10 results — M6 part 2: Weltari Chat, part one

All six success criteria PASS, including the stretch subwiki pass (e).
Real-provider spend for the week: **$0.19 of the ≈$8.67 budget** (exact,
from OpenRouter's credits endpoint deltas: 22.934043 → 23.126770 =
$0.192727). The session baseline sat $0.0053 above week-9's closing number —
a small amount of external usage on the SHARED key between sessions (the
standing rotation task remains, see notes).

## What was built (7 commits)

- **Mid-call gate feedback** (owner decision 2026-07-09): a gate-2 rejection
  is no longer trail-only — the narrator call offers `LlmCall.gate`, the
  engine's B6 double gate as a mid-call executor. Mutating tools execute
  DURING the call (step limit 4) and the model reads the staged-ack or the
  refusal string, so a refused parentless create self-corrects in one turn.
  Staging stays in-memory; durability still only at turn.committed; gated
  calls never come back as data.
- **Protocol 0.11.0**: `chat.message_committed` / `chat.ended` /
  `reflect_chat.committed` / `cache.appended` / `subwiki.updated` events;
  `send-chat-message` / `exit-chat` / `start-scene-from-chat` commands;
  `scene.started` optional `premise` + `place_request`.
- **The CACHE store, first slice** (Rev 4 §11): a PROJECTION of
  `cache.appended` events — per-character, append-only, latest-per-origin as
  a view. The character authors only the one-liner; every structured field
  is engine-written. Writers: the reflection handler (scene origin — the
  stand-in until the C-Module writes in-scene) and the chat engine (chat
  origin, every reply). Chat prompts re-read the recap FRESH per call
  (owner decision).
- **The chat DM engine** (Rev 4 §8): conversations are projections on the
  ONE event stream (owner-confirmed wire shape) — stable
  `chat:<actor_id>:<character_id>` ids, user lines durable at the seam,
  replies detached with chat-shaped context (memory core + latest-per-origin
  CACHE recap, B14-wrapped), mandatory CACHE line per reply, request_id
  idempotency, a nudge loop instead of racing parallel replies. Presence is
  a pure projection (in_scene while a joined scene is open) — no new table.
  Idle timeout: `WELTARI_CHAT_IDLE_MINUTES` (owner default 30), enforced by
  a sweep against an injected ISO cutoff (no engine clock reads — Zulu
  strings compare lexicographically).
- **reflect_chat** (the chat analogue of reflection): enqueued atomically
  with `chat.ended` (exit / idle / startscene), idempotent per
  (conversation, range_end_id) with the fused lease-overlap re-check +
  interleaved-execution test; fault point `mid_reflect_chat`;
  verify-consistency sweeps the chat keys + the chat-end atomicity (4h).
- **The startscene() bridge** (Rev 4 §8 — THE way back into scenes): place
  resolved against the known-sublocations registry (id/name match → the
  scene opens AT it; no match → the free text rides scene.started as
  `place_request` and the Narrator's FIRST turn resolves it via the week-9
  standard create workflow). Opening joins the character (presence flips —
  the reservation); the chat range closes with reason `startscene`.
- **The /chats page** (UI Spec §2.4): list-left/conversation-right,
  presence dots, bubbles, typing indicator (view state, race-guarded),
  Meet-in-a-scene, End chat. NavRail's Chats destination goes live.
- **The subwiki pass (stretch, Rev 4 §10)**: the World Agent's scene-end
  pass writes one `subwiki.updated` per Narrator-created sublocation that
  participated (owner rule: created = gets a wiki; transient/mentioned-only
  never) — observable-now snapshots, all atomically with
  `world_agent.committed`.

## Success criteria

### (a) DM outside any scene + durable transcript across restart — PASS

`weltari-real` (week-9 world, real DeepSeek): DM'd Elias from the browser
Chat page → an in-character reply grounded in his memory core arrived over
the ONE event stream ("Inn held—Marta's cellar took a bit of water… Ferry
never ran; ferryman saw lightning over the ridge and called it."), with the
mandatory CACHE line committed atomically — the REAL model called the
`cache` tool correctly on its first live try. Server fully restarted →
the transcript replayed exactly (Last-Event-ID). **First real chat DM turn
measured before any batch: $0.0033** — the cheapest call class yet, as
predicted.

### (b) The presence rule live — PASS

Opened a scene with Elias → the Chat page flipped to "offline — in a scene"
(the same projection the server gate reads); a DM stored (202,
`replying: false, presence: in_scene`) and generated NO reply. Scene ended
→ presence flipped back live, and the next DM's reply even answered the
message sent while he was away (it sat in the transcript window). The
harness asserts this rule every `mid_reflect_chat` cycle too.

### (c) Conversation end → ONE reflect_chat — PASS

exit-chat closed the range (`chat.ended` reason exit, range_end 110) and
its job committed exactly one `reflect_chat.committed` — a genuinely
in-character private note ("They asked about the bell twice. That tells me
they notice the quiet things…"). Kill-retry convergence is harness-proven
(`mid_reflect_chat`: killed mid-reflection, the next cycle proves the range
reflected EXACTLY once).

### (d) startscene() — once existing, once free-text through the create workflow — PASS

- **Existing:** place "The Common Room" resolved by name →
  `s-w10-meet1` opened AT `subloc:common_room` with Elias joined.
- **Bonus finding:** place "the reed cutter's jetty" (intended as free
  text) — the Narrator queried, found The Round Pond ("a wooden jetty
  jutting into the dark water"), judged it a plausible match and moved the
  scene THERE instead of minting a near-duplicate. Exactly what the resolve
  instruction asks; the did-you-mean philosophy holding up at the semantic
  level, unprompted.
- **Free text:** place "the charcoal burners' camp in the birch hills" →
  `scene.started` carried it as `place_request`; the first turn's REAL
  narrator ran the whole week-9 loop in one reply: narrated the arrival,
  `create_sublocation` (parentless — the query-first rule satisfied
  mid-call), `change_sublocation` to the new stub, eager materialization at
  frontier square (3,3) (code-owned, zero LLM), the camp backdrop AND the
  map tile painted for real.

### (e) The subwiki pass — PASS

Ending the camp scene: the World Agent wrote `subwiki.updated` for
`subloc:stub-the-charcoal-burners-camp` — an observable-now snapshot
(birches, smoldering kilns, cordwood; no events, no speech) — atomically
with `world_agent.committed`. The Round Pond scene got NO subwiki entry
(it is a Flow-A creation, not a Narrator stub) and transients never can
(unit-pinned). The reflection also wrote its scene-origin CACHE line — the
Rev 4 §11 slice visibly working on the real backend.

### (f) Stub/fake defaults, RSS, spend — PASS

- `npm run gate` exit 0 (format, 0-warning lint, typecheck, 367 tests,
  knip).
- Kill harness `CYCLES=25` over **13 fault points** incl. the new
  `mid_reflect_chat`: zero duplicate/lost events, zero corrupted images,
  zero torn flips, resume exact — **$0.00**.
- Idle RSS of the real server: **115.8–122.9 MB** (< 170).
- Spend **$0.19 / ≈$8.67**.

## Backdrop visual inspection (the week-9 rule: LOOK at new exteriors)

The Charcoal Burners' Camp backdrop (flash-class, style bible v2,
unfeathered): two smoldering earthen kilns exactly per the brief, birch
wood, charcoal stacks under tarps, the oiled-canvas lean-to with lantern,
rain streaks — fully painted edge-to-edge, calm lower third. **ACCEPTED
first try** — v2 now has a second exterior sample with zero iteration.

## Spend log (budget ≈ $8.67; baseline `total_usage` 22.934043)

| What | Est. cost | Running total |
| --- | --- | --- |
| All builds, tests, 25-cycle harness (fakes/stub) | $0.00 | $0.00 |
| First chat DM turn (measured exactly) | $0.0033 | $0.0033 |
| Presence-window DMs + reply + reflect_chat + scene fan-outs | ~$0.03 | ~$0.04 |
| meet1/meet2/meet3 opens, jetty turn + fan-outs | ~$0.05 | ~$0.09 |
| meet4: create turn + backdrop + map tile + subwiki pass | ~$0.10 | **$0.19** |

(Exact total = 23.126770 − 22.934043 from `GET /v1/credits`.)

## Notes for week 11 (M6 part 3)

- **Chat turns really are ~$0.003–0.01** — proactive CRON DMs and groups can
  be budgeted generously.
- The REAL model handled the chat toolset (cache + startscene descriptions)
  first try; the startscene tool itself hasn't been observed fired BY the
  character on the real backend yet (the user button and the fake trigger
  are proven) — worth one deliberate real probe when groups/CRON land.
- Free-text place resolution is smarter than expected: the Narrator
  semantically reuses existing places ("reed cutter's jetty" → The Round
  Pond). Good for world hygiene; remember it when a demo NEEDS a create —
  pick genuinely novel places.
- Remaining M6 part 3+ surface: groups, proactive CRON DMs, Feed, the Wiki
  page (subwiki.updated events are already flowing for it), chat
  memoryquery/wikiquery/sessionquery escalation, in-scene C-Module CACHE
  writes (replacing the reflection stand-in).
- Pre-existing, unrelated: the boot-time `update_check` parks with a 404
  (release-channel URL) in the dev world — same behavior as prior weeks.
- Owner task still standing: **rotate the shared OpenRouter key** (~$0.005
  external usage appeared between sessions again).
