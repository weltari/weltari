# Week 16 results — M7 part 3: objects (sublocation-only)

Scope settled at session start (owner rulings 2026-07-16, recorded below).
All scoped success criteria PASS. Real-provider spend: **$0.3068** (exact,
from OpenRouter credits deltas: 23.777737 → 24.084550) of the $2.00
budget — of which ~$0.24 was three REAL gemini-flash backdrop paints the
carried-over launch config fired automatically (my miss: the kickoff said
no images this week; the `weltari-real` config now defaults
`WELTARI_IMAGE_BACKEND=stub`). The session baseline sat **$0.0083 above**
week-15's closing number — external usage on the shared key stays near
zero; ⚠️ rotation remains the standing owner task.

**This was also the first week on the new machine**: the repo moved from
the Windows box to macOS on 2026-07-15 (transfer bundle restore verified;
git identity re-set; `.claude/launch.json` converted from PowerShell to
bash; everything runs under Homebrew node@24 — the default node 26 on
PATH violates the engines pin). The first cold vitest run after a
transfer can fail with worker-startup timeouts; re-run before diagnosing.

## The V1 completion map (owner rulings carried forward)

Weather is V1.5 (owner ruling); **backpacks are V2** (owner ruling
2026-07-16, this week — see below); every other Rev 4 §18 "In V1" item
stays V1.

| Week | Scope | Rev 4 | Status |
| --- | --- | --- | --- |
| 14 | The real memory store: durable core + deltas, the FTS5 Search Index, `memoryquery`, compaction, CACHE retention | §11, §4.2 | ✅ done |
| 15 | The GM agent: the Proposal pipeline, cold-boot onboarding, consent-gated authoring, user profiling + GDPR view/export/delete, the gateway-onboarding GM message; the user-facing `locked` toggle | §9, §16 | ✅ done |
| **16** | Objects (sublocation-only): materialize-on-touch rows, `interact_object`, `explore`, write-on-first-read (`describe_object`), the GC-sweep ledger job, GM `propose_object` | §7, §14, §17 | ✅ **DONE (this doc)** |
| 17 | The living-world loop: chance-encounter markers + CRON world movement + character position bubbles on the map | §14 | |
| — | **The GM proposal UX contract** (binding owner ruling 2026-07-11): streamed GM prose, inline tool-call proposal blocks, the durable tool-result turn feeding resolutions back to the GM, the chat-about-this signal — its own slot, before week 19 | §9, §16 | scheduled |
| 18 | The agentic scene: `make_character`, `charactercall`, set-typed `determine_who_next` (V1: size 1), `character_leave`, `move_character`, scene-side `query_wiki`, storytelling goals → subgoals, the full `next_scene_registration` payload, the context-budget warning | §6 | |
| 19 | Verification & close-out: line-by-line audit of Rev 4 §18 + module contracts against the code, fix what it finds, packaging/container ship, docs/handover refresh, key rotation confirmed — only then is V1 declared done | all | |

## The owner rulings this week was scoped around (2026-07-16, session start)

- **Backpacks defer entirely to V2.** V1 objects are sublocation-held
  ONLY: `holder = sublocation_id` is the one holder kind; character/user
  holders, `transfer_object`, the engine secrecy rule, and the backpack UI
  panel all defer with it. Consequences accepted with eyes open: nobody
  carries anything durable across scenes, and every object is public. The
  original criteria (b)/(c) were rewritten accordingly (backpack secrecy →
  explore-listing correctness; live backpack UI → the consent-card UI for
  GM objects).
- **The GM proposal UX contract does NOT ride week 16** — it gets its own
  dedicated slot (row added to the map above), and must land before week
  19 closes V1.
- **Budget $2.00.**

## What was built (9 code commits)

- **Protocol 0.18.0** (`c0913f8`): the object event family —
  `object.created` (materialize-on-touch or proposal apply; optional
  `object_payload`; `scene_id` XOR `proposal_id` provenance) /
  `object.payload_written` (character authoring or Narrator improv) /
  `object.moved` (one pointer update, sublocation → sublocation) /
  `object.swept` (the GC tombstone). The web reducer gains explicit no-op
  cases — no client object projection in V1.
- **The object store** (`ba490d4`, migration `0006_objects.sql` +
  `storage/repositories/objects.ts`): the objects table as a PROJECTION of
  the object.* events — fed by the event-log append INSIDE the same
  transaction (the memory-index pattern: a kill can never commit an object
  event without its row), re-projected from the log at every boot.
  (world, holder, name_key) dedup is a UNIQUE index over the exported
  `objectNameKey` normalization; `resolveName` (reachable-holder
  resolution, ambiguous = all matches), `heldAt` (the explore listing),
  `strayCandidates` (the GC pre-filter).
- **`interact_object`** (`f8e357b`): the character's ONE mutating scene
  tool, through the same mid-call B6 double gate as the narrator's tools
  (gate 1 `parseCharacterSceneToolCall`; the narrator's parser rejects it —
  write authority preserved). Accepted only if durable: unresolved names
  materialize on touch (at `move_to` ?? current), resolved refs take one
  op per call (payload write OR move), no-change touches get the fixed
  "express it in your attempt instead" refusal, 2 ops/turn cap, reach =
  current sublocation + parent + children incl. same-turn staged stubs.
  Wired in BOTH clients (the week-15 lesson): gated SDK execute + the
  fake's `!obj`/`!objwrite`/`!objmove`/`!objbad` markers.
- **`explore`** (`9f0ef50`): the §14 pure-retrieval query on the mid-call
  seam — wiki (latest entry, else description) + public objects (payload
  preview or "nothing written about it yet") + one level of interiors;
  defaults to the turn's live sublocation. Character scene turns only.
- **`describe_object` — write-on-first-read** (`6c41179`): the Narrator's
  one object surface. Gate 2 refuses a write over an existing (or
  same-turn staged) payload and refuses unresolved refs (the Narrator can
  never mint an object), so improv persists EXACTLY once and the second
  read returns the same content by construction. The narrator's dynamic
  tail lists the current sublocation's objects (payload, or "nothing
  written yet — improvise once when examined").
- **The GC sweep** (`dd40e65`, `ledger/handlers/object-gc.ts`): every
  scene end enqueues one world-serial `object_gc` job (natural key
  `object_gc:<world>:<scene>`); payload-less strays whose creating scene
  has ENDED are tombstoned with `object.swept` — the row leaves the
  projection in the same transaction, the log stays append-only (I1).
  Payload carriers exempt; proposal-applied objects never candidates;
  candidates recomputed INSIDE the transaction so retries converge and a
  concurrent touch can never lose the race. Fault point `mid_object_gc`.
- **GM `propose_object`** (`bf9e058`): §16 action `create_object` joins
  the closed proposal union (name + holder sublocation + optional authored
  payload). Gate 2 (holder exists ∧ (name, holder) free) re-runs at apply
  so a pending twin loses; the plan appends ONE `object.created` with
  proposal provenance and NO scene_id — GM objects are never GC
  candidates. The consent card renders the new diff shape. New invariant
  file `tests/invariants/object-proposal.test.ts`.
- **Harness + verifier** (`4d58d1d`): fault point `mid_object_gc` (21
  points now) with its cycle (a `!obj` stray, end-scene, kill inside the
  tombstone window; convergence = swept exactly once, the creating event
  still in the log); verify block 4n (the objects table mirrors the event
  fold row-for-row; object events only touch live objects; (name, holder)
  unique among live rows; every tombstone was a legal stray of an ENDED
  scene); 4m gains the approved-create_object row count.
- **Fake-demo find** (`26fc172`): the GM's scripted propose markers
  scanned the WHOLE prompt, so the second proposal of a conversation
  re-matched the first message's marker from the transcript and gate 2
  refused the twin — no new card could ever be driven in an ongoing GM
  chat. Scoped to the tail after the last user line (the group-router
  rule). Found live in the browser demo, invisible to the tests (fresh
  conversations each).

## Real-provider findings (deepseek-v4-pro — this is why real runs exist)

1. **The stale-web-bundle trap**: the served `apps/web/dist` was built
   before the protocol bump, so its 0.17.0 schema silently `safeParse`-
   dropped the new `create_object` proposal event — the consent card never
   rendered, with zero errors anywhere. Diagnosis cost a rebuild:
   `npm run build --workspace @weltari/web` must follow any protocol bump
   before a browser demo.
2. **The model uses the tools when the fiction makes durability explicit.**
   Asked plainly to "keep the letter safe," DeepSeek narrated prose only
   (and one tool-call-shaped reply arrived with EMPTY character text).
   Asked to *write content into* an object, it fired
   `interact_object({object: "ledger", payload: "MIDNIGHT, THE BELL, THE
   FERRYMAN PAYS"})` unprompted by markers, and the row committed
   atomically with the turn. Materialize-on-touch, real.
3. **The gates teach, live**: the Narrator tried `describe_object` on a
   not-yet-materialized "Elias's ledger" and was refused twice with the
   teaching message ("objects only exist once a character's interaction
   materialized them" — it can never mint); its bare-name
   `change_sublocation("common_room")` self-corrected to the real id after
   reading the gate error. The mid-call correction loop works on the real
   provider for the character toolset too.
4. **Write-on-first-read landed on the SECOND read**: on the first
   examine, the Narrator improvised the tin box's contents in prose but
   skipped the tool; on the re-examine it called `describe_object` with
   the SAME contents (ferry token, folded paper, clock key) and narrated
   them "stubbornly unchanged." Once written, the exactly-once gate makes
   later drift impossible — but a first-read miss leaves one turn of
   unpersisted improv. Candidate prompt hardening for a later week: an
   explicit examine-time nudge in the narrator instruction.
5. **`explore` real**: Elias called it bare (`{}` — current sublocation)
   and grounded his reply in the listing ("The ledger's the only solid
   thing worth the name in here").
6. **The GM refused to author in an unseeded world** — the fixture dev
   world has no `world.seeded` event, so the real GM stayed in interview
   mode and declined to plant an object "in a place that hasn't been
   dreamed up." Correct consent-first behavior; the create_object seam is
   proven by the invariant tests and the fake browser demo (card → Consent
   → applied → settled off the stream).

## Success criteria (as rewritten under the backpack ruling)

### (a) Materialize-on-touch is real — PASS

- Fake: `scene-objects.test.ts` — the first durable `!obj` touch creates
  the row atomically with its turn (actor = the character, scene
  provenance); narrated scenery stays prose (exactly one row); dedup
  resolves later refs to the SAME row; the 2-ops/turn cap refuses the
  third call (I8: zero rows); reach refuses far sublocations and admits
  same-turn staged stubs. Real: finding 2 above.
- Kill: harness cycle `mid_object_gc` + the turn window; verify 4n sweeps
  fold↔table equality after EVERY cycle.

### (b) Public objects are listed and readable — PASS

- `explore` returns wiki + objects (payload or none-yet) + interiors
  (`scene-objects.test.ts`, `chat-queries` seam); driven real (finding 5)
  and at $0 in the browser demo (the listing rode Elias's visible reply).

### (c) The GM object path is consent-gated end-to-end — PASS

- Invariants (`object-proposal.test.ts`): reject = zero object rows (I8);
  approve applies exactly one `object.created` with proposal provenance
  and no creating scene; dedup refuses twins at submit AND at apply.
- Browser at $0: the GM's card rendered ("The GM proposes a new object —
  harbor bell clapper"), Consent applied it (4 live rows), the card
  settled off the stream (`proposal.resolved`), zero cards left.

### (d) Write-on-first-read persists exactly once — PASS

- Fake: the improv persists once (actor = the Narrator); a second
  `!describe` is refused ("already has written content") and the payload
  stands unchanged; describing an untouched object is refused (the
  Narrator can never mint). Real: finding 4 — persisted on the second
  read, identical contents, immutable thereafter.

### (e) The GC sweep is safe — PASS

- `object-gc.test.ts`: payload-less strays of ENDED scenes vanish;
  carriers, live-scene objects and proposal-applied objects are exempt;
  re-runs converge to zero duplicate tombstones; the creating event stays
  in the log (I1).
- Kill: the `mid_object_gc` cycle converged (row gone, ONE tombstone, log
  intact); verify 4n asserts sweep legality offline after every cycle.
- Live on the fake server: the dropped stick was tombstoned by
  `system:object_gc` at scene end; the brass key and the old chest
  (payload carriers) survived.

### (f) Stub/fake defaults, harness, RSS, spend — PASS

- `npm run gate` exit 0 (format, 0-warning lint, typecheck, **582 tests**
  — 34 new this week, knip).
- Kill harness `CYCLES=25` over **21 fault points** — zero duplicate or
  lost events, resume exact, **$0.00**.
- RSS: fake server after the full demo **108.8 MB**; real server after
  8 turns **64.2 MB** (< 170).
- Spend **$0.3068** of $2.00 (~8 chat-class turns ≈ $0.06; ~$0.24 was the
  three unintended real backdrop paints — see the header note).

## Spend log (baseline `total_usage` 23.777737)

| What | Est. cost | Running total |
| --- | --- | --- |
| All builds, tests, harness (25 cycles), fake demos, browser runs | $0.00 | $0.00 |
| Real scene turns 1–3 (letter attempts; found the prose-only lean + empty tool-reply shape) | ~$0.03 | ~$0.03 |
| Real ledger-authoring turn (interact_object fired) + explore turn | ~$0.02 | ~$0.05 |
| Tin box turns (empty carrier + two reads → describe_object) + GM ask | ~$0.02 | ~$0.07 |
| 3 real gemini-flash backdrop paints (unintended — config carried from week 15) | ~$0.24 | **$0.3068** |

(Exact total = 24.084550 − 23.777737 from `GET /v1/credits`.)

## Notes for the next session

- **Week 17 = the living-world loop** (V1 map above): chance-encounter
  markers (1–5 live, game-time TTLs, sweep + clock advance, click
  re-validation, born-expired suppression, engine top-up, scene-end
  follow-up proposals) + CRON world movement + position bubbles.
- **The GM proposal UX contract still needs its own slot before week 19**
  (owner rulings 2026-07-11 + 2026-07-16). Everything relevant is in the
  Week 16 kickoff's ⚠️ section; nothing of it shipped this week.
- **After any protocol bump, rebuild the web bundle before a browser
  demo** (real finding 1 — the stale dist drops new events silently).
- **`weltari-real` now defaults `WELTARI_IMAGE_BACKEND=stub`** — flip it
  deliberately for image demos; paints are the dominant cost every time.
- Candidate small rider for a later week: an examine-time
  `describe_object` nudge in the narrator instruction (real finding 4).
- **Known debts, carried deliberately** (week-19 audit items): the
  fixture-trio registry base on blank worlds; next-boot DM roster for
  created characters; `profiling_enabled` defaults OFF; compaction knobs +
  `WELTARI_CACHE_KEEP` Config surface; the boot-time `update_check` 404 in
  dev worlds (again visible in this week's real run — 4 job.failed, all
  update_check).
- V2 (with backpacks): character/user holders, `transfer_object`, the
  structural secrecy rule, the backpack UI projection, object-in-object
  nesting.
- ⚠️ **Rotate the shared OpenRouter key** (standing owner task) — external
  usage between sessions was $0.0083 this time.
