# Week 8 results — M5 part 2: writing into and reading out of the map

All six success criteria PASS. Real-provider spend for the week: **$0.93
of the $5.00 budget** (exact, from OpenRouter's credits endpoint deltas:
21.6618 → 22.5952; the key also carries ~$0.14 of unrelated external usage
from before the first real call, excluded and flagged to the owner).

## What was built

- **Lease-expiry overlap hardening** (week-7 bug class, fixed FIRST as the
  kickoff ordered): reflection, world-agent, both world-cron classes and
  materialize now re-check their idempotency key synchronously fused to the
  append — an overlapped retry costs one duplicate generation and a `warn`,
  never a duplicate event. Interleaved-execution regression test per handler.
- **Flow A — writing into the map** (Rev 4 §14 steps 1–6): pen/lasso drawing
  in `<wl-map>` + intent box → `POST /v1/commands/map-edit` (durable
  `map_edit.requested`, one idempotent `map_edit` job) → GM form through the
  full B6 double gate (new CallKind `map_edit`; the user's intent travels
  delimiter-wrapped, B14) → `sublocation.created` (pin at the shoelace mask
  centroid, footprint = the drawn polygon) → painter edit job under the
  per-image lease (the region lock), **composite-back of ONLY the masked
  polygon interior**. All geometry code-owned (`editGeometry`).
- **Flow B — reading out of the map** (Rev 4 §14 steps 1–5): the radius
  check answers the map-click command synchronously — a click inside a
  footprint or `SUBLOCATION_RADIUS` (half a fog square) enters that
  sublocation with ZERO model calls and zero rows. Outside all radii: crop
  the CURRENT composite around the click → `VlmClient.describe({kind:
  'classify_click'})` with nearby DB labels as anchors → schema-gated
  classification (exactly one of terrain_type/building_type + is_enterable +
  suggested_setting + style_tags) → story LLM invents INSIDE it (new
  CallKind `jump_in`) → persist-or-discard by the invention's creation flag:
  one `map_click.resolved` event; `created` IS the persistent spawn's row,
  `transient` never becomes a sublocation.
- **Protocol 0.9.0**: map-edit + map-click commands, `map_edit.requested`,
  `sublocation.created`, `map_click.resolved`, optional `job_key` on
  job.failed/job.parked (clients release region locks on parks).
- **wl-map 0.5.0**: pen control (wireframe 08), persistent intent box,
  locked-region overlay (grey polygon veil + centroid spinner) from the
  durable intent to painter.completed/job.parked; local radius rule
  (footprint containment → nearest pin within half a square) dispatching
  the normal `wl-map-jump`; classify pulse ring; transient discovery card;
  created spawns auto-jump into a scene.
- **Two latent sharp-pipeline bugs fixed** (found by the polygon-mask test):
  sharp reorders ops inside one pipeline — `removeAlpha` ran after
  `joinChannel` (stripping the just-joined mask: **the M2 feather never
  actually applied**; composites were hard rect pastes) and `resize` ran
  before `extend` (the feather mask was 16 px larger than declared). Both
  masks now build/apply across two sharp passes; the feather feathers for
  the first time.

## The Flow-A visual iteration (criterion d — 6 edits inspected, 4 rejected)

The week-7 lesson held: text reasoning alone was never enough — every fix
below came from LOOKING at real output (all maps + 8× zooms in
`docs/week8-assets/`).

| # | Edit | Backend framing | Verdict |
| --- | --- | --- | --- |
| 1 | mill pond (common-room square) | week-7 "continue" framing | **REJECTED** — 537 px changed (all inside the region, zero spill — composite-back proof) but NO pond: the reveal framing says "keep every already-painted area as it is", and the editing model faithfully changed nothing. Fix: `TileRequest.mode: 'continue' \| 'modify'`. |
| 2 | watchtower (shrine square) | modify framing v1 ("change the middle") | **REJECTED** — 656 px changed, zero spill, but no legible tower: the target was ~1/9 of the window the model repaints and averaged away. Fix: half-size context margin for modifies (target fills the central half). |
| 3 | signal tower (shrine square) | modify v2 (REPLACE + bold language) | **REJECTED** — 681 px changed, zero spill, still no legible feature. Words alone do not localize the change. Fix: draw the mask ON the reference — a red polygon outline on the copy sent to the model ("region-in-words" made literal for the no-mask branch). |
| 4 | ridge beacon (common-room square) | red outline + flash model | **PARTIAL** — 761 px changed, a real visible ridge-with-track landed where drawn, zero red remnants; but the tower itself still not legible at 46 px. Conclusion: flash-class reproduces its reference; quality is the lever. |
| 5 | ridge watchtower (cellar square) | red outline + **gemini-3-pro-image** | **ACCEPTED** — a clear reddish stone tower with a visible fire glow, exactly inside the drawn polygon; 792 px changed, zero spill, zero red remnants. |
| 6 | round pond with jetty (shrine square) | final config (`WELTARI_EDIT_IMAGE_MODEL` default) | **REJECTED** — 813 px changed, zero spill, but the model painted PART OF THE RED GUIDE OUTLINE back into the crop (a visible V-shaped line) and no clear pond. Instruction-based marker removal is not reliable. Fix: shrink the compositing polygon 3 px toward its centroid — the boundary band where the outline lives can never reach the canvas again. (Edit 6's remnant stays in the map history — the lasso itself is the designed repair.) |
| 7 | round pond retry (cellar square) | pro + shrunk mask | **ACCEPTED** — a clear dark round pond with a jetty, exactly inside the drawn polygon; 616 px changed, zero spill, zero red pixels added. |

Resulting config: `WELTARI_EDIT_IMAGE_MODEL` (default
`google/gemini-3-pro-image`, ~4× per-image cost — but edits are rare,
user-triggered and quality-critical) routes mode-`modify` paints; reveals
stay on flash-class `WELTARI_IMAGE_MODEL`. Cost per edit ≈ $0.24 (GM form
+ pro edit image) vs ≈ $0.08 flash.

## Success criteria

### (a) Flow A end-to-end in the browser — PASS

`weltari-real` (fresh temp DB, real DeepSeek GM + real edit paints): drew a
lasso + typed intent → locked-region overlay (grey veil + dashed outline +
spinner) through the whole generation window → GM form committed
(`sublocation.created`, e.g. "The Mill Pond — Rain-swollen water laps at
the millrace; a solitary heron stands motionless among the reeds…") → edit
paint composited → `<wl-map>` swapped the tile live, pin at the mask
centroid. **Composite-back proof on every edit**: pixel-diff before/after
per edit — every changed pixel inside the edit region, ZERO outside
(537/656/681/761/792/813/616 changed px respectively, 0 spill each time).

### (b) Flow B — PASS

- Radius click (real server, `curl` + browser): answers 202
  `enter The Common Room` synchronously — nothing enqueued, ZERO model
  calls, zero rows.
- Classify click outside all radii (real gemini-3.5-flash + DeepSeek): the
  VLM classified the cropped surroundings, the story LLM invented INSIDE
  the classification — "The Narrow Stone Bridge" (persistent → one
  `map_click.resolved` that IS the row; pin + auto-jump into a scene
  proven on the fake stack in-browser).
- Garbage → rejected, zero rows: proven offline (`map-click.test.ts` —
  non-JSON, both-types-claimed, garbage invention: all rejected with zero
  events) AND observed live: five consecutive real DeepSeek GM-form
  rejections (`map_edit.form` schema gate) parked the job with zero rows.
- `transient` leaves no DB row: `map-click.test.ts` proves no sublocation
  ever appears in the registry; the resolved event carries no
  sublocation_id.

### (c) Stub/fake default: zero-cost gate + harness — PASS

- `npm run gate` exit 0 (format, 0-warning lint, typecheck, full suite —
  330+ tests, knip).
- Kill harness `CYCLES=25` over **11 fault points** incl. the new
  `mid_map_edit` and `mid_map_click`: zero duplicate/lost events, zero
  corrupted images, zero torn flips, resume exact, convergence proofs
  (edit created exactly once, click resolved exactly once) — **zero
  provider calls, $0.00** (fake LLM + new fake VLM + stub source).
- `verify-consistency` now sweeps the new natural keys
  (sublocation.materialized per world+square, sublocation.created per
  world+edit_id, map_click.resolved per world+click_id) every cycle.

### (d) Own visual inspection of ≥3 Flow-A edits — PASS

Seven edits inspected at 8× zoom, four rejected + one partial — see the
iteration table above and `docs/week8-assets/` (full maps, before/after
zooms per edit, `map-final.png`).

### (e) Provider failures park cleanly — PASS (observed live, unplanned)

A real DeepSeek run answered the GM form with unparseable output five
times (the intent asked for a mill pond next to an existing "The Mill
Pond" anchor — the model balked at the duplicate). Every reply was
schema-rejected (reject, never repair), the job parked after max attempts,
`job.parked` carried the edit's job_key, ZERO rows and ZERO pixel changes
— and the region lock released. Nit observed: one live SSE frame (the
park event) did not reach an already-connected browser tab; the reload's
`Last-Event-ID` replay healed it exactly as designed. Watch in week 9.

### (f) Gate green, RSS, budget — PASS

Idle RSS of the real-backend server, sampled twice across the demo
session: **138.9 MB** and **112.7 MB** (< 170). Spend $0.93/$5.00.

## Spend log (budget $5.00; session baseline `total_usage` 21.6618)

| What | Est. cost | Running total |
| --- | --- | --- |
| All builds, tests, harness (fakes/stub) | $0.00 | $0.00 |
| Fresh-boot trio (3 real tiles) | ~$0.21 | $0.21 |
| Edit 1 (flash, continue framing) + GM | ~$0.08 | $0.29 |
| Parked edit (5 GM rejections, no image) | ~$0.03 | $0.32 |
| Edits 2–4 (flash iterations) + GM | ~$0.24 | $0.56 |
| Edit 5 (pro model) + GM | ~$0.17 | $0.73 |
| Flow B classify (VLM + DeepSeek) + radius click | ~$0.01 | $0.74 |
| Edits 6–7 (pro, final config) + GM | ~$0.19 | **$0.93** |

(Exact total = 22.5952 − 21.6618 from `GET /v1/credits`; per-line split
estimated. The key also accrued ~$0.14 of unrelated usage between session
start and the first real call — excluded, flagged to the owner.)

## Notes for week 9

- The lease-expiry overlap class is now closed across every handler; the
  fused re-check + interleaved test is the pattern for any new slow handler.
- Flow-A edit quality: the red-outline marker + pro-class model is the
  proven combination; flash-class is fine for reveals only. If edit volume
  ever matters, try FLUX Fill (the mask-capable branch of Rev 4 §14's
  table) before paying pro-class prices.
- The live-SSE-frame drop (criterion e nit): one browser tab missed one
  live event while staying "open"; replay healed it. If it recurs,
  instrument `attachSseClient` write errors.
- Transient discoveries currently record their name/description in the
  `map_click.resolved` audit event (never a sublocation row); if "never
  enters the DB" should mean the event log too, the invention would move
  to an ephemeral stream frame — owner call.
- `.env` still holds the shared testing key (external usage visible on
  it); rotation after M5 remains an owner task.
