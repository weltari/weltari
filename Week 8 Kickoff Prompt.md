# Week 8 Kickoff — Milestone 5 part 2: writing into and reading out of the map (paste this to start the session)

Build the second half of Milestone 5 for Weltari in this repository (`D:\devproj\weltari`, remote `https://github.com/weltari/weltari`). Milestones 1–4 and M5 part 1 are complete: crash-safe engine + ledger, VN Scene page with two-gate tools, plugin loader, packaging + minisign self-update, the UI shell, the living fog map — and since week 7 the map's pixels are REAL (`docs/week7-results.md`): an `ImageSource` seam with the stub as permanent default, OpenRouter edit-mode generation with cross-tile coherence (context window + style bible v4 + fog fallback), eager painting on materialization, and a VLM seam with a QA tool. All six week-7 criteria PASS. I am not a professional developer — explain plainly, recommend, and let me decide only where a genuine value judgment remains.

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index.
2. `docs/week7-results.md` — what part 1 proved, the two real-backend bugs it found (image lease, lease-expiry overlap), the coherence addendum, and the open nits.
3. `docs/painter.md` + `docs/llm.md` — the seams you are extending: `TileRequest.context` / coverage `'window'` (the edit-mode contract Flow A reuses wholesale) and `VlmClient.describe` (the call shape Flow B reuses with `kind: 'classify_click'`).
4. Rev 4 §14 (`docs/Weltari V1 - Architecture & Structure (Rev 4).md`) — Flow A (steps 1–6: drawn region, GM form, crop ~1024², ledger job, composite-back, sublocation row + bubble at mask centroid) and Flow B (radius check → VLM classify → story LLM invents inside the classification → persist-or-discard).
5. `docs/ui-wireframes/pages/README.md` page 08 + UI Spec §1.8 — lasso/pencil and click-to-jump-in are THIS milestone; binding.
6. `docs/Coding Guide/AI Coding Guide.md` — A11 fences, B6 double gate, C2/C7, D8 (deps: ask first).

## Scope (recommended split — adjust with me at session start)

**Flow A — edit/add content (writing into the map):** user draws a region in `<wl-map>` (pencil/lasso; the drawn shape supplies the region — no segmentation model) + speaks intent; the GM/interview LLM fills a structured generation form (B6-gated); code crops with context margin and runs the EXISTING painter edit mode (`input_references`) against the drawn region; composite-back only the masked interior; sublocation row + pin at the mask centroid, region locked while in flight. The week-7 image lease (`painter:<image_id>`) already serializes; the context-window plumbing already carries crops.

**Flow B — jump in anywhere (reading out of the map):** click on explored ground → radius check first (inside a known radius = enter that sublocation, no model call) → outside all radii: crop + `VlmClient.describe({kind: 'classify_click'})` → schema-gated `{terrain_type or building_type, is_enterable, suggested_setting, style_tags}` with nearby DB labels as anchors → story LLM invents within the classification → persist or discard by creation flag (`transient` spawns never enter the DB).

Chats/Feed/Wiki remain M6+.

## Notes carried over from Week 7 (read these — they will save you real money)

- **Measured cost: ≈ $0.07 per generated tile** (image-output token pricing — 17× the naive text-token estimate). Estimate before any batch >10 calls; report the running total each summary; track EXACT spend via `GET https://openrouter.ai/api/v1/credits` deltas (record the baseline `total_usage` at session start).
- Models proven: `google/gemini-3.1-flash-image` ("Nano Banana 2") for tiles/edits, `google/gemini-3.5-flash` for the VLM, `deepseek/deepseek-v4-pro` for text. `google/gemini-3-pro-image` (~4×) is the untried quality escalation.
- The tile style bible lives in `tilePromptFor` (`ledger/handlers/painter.ts`); the edit-mode framing in `llm/image-source.ts`. Iterate BY LOOKING at real output (week-7 lesson: three prompt versions, then a fog-fallback code fix — text alone was not enough).
- Building-flavored stubs still paint slightly over the ¼-tile size cap (flooded cellar); watch it when Flow A starts placing buildings.
- **Latent bug class to fix early in week 8**: the lease-expiry overlap that duplicated painter events also lurks in the other slow LLM handlers (reflection, world-agent, world-cron.llm) — give their natural-key outcome events the same synchronously-fused idempotency re-check the painter got (see `docs/painter.md`), with an interleaved-execution regression test each.
- The kill harness must stay ZERO-cost: whatever Flow A/B adds, fakes drive it (`WELTARI_FAKE_LLM=1` + stub source). New fault points follow the `FaultPoint` union pattern.
- Windows dev box: preview viewport can collapse to 0×0 (`preview_resize` with explicit width/height fixes it); browser clicks via `preview_eval` dispatch, not `preview_click`; the screenshot tool times out on animating pages — verify with DOM samples + fetching `/v1/images/*` directly.
- `weltari-real` launch config = real-backend browser demo on a fresh temp DB (`%TEMP%\weltari-real`; delete for fresh). `weltari-masking` = free fake/stub demo (`%TEMP%\weltari-mask`).
- The OpenRouter key sits in `.env` (gitignored; `.gitleaks.toml` allowlists it). I may rotate the key — if real calls suddenly 401, ask me.
- Git pushes to main: I will approve them (run the push and let me approve, or hand me the command).

## Success criteria to demonstrate (proposal — confirm at session start)

(a) Flow A end-to-end in the browser: draw a lasso region on explored ground + type intent → GM form (B6-gated) → painter edit job → the edit appears composited in `<wl-map>`, region locked while in flight, neighbors pixel-untouched outside the mask (composite-back proof); (b) Flow B: a click inside a known radius enters that sublocation with ZERO model calls; a click outside all radii yields a schema-gated classification and a story-LLM scene inside it; garbage classification → rejected, zero rows; `transient` leaves no DB row; (c) stub/fake defaults: `npm run gate` + `CYCLES=25` harness green at $0.00, including any new fault points; (d) your own visual inspection of ≥3 Flow-A edits recorded in `docs/week8-results.md` (what you rejected included); (e) provider failures during edit/classify park cleanly, no half-visible pixels ever; (f) gate green, idle RSS < 170 MB, spend within budget.

## Budget (owner)

Total real-provider budget for the week: **$[OWNER: fill in — week 7 used $3.52 of $5, and edits cost the same ≈ $0.07/call]**. Fake/stub remains the default everywhere — real backends run only when I've set the env.

## Process rules (unchanged)

- Small conventional commits (one logical change each); `npm run gate` must exit 0 before anything is called done; tests + docs page in the same commit.
- Never modify the spec/session documents in `docs/` (Brief, UI Spec, Stack Session/, Coding Guide/, Rev 3/Rev 4, ui-wireframes/).
- Modifying existing `tests/invariants/` files needs my `invariant-change` label — add new invariant tests freely.
- Zero new deps expected without asking; versions exact-pinned; secrets only via env.
- After each milestone-sized step, summarize plainly what exists and what's next.
