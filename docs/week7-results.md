# Week 7 results — M5 part 1: the painted map (real generation backends)

All six success criteria PASS. Real-provider spend: **$2.82 of the $5.00
budget** (exact, from OpenRouter's credits endpoint before/after). Two real
correctness bugs were found BY the real backends and fixed with regression
tests — the stub could never have exposed either.

## What was built

- **ImageSource seam** (`painter/image-source.ts`): painter jobs pull pixels
  from a source; `stub` stays the hard default (deterministic, free, offline).
  `WELTARI_IMAGE_BACKEND=openrouter` + `OPENROUTER_API_KEY` selects
  `createOpenRouterImageSource` (`llm/image-source.ts`, the AI-SDK fence) —
  OpenRouter `/v1/images`, `WELTARI_IMAGE_MODEL` default
  `google/gemini-3.1-flash-image` ("Nano Banana 2").
- **Eager paint on materialize**: `sublocation.materialized` enqueues THE
  painter job for its square (key `painter:map:<world>:sq-<col>-<row>`); the
  occupied no-op path re-enqueues (heals a kill between event and enqueue);
  the fixture trio enqueues at every boot (deduped forever).
- **VLM seam** (`llm/vlm.ts`): image + prompt in → raw gate-1 text out
  (`WELTARI_VLM_MODEL` default `google/gemini-3.5-flash`); consumer
  `tools/m5-map-qa.mjs` gates with `parseLlmJson` → `validateAt`. Week-8
  Flow B click classification reuses the same call shape.

## Fact-check (before any code — kickoff step 1)

- OpenRouter catalog (2026-07-08): `google/gemini-3.1-flash-image` ("Nano
  Banana 2") for tiles; `google/gemini-3-pro-image` (Nano Banana Pro, ~4×)
  as the unused quality escalation; `google/gemini-3.5-flash` as the VLM;
  `deepseek/deepseek-v4-pro` as the real-run text LLM (owner's pick).
- Pinned `ai@6.0.219` exports `generateImage`; pinned
  `@openrouter/ai-sdk-provider@2.10.0` ships `imageModel()` against
  `/api/v1/images` (b64, `aspect_ratio`, `input_references` for week-8
  editing). **Zero new dependencies.**
- Measured tile cost: **≈ $0.07/image** (billed via special image-output
  token pricing — 17× the naive text-token estimate; always measure).

## Two real bugs the real backend exposed

1. **Cross-region paint race (lost tiles).** Painter jobs chain composites
   per image, but M2's leases were per REGION — three concurrent ~10 s boot
   generations all read the same base and the last writer dropped the other
   tiles (`docs/week7-assets/` run 1 kept only one of three trio tiles).
   Invisible on the ~5 ms stub. Fix: `serial_group painter:<image_id>` —
   plus regression test (two due squares never claimable together).
2. **Lease-expiry overlap (duplicate events + hash mismatches).** A slow
   generation outlives a short lease; the sweep reclaims the "dead" job and a
   second execution overlaps the first — duplicate `painter.completed`
   events, and job-key-named files overwritten so event hashes mismatched
   (caught red-handed by `verify-consistency` in the first kill test). Fix:
   content-addressed output filenames (bytes' sha256 — racers write different
   files; a committed event always names a file matching its hash) + a
   last-instant idempotency re-check synchronously fused to the append
   (single-process: interleaving only at `await` points). Regression test
   interleaves two executions via a gated slow source. Note for week 8+: the
   same overlap class is latent in other slow LLM handlers (reflection,
   world-agent) — their natural-key events deserve the same fused re-check.

## Success criteria

### (a) Real reveal end-to-end in `<wl-map>` — PASS

Browser (`weltari-real` launch config, fresh temp DB, real DeepSeek +
Nano Banana 2): boot painted the trio; Explore on fog square (1,1) →
spinner over the square (§1.14 masking, verified in DOM through the ~20 s
real window) → `sublocation.materialized` ("The Ferry Slip", DeepSeek) →
eager paint → `painter.completed` → `<wl-map>` swapped the tile live.
Evidence: `docs/week7-assets/map-browser-real-reveal.png`.

### (b) Stub default: zero-cost gate + harness; kill-during-real-paint converges — PASS

- `npm run gate` exit 0; kill harness `CYCLES=25`: 25 cycles over 9 fault
  points, zero duplicates/losses/corruption, **zero provider calls, $0.00**.
- Real-paint kill spot check: SIGKILL at `mid_painter` (file renamed, event
  NOT appended) during a real generation; restart converged — exactly one
  `painter.completed` per square, `verify-consistency` green including the
  painter hash check; cost = one duplicate API call (as designed, Rev 4 §14).

### (c) VLM QA tool on the real provider — PASS

- "The Broken Milestone" vs the v3 map → `{visible: true, confidence:
  "high"}` with an accurate location description (gemini-3.5-flash, ~2.7 s,
  <$0.01). Negative control ("The Glass Lighthouse", not on the map) →
  `{visible: false, confidence: "high"}`, exit 1.
- Garbage/non-JSON reply → schema-rejected (reject, never repair), zero rows
  by construction — proven offline in `vlm.test.ts`, and the same gate was
  seen rejecting a real chatty DeepSeek materialize reply live (retry
  regenerated a valid one).

### (d) Own visual inspection of ≥3 painted squares — PASS (3 prompt iterations)

All maps in `docs/week7-assets/`; every tile inspected at 4× zoom.

- **Prompt v1** (`map-prompt-v1.png`): REJECTED 3/5 — indoor-flavored stubs
  became interior floor plans (Common Room: octagonal table layout; Cellar:
  murky interior), structures came back as side-view illustrations (a bridge
  seen from the bank, horizon visible), parchment vignette borders.
- **Prompt v2** (`map-prompt-v2.png`): camera + depiction level pinned
  (orthographic, rooftops-in-landscape, edge-to-edge). 4.5/5 — remaining
  reject: the Common Room's cutaway roof glowed orange and read as a burning
  building at map scale.
- **Prompt v3** (`map-prompt-v3.png`): ACCEPTED 5/5 — inn with intact
  rooftops; cellar as dark riverside pool with floating casks; shrine in a
  grove amid farm fields; "The Broken Milestone" as a split standing stone
  at a crossroads (best of batch); ferryman's shack + jetty. Consistent
  palette and scale; feathered seams read fine.
- Honest limitation kept: roads/rivers do not geometrically continue across
  tile seams (tiles generate independently; the neighbor names give thematic,
  not pixel, coherence). Rev 4's crop-context editing path
  (`input_references`) is the week-8+ fix; acceptable under fog at V1 scale.

### (e) Provider failures park cleanly — PASS

Bogus-key spot check: explore → materialize commits (fake) → the real-backend
paint fails 401 through all attempts and parks. Server alive throughout, ZERO
`painter.completed`, images dir holds `base.png` only — no composite, no
`.tmp` orphan, no half-visible tile (composite-on-success). $0.00.

### (f) Gate green, RSS < 170 MB, budget — PASS

Gate green (all suites; final count after new tests). Idle RSS of the
real-backend server after the browser session: **151.2 MB**. Spend $2.82/$5.

## Spend log (budget $5.00; baseline usage 18.0041)

| What | Est. cost | Running total |
| --- | --- | --- |
| Stub/fake/offline work, harness, park test | $0.00 | $0.00 |
| Run 1 (prompt v1, race discovered): 5 tiles + 3 DeepSeek | ~$0.36 | $0.36 |
| Run 2 (prompt v1, lease fixed): 5 tiles + 2 DeepSeek | ~$0.35 | $0.71 |
| Run 3 (prompt v2): 5 tiles + 2 DeepSeek | ~$0.36 | $1.07 |
| Kill test #1 (FAILED — lease-race duplicates): ~15 tiles | ~$1.05 | $2.12 |
| Run 4 (prompt v3, accepted): 5 tiles + 2 DeepSeek | ~$0.36 | $2.48 |
| Kill test #2 (PASS): 4 tiles | ~$0.28 | $2.76 |
| VLM QA ×2 + browser real reveal (3+1 tiles + DeepSeek) | ~$0.06 | $2.82 |
| Coherence fix: 2 runs (10 tiles) + VLM QA | ~$0.70 | **$3.52** |

(Exact totals from `GET /v1/credits` deltas; per-line split estimated.)

## Addendum: cross-tile coherence (owner-reported, fixed same week)

The owner reviewed the v3 map and rejected what the criteria run had noted
only as a "limitation": mixed viewing angles, per-tile styles, houses cut off
at seams, roads that stop dead. Fix (all under the existing seams, zero new
deps, prompt+context only — composite-back untouched):

1. **Context-window edit mode**: the compositor crops the region plus one
   region-size margin of CURRENT pixels and the OpenRouter source sends it as
   an `input_references` image — "continue this exact painting into the
   checkerboard fog". Coverage `'window'` results are cut back to the target
   rect. Windows are 3×3 region-units (2×3/3×2 at map edges; aspect ratio
   follows).
2. **Style bible v4**: one shared block pins camera (orthographic), palette,
   light direction (NW, shadows SE), building scale (largest ≤ ¼ tile, 1–3
   max — readable at 64 px without dominating) and edge discipline (buildings
   stay clearly inside the tile; only roads/rivers/fields/forests may run off
   the edges, so they CAN continue).
3. **Fog fallback**: an all-grey window (checkerboard = fog has no chroma)
   means there is nothing to continue — edit mode anchored on nothing drifts
   (seen live: the seeding tile came out as a zoomed-in courtyard and every
   subsequent tile faithfully continued the drift,
   `map-coherence-drift.png`). Such tiles paint plain with the style bible.

Verified on a real run (`map-coherence-final.png`, `seam-junction-4x.png`):
the river flows from "The Ferryman's Hut" through the Common Room tile into
"The Ferry Landing" as ONE painting; the isolated shrine tile matches via the
style bible alone; VLM QA confirms the hut+dock visible (high confidence).
Remaining nit: strongly building-flavored stubs (the flooded cellar) still
paint slightly over the ¼-tile size cap — soft-seam acceptable, watch in
week 8. Mode selection is observable in the debug log (`edit_mode`) and in
input tokens (~240 plain vs ~640 with window).

## Notes for week 8

- Flow B classify reuses `VlmClient.describe` with a `classify_click` kind —
  the call shape is already there; only the prompt/schema and the radius
  bypass are new.
- Flow A lasso editing should pass the crop as `input_references` (the
  provider's `/v1/images` supports it) — that is also the tool for cross-tile
  geometric coherence.
- Latent lease-overlap class in reflection/world-agent handlers (see bug 2).
- `.env` now holds the testing key; owner may want to rotate it after M5
  (it was shared in a chat transcript).
