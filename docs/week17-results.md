# Week 17 results — M7 part 4: the living-world loop

Scope settled at session start (owner rulings 2026-07-17, recorded below).
All success criteria PASS. Real-provider spend: **$0.0339** (exact, from
OpenRouter credits deltas: 24.089099 → 24.123023) of the $2.00 budget —
chat/scene class only, zero images (the `weltari-real` stub default held).
The session baseline sat **$0.0045 above** week-16's closing number —
external usage on the shared key stays near zero; ⚠️ rotation remains the
standing owner task.

## The V1 completion map (owner rulings carried forward)

Weather is V1.5 (owner ruling); **backpacks are V2** (owner ruling
2026-07-16); every other Rev 4 §18 "In V1" item stays V1.

| Week | Scope | Rev 4 | Status |
| --- | --- | --- | --- |
| 14 | The real memory store: durable core + deltas, the FTS5 Search Index, `memoryquery`, compaction, CACHE retention | §11, §4.2 | ✅ done |
| 15 | The GM agent: the Proposal pipeline, cold-boot onboarding, consent-gated authoring, user profiling + GDPR, the gateway-onboarding GM message, the `locked` toggle | §9, §16 | ✅ done |
| 16 | Objects (sublocation-only): materialize-on-touch, `interact_object`, `explore`, write-on-first-read, the GC sweep, GM `propose_object` | §7, §14, §17 | ✅ done |
| **17** | The living-world loop: chance-encounter markers (1–5 live, game-time TTLs, lazy sweep + click re-validation, born-expired suppression, engine top-up, scene-end follow-ups, first-click-wins) + CRON world movement + position bubbles | §14, §17 | ✅ **DONE (this doc)** |
| — | **The GM proposal UX contract** (binding owner ruling 2026-07-11): its own dedicated slot, **between weeks 17 and 18** (owner ruling 2026-07-17) | §9, §16 | scheduled NEXT |
| 18 | The agentic scene: `make_character`, `charactercall`, set-typed `determine_who_next` (V1: size 1), `character_leave`, `move_character`, scene-side `query_wiki`, storytelling goals → subgoals, the full `next_scene_registration` payload, the context-budget warning | §6 | |
| 19 | Verification & close-out: line-by-line audit of Rev 4 §18 + module contracts against the code, fix what it finds, packaging/container ship, docs/handover refresh, key rotation confirmed — only then is V1 declared done | all | |

## The owner rulings this week was scoped around (2026-07-17, session start)

- **Week 17 builds the living-world loop as the kickoff was written**; the
  GM proposal UX contract gets its dedicated session between weeks 17 and
  18 — the slot stays real on the map.
- **Budget $2.00** (estimated need was <$0.10; actual $0.034).
- Kickoff scope items 1–8 and success criteria (a)–(f) accepted as written.

## What was built (5 code commits)

- **Protocol 0.19.0** (`f13afa3`): the marker event family —
  `marker.dropped` (a LAZY intent: materialized sublocation + cast +
  premise seed + game-time TTL with the engine-computed expiry stamp;
  kind `map_event` — `chat_dm` stays V2) / `marker.instantiated` (first
  click won into the ONE deterministic scene `s-marker-<id>`) /
  `marker.expired` (`expired_via: sweep | click`) +
  `character.location_changed` (CRON movement's pointer update). New
  command `marker-click` (202 `instantiated` | `join`). `MapJumpDetail`
  gains optional `scene_id` (a marker jump enters the already-open scene).
  Web reducer: explicit no-op cases — pins and bubbles are the map
  plugin's business.
- **The marker store** (`2cac4ba`…, migration `0007_markers.sql` +
  `storage/repositories/markers.ts`): the markers table as a PROJECTION of
  marker.* — fed by the event-log append INSIDE the same transaction,
  rebuilt at boot. Unlike objects, terminal rows STAY: `state` walks
  dropped → instantiated | expired guarded IN SQL (a transition on a
  settled row is loud corruption); an instantiated row answers the join
  race with its one scene, an expired row is the audit trail.
- **The marker engine** (`e759552`, `engine/markers.ts`): every drop
  funnels through ONE gate (materialized-only anchoring, the ≤5 ceiling —
  refusal appends ZERO rows (I8), born-expired suppression); the ≥1 floor
  via engine top-up (deterministic anchor/cast picks, premises stay SEEDS —
  nothing generates until the user arrives); the lazy sweep (invitation
  pattern: every clock advance + boot, fused re-check, tops back up); the
  click seam (join answer, expired-click refuses AND settles, click-time
  cast re-validation — characters gone `in_scene` drop from the roster —
  then marker.instantiated + the FULL scene open in one transaction).
  `openScene` refactored into `appendSceneOpen` + `sceneOpenBlockers` for
  that reuse. Scene end feeds the loop through the new
  `SceneEndMarkerFanOut` seam: the Narrator's `end_scene` gains
  `follow_up_marker` (wired in BOTH clients — `!endfollow` on the fake),
  dropped in the SAME fan-out transaction; a scene leaving nothing tops
  the world up instead. Env knobs `WELTARI_MARKER_MIN/MAX/TTL_GAME_MINUTES`
  (defaults 1/5/180).
- **CRON world movement** (`2cac4ba`, `engine/locations.ts`): PURE
  occurrence planners — up to 2 available characters (presence-checked;
  never `in_scene`) each to a materialized sublocation ≠ current,
  deterministic per (world, occurrence), stamped with the SCHEDULED
  fictional time. The world-cron code handler gains the kind-routed
  `occurrenceEvents` hook: planned events append atomically WITH
  `world_cron.completed`, so the occurrence natural key gates the whole
  batch. Fixture cron table gains `world_movement` (every 3 game hours)
  and `encounter_marker` (every 4, code class) — no new scheduler.
- **The living-world map** (`9121f1a`, wl-map 0.6.0): live markers render
  as red "!" discs above their anchor pin (`data-wl-map-marker`); a click
  POSTs the public marker-click command and dispatches `wl-map-jump` WITH
  the 202's scene_id — the host's new `enterSceneCovered` enters the
  already-open scene under the §1.14 cover (ending the previous scene:
  one active scene). CRON-moved characters render as initial-in-disc
  position bubbles (`data-wl-map-character`), fanned when several share an
  anchor. New tokens `--wl-map-marker`/`--wl-map-character`; plugin hash
  regenerated; web bundle rebuilt after the protocol bump (the week-16
  lesson, honored).
- **The standing triad** (`f2f682b`): fault points `mid_marker_sweep` /
  `mid_marker_click` / `mid_marker_topup` (24 points now) with cycles +
  convergence checks; verify block **4o** (the markers table mirrors the
  fold exactly, legal state walks only, ceiling never exceeded at any
  drop, expiry stamp = dropped_at + ttl, no born-expired drop ever, every
  instantiation's scene exists, expiry judged at/after deadline) + **4p**
  (movement: world-cron actor only, materialized-only landings, never an
  in-scene mover, exact from-chains).

## Harness findings (the triad debugging paid rent)

1. **The verifier's shared events query lacked `actor_id`** — 4p's
   provenance check read `undefined` and failed all movement events; the
   query now selects it (additive, no other block reads it).
2. **A harness `fail()` used to orphan the live server** — the rotated
   port stayed bound and every LATER run's matching cycle died on
   `EADDRINUSE` against the ghost, which presented as a mystery boot
   crash. `fail()` now SIGKILLs the live child, and an unexpected server
   exit dumps its stdout tail (the fix that made the ghost visible).
3. **The marker cycles must wait out the boot passes**: the boot sweep and
   top-up are fire-and-forget behind their own fault windows, so
   `dbMarkerState` now splits live markers into `fresh`/`due` against the
   world clock — a due-but-unswept marker's click is REFUSED by design
   (the first blind run proved exactly that behavior, correctly).

## Real-provider findings (deepseek-v4-pro)

1. **The model closed the loop UNPROMPTED.** Asked only to "wrap it up but
   not forget this spot", DeepSeek called `end_scene` with a
   `follow_up_marker` of its own invention — "The floodwater has receded
   just enough to reveal what was glinting beneath the surface — a
   brass-bound chest, half-buried in silt, its lock still intact." — which
   dropped in the same fan-out transaction with scene provenance and went
   live on the map. Scene-end → marker → map, no scripted marker involved.
2. **Late generation is real**: the CRON marker held only a premise seed;
   on click the Narrator grounded the encounter in current state (Elias
   knee-deep in the flooded cellar, lantern light on black water, a brass
   glint) — nothing pre-baked ever sat in the DB.
3. **Movement is genuinely $0**: 8 mailbox-routed moves over a 12-hour
   skip (4 occurrences, both characters, exact from-chains) with zero LLM
   calls; the only skip cost was the fixture `evening_rumor` narration.

## Success criteria

### (a) The 1–5 invariant holds structurally — PASS

- `marker-lifecycle.test.ts`: boot top-up drops to the floor with
  generated content; the 6th drop is refused with zero events (I8);
  unanchored drops refused; verify 4o asserts the ceiling at EVERY drop
  offline after every kill.

### (b) Game-time expiry is lazy, swept, and click-safe — PASS

- TTLs stamped against the world clock at drop (4o: stamp = dropped_at +
  ttl, exactly); the sweep expires at clock advances + boot
  (`mid_marker_sweep` cycle: kill inside the window → the BOOT sweep
  settles exactly once, floor restored); a click on an expired-but-unswept
  marker is refused AND settles it (`expired_via: click`, zero scenes);
  born-expired markers never surface (suppression test + 4o + observed
  live: mid-skip cron occurrences with past expiry planned NO drop).

### (c) First click wins, second joins — PASS

- Invariant test: two clicks → exactly ONE scene.started, the loser
  answers `join` with the same scene id; driven live on the fake ($0
  browser demo) and the `mid_marker_click` kill cycle proves the
  marker.instantiated + scene-open pair is ATOMIC (never a torn half).

### (d) Scene-end follow-ups are real — PASS

- Invariant tests: the registered follow-up becomes a live marker in the
  SAME fan-out transaction (scene provenance on the row); a scene with no
  follow-up still leaves the world at the floor via top-up; a follow-up at
  the ceiling is refused with zero rows. Real: finding 1 — DeepSeek left
  one organically.

### (e) The world moves on its own — PASS

- Fake at $0: a 12-hour skip moved both characters (browser: position
  bubbles updated off the stream — Mara at The Common Room, Elias at The
  Old Shrine — plus a live "!" pin; screenshot in session), idempotent per
  occurrence (world-movement invariant tests + the world_cron.completed
  natural key; verify 4p sweeps provenance/presence/chains offline).
- Real: 8 moves over 4 occurrences, exact chains, materialized-only, then
  the full click → scene → follow-up loop (findings 1–3).

### (f) Stub/fake defaults, harness, RSS, spend — PASS

- `npm run gate` exit 0 (format, 0-warning lint, typecheck, **610 tests**
  — 28 new this week, knip).
- Kill harness `CYCLES=25` over **24 fault points** — zero duplicate or
  lost events, resume exact, **$0.00**.
- RSS: fake server after the full demo **122.5 MB**; real server after
  the loop demo **126.8 MB** (< 170).
- Spend **$0.0339** of $2.00.

## Spend log (baseline `total_usage` 24.089099)

| What | Est. cost | Running total |
| --- | --- | --- |
| All builds, tests, 6 harness runs (incl. debugging), fake demos, browser runs | $0.00 | $0.00 |
| Real 12 h skip (evening_rumor narration; movement itself $0) | ~$0.005 | ~$0.005 |
| Real marker click + opening narration turn (the lazy encounter) | ~$0.015 | ~$0.02 |
| Real wrap-up turn (end_scene + the organic follow_up_marker) | ~$0.014 | **$0.0339** |

(Exact total = 24.123023 − 24.089099 from `GET /v1/credits`.)

## Notes for the next session

- **The GM proposal UX contract is NEXT** (owner ruling 2026-07-17: its
  dedicated slot sits between weeks 17 and 18; the week-18 kickoff should
  not be written until it lands). Everything relevant is in the Week 16
  kickoff's ⚠️ section — target/current/engineering notes all still
  accurate; nothing of it has shipped.
- **After any protocol bump, rebuild the web bundle before a browser
  demo** (standing week-16 lesson — honored this week, no incident).
- Marker cadences live in `FIXTURE_WORLD_CRON` (movement 3 h, drops 4 h);
  min/max/TTL are env knobs — the §15 Config-panel surface for all of
  these joins the existing carried debt (week-19 audit list).
- Position bubbles render only after a character's first
  `character.location_changed` — a fresh world shows none until the first
  movement occurrence (accepted V1 shape; a seed-location fold is a
  candidate week-19 polish).
- **Known debts, carried deliberately** (week-19 audit items): the
  fixture-trio registry base on blank worlds; next-boot DM roster for
  created characters; `profiling_enabled` defaults OFF; compaction knobs +
  `WELTARI_CACHE_KEEP` + marker/CRON knobs Config surface; the boot-time
  `update_check` 404 in dev worlds.
- ⚠️ **Rotate the shared OpenRouter key** (standing owner task) — external
  usage between sessions was $0.0045 this time.
