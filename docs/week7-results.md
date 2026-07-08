# Week 7 results — M5 part 1: the painted map (real generation backends)

Status: IN PROGRESS (real-provider runs pending the owner's key in `.env`).

## What was built

- **ImageSource seam** (`painter/image-source.ts`): painter jobs pull pixels
  from a source; `stub` stays the hard default (deterministic, free, offline).
  `WELTARI_IMAGE_BACKEND=openrouter` + `OPENROUTER_API_KEY` selects
  `createOpenRouterImageSource` (`llm/image-source.ts`, the AI-SDK fence) —
  OpenRouter `/v1/images`, `WELTARI_IMAGE_MODEL` default
  `google/gemini-3.1-flash-image` ("Nano Banana 2"). Composite / temp+rename /
  event-keyed idempotency mechanics unchanged.
- **Eager paint on materialize**: `sublocation.materialized` enqueues THE
  painter job for its square (deterministic key `painter:map:<world>:sq-c-r`);
  the occupied no-op path re-enqueues (heals a kill between event and enqueue);
  the fixture trio enqueues at every boot (deduped forever).
- **VLM seam** (`llm/vlm.ts`): image + prompt in → raw gate-1 text out
  (`WELTARI_VLM_MODEL` default `google/gemini-3.5-flash`); consumer
  `tools/m5-map-qa.mjs` gates with `parseLlmJson` → `validateAt`
  (`mapQaVerdictSchema`). Week-8 Flow B reuses the same call shape.

## Fact-check (before any code — kickoff step 1)

- OpenRouter model catalog (2026-07-08): `google/gemini-3.1-flash-image`
  ("Nano Banana 2", image+text out, $0.50/M in $3/M out),
  `google/gemini-3-pro-image` (Nano Banana Pro, ~4× — the quality escalation),
  `google/gemini-3.5-flash` (multimodal in, text out — the VLM),
  `deepseek/deepseek-v4-pro` ($0.435/M in, $0.87/M out — the text LLM for
  real runs, owner's pick).
- Pinned `ai@6.0.219` exports `generateImage`; pinned
  `@openrouter/ai-sdk-provider@2.10.0` ships `imageModel()` against
  `/api/v1/images` (b64 out, `aspect_ratio`, `input_references` for week-8
  editing) AND maps chat-message `images[]` to file parts as a fallback path.
  **Zero new dependencies.**

## Success criteria

### (a) Real reveal end-to-end in `<wl-map>` — chain PASS on stub; real pixels PENDING (needs key)

- Browser check (fresh temp DB, `weltari-masking` launch config, FakeLLM
  7 s delay, stub source): boot paints the fixture trio (tile composite
  visible on Map open); Explore on fog square (0,0) → spinner (§1.14 masking)
  → `sublocation.materialized` ("The Mill Pond" pin, square explored) →
  eager paint → `painter.completed` → `<wl-map>` swapped the tile to the NEW
  composite. Fetched via `GET /v1/images/...` and inspected: all 4 squares
  painted at their correct grid rects, feathered edges, base untouched
  elsewhere. Same run to repeat with `WELTARI_IMAGE_BACKEND=openrouter`.

### (b) Stub stays the default: gate + harness green at zero cost — PASS

- `npm run gate` exit 0 (format, lint 0 warnings, `tsc -b`, 248 tests, knip).
- Kill harness `CYCLES=25`: 25 cycles over 9 fault points, zero duplicate or
  lost events, zero corrupted images, zero torn update flips, resume exact —
  with `WELTARI_FAKE_LLM=1` and the stub image source: **zero provider calls,
  $0.00**.
- Kill during a REAL paint: PENDING (needs key; manual spot check).

### (c) VLM QA tool on the real provider — PENDING (needs key)

- Offline half already proven in `vlm.test.ts`: a garbage/non-JSON reply is
  schema-rejected (reject, never repair), zero rows by construction.

### (d) Own visual inspection of ≥3 painted squares — PENDING (needs key)

### (e) Provider failures park cleanly — PASS (failure half; retry-success half with key)

- Spot check (scratchpad `m5-failure-park.mjs`): server with
  `WELTARI_IMAGE_BACKEND=openrouter` + a deliberately bogus key + FakeLLM,
  fresh temp DB, `WELTARI_LEASE_SECONDS=2`. Explore → materialize commits
  ("The Mill Pond") → the eager paint job hits the real backend and fails
  (401) through all attempts. Verdict: server alive the whole time, ZERO
  `painter.completed` events, images dir holds `base.png` only — no composite,
  no `.tmp` orphan, no half-visible tile (composite-on-success held). $0.00.

### (f) Gate green, RSS < 170 MB, spend within budget

- Gate: PASS (see b). RSS + spend: recorded at the end of the week.

## Spend log (budget: $5.00)

| When | What | Cost | Running total |
| --- | --- | --- | --- |
| — | everything so far (stub/fake/offline) | $0.00 | $0.00 |
