# Week 9 results — M6 part 1: the in-scene creation loop

All six success criteria PASS. Real-provider spend for the week:
**$0.33 of the $4.00 budget** (exact, from OpenRouter's credits endpoint
deltas: 22.5952 → 22.9287; the baseline matched week-8's closing number
exactly, so no external usage preceded or entered the session).

## What was built

- **`create_sublocation` through the B6 double gate** (Rev 4 §6): the
  Narrator commits identity stubs atomically with its turn — deterministic
  ids (`subloc:stub-<slug>`), the did-you-mean near-duplicate resolver, the
  flat-parent rule (an interior's parent must itself be parentless), and the
  engine-enforced parentless query-first rule with Rev 4's fixed refusal
  text (V1: the all-parentless query must run in the same TURN — strictly
  inside Rev 4's "same scene").
- **`query_sublocations` — the first mid-call tool round-trip**: a read-only
  engine executor (modes parentless | children | search) wired through the
  AI SDK's multi-step path (`stopWhen: stepCountIs(3)`; mutating tools still
  come back as data for the gates). Queries route context, they never
  mutate; each execution leaves a `dev.tool_call` trail frame.
- **The backdrop image class** (`backdrop:<sublocation_id>`): a NEW painter
  job enqueued in the SAME transaction as the stub event — its own image id
  = its own lease, plain text-to-image (no map context window, no feather),
  prompt derived from the DB at paint time (VN style bible + the stub's
  name/brief + the parent's name). Interiors never touch the map; their
  only asset is this backdrop, fired immediately for fluid switching.
- **Eager materialization for parentless stubs**: a second materialize
  payload shape `{stub_sublocation_id, anchor}` — ZERO LLM calls; the
  code-owned `solveFrontierSquare` picks the free square nearest the
  creating scene's sublocation that touches the explored area, the event
  keeps the stub's identity, and the square paints under the existing
  per-image lease (the region lock, Rev 4 §14 wholesale).
- **Scene-end continuation for real** (UI Spec §1.7): `end_scene` type
  `continuation` now REQUIRES a `next_scene` registration (gate-enforced;
  may name a stub created that same turn); scene.ended carries it and the
  soft-close "Jump to the next scene" button opens the follow-up scene AT
  that sublocation. "Stay longer" re-grounds at the same sublocation.
- **Scene UI** (UI Spec §1.6): the store projects painter-generated
  backdrops; the stage cover-crops the real image and replays the slide
  transition the moment a backdrop lands live (themed placeholder until
  then).
- **Protocol 0.10.0**: `sublocation.stub_created`, scene.ended optional
  `next_scene`.
- **Update public key baked** (owner decision 2026-07-09): `minisign.pub`
  committed and shipped at the app root of the Windows zip, the update
  artifact and the Docker image; `main.ts` falls back to it when
  `WELTARI_UPDATE_PUBKEY` is unset — auto-apply works out of the box
  (verified live: apply-update 202'd with no env key set). The env var
  stays the fork override; the secret key is `.dockerignore`d by name.

## The backdrop visual iteration (criterion d — 3 backdrops inspected, 1 rejected)

The week-7/8 lesson held again: both fixes came from LOOKING at real output
(all three in `docs/week9-assets/`).

| # | Backdrop | Prompt | Verdict |
| --- | --- | --- | --- |
| 1 | The Smokehouse (interior) | style v1 | **REJECTED** — the scene content was remarkably faithful (hanging fish + hams, the stone firepit with its faint glow, all from the Narrator's brief) but the bottom ~20% came back as a literally EMPTY band of raw canvas (v1 asked for "a calm, uncluttered lower third" — the model painted nothing there), and the room read as the parent common room (v1 quoted the parent's description; its hearth + tables leaked in). Fix: style v2 — paint EVERY pixel, lower third "visually simple, fully painted"; name the parent WITHOUT its description. |
| 2 | The Drying Loft (interior) | style v2 | **ACCEPTED** — attic loft with ladder, hanging hooks and hams, lantern, rain-dark window; fully painted, calm open floor low in frame. Nit: an ~8 px checkerboard fringe at the edges — the M2 feather mask blending a full-canvas composite into the base, pure artifact for backdrops. Fix: backdrops composite UNFEATHERED. |
| 3 | The Old Ferry Landing (parentless) | style v2, unfeathered | **ACCEPTED** — rainy river dock with a rusted winch, willow, lantern, rain-ringed water; edge-to-edge paint, zero fringe, calm water across the lower third. |

Backdrops run on flash-class `WELTARI_IMAGE_MODEL` (plain generation —
week-8's pro-model requirement was specific to EDIT legibility and does not
apply here).

## Success criteria

### (a) The creation loop end-to-end in the browser, real backend — PASS

`weltari-real` (week-8 world, real DeepSeek narrator + real image backend):

- Turn 1 ("show me the smokehouse out back"): the Narrator — entirely
  unprompted — called `query_sublocations` THREE times mid-call
  (`parentless`, `search "smokehouse"`, `children of subloc:common_room`)
  through the new multi-step seam, narrated between steps ("The smokehouse
  isn't on the map yet — let me find the right place for it"), then called
  `create_sublocation` with a rich brief and the correct flat parent →
  `sublocation.stub_created` + the backdrop job committed atomically with
  the turn; the real backdrop landed seconds later.
- Turn 2: the Narrator's own `change_sublocation` moved the scene into the
  stub — `sublocation.changed` carried `backdrop_path`, and the browser
  stage rendered the REAL generated backdrop through the slide transition
  (DOM-verified: the entering layer's background-image is the painter
  output; the sublocation chip reads "The Smokehouse").
- **Invalid call, zero rows, live and unplanned**: asked for "the drying
  loft above us", the model tried to nest it under the smokehouse
  (interior-under-interior). Gate 2 rejected with `parent_not_atomic`
  naming the correct parent; the dev trail carried it; ZERO rows were
  written. The next turn created it correctly under the common room.

### (b) Parentless stub → map presence via the placement contract — PASS

Turn 3 ("the old ferry landing, a place of its own"): the model queried
`parentless` (the strict prerequisite), created The Old Ferry Landing with
NO parent → the eager materialize job placed it at frontier square (2,4) —
free, touching the explored area, nearest the creating scene's anchor
(the inn at (3,4)) — pin at the square center, and the square painted onto
the real map composite (a riverbank tile, visibly water + shore beside the
inn; `docs/week9-assets/map-after-parentless-materialize.png`). The paint
ran under the per-image lease (the region lock a fortiori). Also proven on
the fake stack in-browser earlier the same day (square (2,4), same solver).

### (c) "Jump to the next scene" opens AT the created place — PASS

Turn 4 ("close the scene; we continue tomorrow at the ferry landing"): the
real Narrator called `end_scene(type: continuation)` WITH a next_scene
registration at the stub and a premise seed ("Elias arrives at the Old
Ferry Landing in the morning after the storm…") plus a poetic divider. The
soft close showed Stay longer / Jump to the next scene / Open map; clicking
Jump opened the follow-up scene AT `subloc:stub-the-old-ferry-landing`
(blocked-then-released by the reflection/world-agent fan-out exactly as
designed) with its real backdrop on the stage. The same flow passed on the
fake stack (`!endnext`).

### (d) Own visual inspection of ≥3 backdrops — PASS

Three inspected, one rejected, two prompt/pipeline iterations — the table
above and `docs/week9-assets/`.

### (e) Stub/fake defaults: gate + harness green at $0.00 — PASS

- `npm run gate` exit 0 (format, 0-warning lint, typecheck, full suite —
  330+ tests incl. the new gate-2/solver/backdrop/interleaved coverage,
  knip).
- Kill harness `CYCLES=25` over **12 fault points** incl. the new
  `mid_stub_create` (a `!query !createwild` turn killed mid-placement):
  zero duplicate/lost events, zero corrupted images, zero torn flips,
  resume exact, convergence proofs (stub committed once, placed once,
  backdrop landed) — **zero provider calls, $0.00**.
- `verify-consistency` now sweeps the new natural keys (stub_created per
  world+id, materialized per world+id AND per square) and the create-tool
  transaction atomicity (stub event ⇒ backdrop job row; parentless ⇒ also
  the materialize job row) every cycle.

### (f) Gate green, RSS, budget — PASS

Idle RSS of the real-backend server, sampled twice between turns and at
session end: **122.8 MB** and **123.6 MB** (< 170). Spend $0.33/$4.00.

## Spend log (budget $4.00; session baseline `total_usage` 22.5952)

| What | Est. cost | Running total |
| --- | --- | --- |
| All builds, tests, 25-cycle harness (fakes/stub) | $0.00 | $0.00 |
| Turn 1: 3 mid-call queries + create + backdrop 1 (flash) | ~$0.07 | $0.07 |
| Turn 2: change_sublocation move | ~$0.01 | $0.08 |
| Loft turns (rejected nest + retry) + backdrop 2 | ~$0.08 | $0.16 |
| Turn 3: parentless create + backdrop 3 + map tile | ~$0.12 | $0.28 |
| Turn 4: continuation end + reflections + jump-open | ~$0.05 | **$0.33** |

(Exact total = 22.9287 − 22.5952 from `GET /v1/credits`; per-line split
estimated. A backdrop ≈ $0.03–0.05 on flash-class — cheaper than a reveal
tile; the DeepSeek multi-step narrator turns stay ≈ $0.01–0.03 each.)

## Notes for week 10

- **The mid-call query seam works on a real provider first try** — DeepSeek
  chained parentless/search/children queries and narrated between steps.
  This is the pattern M6 part 2's chat tools (`memoryquery`, `wikiquery`,
  `sessionquery`) will reuse.
- **Gate rejections are trail-only**: the model never sees them mid-call, so
  a refused create simply doesn't happen that turn (the user's next input
  got it through). If this bites often, feeding the rejection back as a
  tool ERROR result (the query seam already carries strings back) is the
  natural upgrade — owner call on priority.
- Backdrop style bible v2 + unfeathered composite are the proven config;
  expect the same iterate-by-looking loop when EXTERIOR parentless
  backdrops get more variety (v2's three samples: 2 interiors, 1 exterior).
- The week-8 live-SSE-frame nit did NOT recur this week (all live frames
  reached the open tab).
- Owner task still pending: **rotate the shared OpenRouter key** (external
  usage seen in week 8; none seen this week — baseline matched exactly).
