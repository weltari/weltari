# Week 18 results — the agentic scene (Rev 4 §6)

**The Narrator drives the turn now.** The fixed three-call script is gone:
one narrator call runs the whole player turn as a tool loop —
`determine_who_next` (set-typed, V1 exactly one) → `charactercall` (the
engine runs the WHOLE C-Module call mid-loop and feeds the reply back) →
narration, with `make_character` / `character_leave` / `move_character` /
`update_goals` / scene-side `query_wiki` and the full
`next_scene_registration` behind both B6 gates. All success criteria
(a)–(g) PASS. Real-provider spend: **$0.048** (exact, OpenRouter credits
deltas 24.153861 → 24.201863) of the $2.00 budget — three real agentic
turns on Brackwater, zero images (stub default held). The session baseline
sat **exactly at** the UX-contract close — external usage this gap was
$0.00; ⚠️ key rotation remains the standing owner task.

## Owner rulings this session was scoped around (2026-07-21, session start)

- **Budget $2.00** (estimate $0.10–0.30; actual $0.048).
- **Kickoff scope items 1–7 and success criteria (a)–(g) accepted as
  written.**
- Push status checked at start: origin/main at `4ce837b` — clean.

## The V1 completion map (owner rulings — carry forward weekly)

Weather is V1.5 (owner ruling); **backpacks are V2** (owner ruling
2026-07-16); every other Rev 4 §18 "In V1" item stays V1.

| Week | Scope | Rev 4 | Status |
| --- | --- | --- | --- |
| 14 | The real memory store | §11, §4.2 | ✅ done |
| 15 | The GM agent: Proposal pipeline, cold boot, consent-gated authoring, profiling + GDPR | §9, §16 | ✅ done |
| 16 | Objects (sublocation-only) | §7, §14, §17 | ✅ done |
| 17 | The living-world loop: markers + CRON movement + position bubbles | §14, §17 | ✅ done |
| — | The GM proposal UX contract | §9, §16 | ✅ done (`docs/gm-ux-results.md`) |
| 18 | **The agentic scene** | §6 | ✅ **done (this doc)** |
| 19 | Verification & close-out: line-by-line audit of Rev 4 §18 + module contracts against the CODE, fix findings, packaging ship, handover refresh, key rotation confirmed — only then is V1 done | all | |

## What was built (7 code commits)

- **Protocol 0.21.0** (`4578f80`): `character.left` (mid-scene leave —
  presence releases per scene while the scene stays open),
  `scene.goals_updated` (the `update_goals` structured subgoal snapshot,
  `SceneGoalSchema {id, text, status}`), `scene.ended` gains end type
  `context_limit_reached` and the FULL §6 `next_scene` registration
  (`time_offset_hours`, `expected_participants[]`, `brief_history`,
  `carried_goals[]` — optional on the wire so pre-0.21 logs parse, required
  by the tool gate), `scene.started` gains the consumed-registration fold.
  The web cast line-up drops leavers.
- **The toolset behind both gates** (`6201677`): gate 1 —
  `make_character` (existing joins / new mints), `character_leave`,
  `move_character`, `update_goals`, the full end_scene registration
  (a partial one fails naming its missing fields), and the mid-call-only
  family `query_wiki` + `determine_who_next` + `charactercall`
  (`LlmCall.loop`, async — an inner LLM call lives behind it). Gate 2 —
  presence-gated joins/moves (the injected presence seam; reserved-elsewhere
  refused), the live cast view with discard rollback, the V1 one-at-a-time
  `declareNext`/`consumeDeclared` policy, the context-warning rule, and
  expected-participant validation against registry ∪ same-turn mints.
  `presenceOf` releases on character.left. Both clients wired
  (`LOOP_STEP_LIMIT` 12 on the real client; the engine budget is the cap).
- **The orchestration loop** (`1849811`): `runNarratorLoop` — ONE narrator
  call drives the turn; charactercall streams the character's sentences as
  a `character` step and rotates later narrator text into its own
  `narration` step, so committed steps read exactly as displayed
  (`stepsFromRecords` — the interrupt path shares the source). Turn budget
  (`WELTARI_SCENE_TURN_BUDGET`, default 3) refuses over-budget calls with
  an error the model reads; a failed inner call voids the whole turn (B6).
  Context budget (`WELTARI_SCENE_CONTEXT_BUDGET`, default 100000): within
  5000 tokens the ENGINE WARNING rides the tail and arms
  `context_limit_reached` (recomputed per turn — kill-safe). The cast comes
  from the `sceneRosterOf` fold (an emptied cast stays empty); the registry
  is LIVE per turn (minted characters callable + named in the end fan-out,
  no restart); the chapter seed (world.seeded) rides the narrator's STABLE
  prefix; the goals snapshot reinjects into every DYNAMIC tail. The fake's
  default reply drives the classic three-beat shape THROUGH the real
  executors and gates marker mutations mid-call (real-client ordering).
- **I5 invariants** (`e56a0c4`-ish): the hostile chapter seed byte-stable
  across turns; the goals snapshot tail-only.
- **The consumed continuation** (`28cd9c4`): `appendSceneOpen` folds the
  world's latest unconsumed registration when the open lands at its
  sublocation — premise_seed→premise, brief_history + carried_goals ride
  scene.started, expected participants join the cast; consumed exactly
  once. The Narrator's first turn injects both through the player-wrapped
  handoff block (B14). main's knownCharacters is the boot-time registry.
- **The standing triad** (`6fde366`): fault point `mid_charactercall`
  (**26 points now — full harness coverage is CYCLES=26**) with its cycle
  (a goals marker + the default charactercall, killed mid-loop; convergence
  = the whole turn voided, zero partial rows) + verify **4p extended**
  (char:narrator joins system:world_cron as a legal mover; character.left
  releases mid-scene; narrator targets = any known sublocation incl.
  stubs) + verify **4r** (goals↔turn atomicity, never-tearing per-scene
  casts, brief_history-carrying scene.starts backed by a real
  registration).
- **Live-registry reflections** (`6a657d9`): found LIVE in the fake demo —
  a minted Odo spoke, the scene ended, and `reflection:char:odo-…` PARKED
  ("enqueue and registry disagree"): the reflection handler resolved
  profiles from the boot-time list only. It now folds `characterProfilesOf`
  per job; the re-run demo committed BOTH reflections.

## Success criteria

### (a) The Narrator drives the turn — PASS

- Fake at $0: one input → determine_who_next → charactercall → narration
  in ONE envelope (browser + engine tests; both loop calls on the dev
  trail). The budget provably cuts a scripted ping-pong: with
  `turnBudget: 1`, a two-charactercall script commits exactly ONE character
  step and the refusal text ("the turn budget … is spent") streams
  verbatim into the transcript.

### (b) Characters join, leave, and move by tool — PASS

- Browser (fake, $0): `!mint Odo-the-Ferryman !callchar …` grew the VN
  line-up to two cards mid-scene (character.created + character.joined in
  the turn transaction) and the minted character SPOKE the same turn;
  `!leave char:elias` dropped his card (character.left, narrator actor,
  in-fiction reason). Invariant/unit tests: presence releases on leave
  (chat shows available, CRON movement may pick them); a character
  reserved by another scene can neither join nor be moved;
  move_character refuses a present character with the leave-first teaching
  and commits character.location_changed with the NARRATOR as actor
  (verify 4p's deliberate extension).

### (c) Goals persist — PASS

- `update_goals` commits `scene.goals_updated` atomically with its turn;
  a fresh engine over the same storage (the restart) reads the snapshot in
  the next narrator DYNAMIC tail — never the prefix (byte-stability
  invariants incl. the hostile chapter-seed fixture). Demonstrated live
  across a real server restart mid-scene, and by the `mid_charactercall`
  kill cycle (a killed loop turn leaves NO goals row — 4r's atomicity).

### (d) The full registration — PASS

- Gate 1 refuses a partial registration naming its missing fields (the
  pre-0.21 shape is the `!endnextpartial` subject); the registered payload
  opened the next scene as a REAL continuation: scene.started carried
  premise + brief_history + carried_goals (observed in the demo world's
  log), consumed exactly once — a later open at the same place is a fresh
  visit (lifecycle tests).

### (e) The context warning — PASS

- `WELTARI_SCENE_CONTEXT_BUDGET=1000`: the ENGINE WARNING rides the
  narrator tail and `end_scene(context_limit_reached)` closed the scene
  legally (observed end_type in the log). The default budget: the same
  close is refused with `no_context_warning`, zero rows (I8).

### (f) One real-provider scene — PASS ($0.048)

- Brackwater, Sela + Odo at the Ferry Landing, deepseek-v4-pro, 3 turns:
  1. The model ran the loop unprompted — narrator prose, a real
     charactercall to Sela (her reply grounded in the flood-recede chapter
     seed now riding the stable prefix), narration weaving it in.
  2. **Routing followed the fiction**: addressed at Odo, the Narrator
     declared and called ODO — his reply in-voice ("River's still
     hungry"), Sela reacting in the narration.
  3. Asked to wind down, the model closed with `end_scene(rest)` and its
     own divider ("— the mist thickens… —"); the fan-out ran clean.
- **Real-model finding:** offered `rest` vs the five-field continuation,
  DeepSeek chose `rest` even though the fiction agreed on "tomorrow at the
  stilt-house" — models take the cheaper end type. A skill-line nudge
  ("if a next meeting was agreed, register it as a continuation") is a
  week-19 polish item, not a code defect (the correction loop already
  handles partial registrations).

### (g) Defaults, gate, harness, RSS, spend — PASS

- `npm run gate` exit 0 (format, 0-warning lint, typecheck, **662 tests**
  — 39 new this session, knip).
- Kill harness `CYCLES=26` over **26 fault points** + the final
  convergence pass: zero duplicate or lost events, resume exact, **$0.00**.
- RSS: fake server settled at **77.2 MB** after the full demo; real server
  **141.8 MB** right after the scene (< 170).
- Spend **$0.048** of $2.00.

## Spend log (baseline `total_usage` 24.153861)

| What | Est. cost | Running total |
| --- | --- | --- |
| All builds, tests, CYCLES=26 harness, fake demos, browser runs | $0.00 | $0.00 |
| Real turn 1 (narrator loop + Sela charactercall + narration) | ~$0.02 | ~$0.02 |
| Real turn 2 (routing switch to Odo) | ~$0.015 | ~$0.035 |
| Real turn 3 (the close: farewells + end_scene rest) | ~$0.013 | **$0.048** |

(Exact total = 24.201863 − 24.153861 from `GET /v1/credits`.)

## Notes for the next session (week 19 — verification & close-out)

- **The Week 19 Kickoff Prompt is written** (repo root).
- Demo worlds: `weltari-fake` holds the criteria (a)–(d) transcript;
  `weltari-real` holds Brackwater with the played agentic scene
  (`s-agentic-demo`, ended).
- **Known debts, carried into the audit** (with the standing list):
  fixture-trio registry base on blank worlds; next-boot DM roster (scene
  reflections are LIVE now — chat/group rosters still boot-time);
  `profiling_enabled` defaults OFF; compaction/CACHE/marker/CRON knobs
  Config surface; boot-time `update_check` 404 in dev worlds; position
  bubbles only after first movement; NEW: the continuation-nudge skill
  line (real models prefer `rest` over the full registration); NEW: art
  sets exist only for fixture characters (a minted character's switch_art
  is always refused — V1-acceptable, audit-listed).
- ⚠️ **Rotate the shared OpenRouter key** (standing owner task — zero
  external usage again this gap; the task stands until done).
