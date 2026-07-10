# Week 7 Kickoff — Milestone 5 part 1: the painted map (real generation backends) (paste this to start the session)

Build the first half of Milestone 5 for Weltari in this repository (`D:\devproj\weltari`, remote `https://github.com/weltari/weltari`). Milestones 1–4 are complete and pushed: crash-safe engine + ledger, VN Scene page with two-gate tools, plugin loader, packaging + minisign self-update, the UI shell (Scene/Map/Gameday/Config), splash + History surfaces, and the living map — fog, Explore, and LLM-generated sublocation stubs behind the B6 double gate (protocol 0.8.0, wl-map plugin 0.3.0, 9-point kill harness). All criteria PASS (`docs/week1-results.md` … `docs/week6-results.md`). I am not a professional developer — explain plainly, recommend, and let me decide only where a genuine value judgment remains.

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index.
2. `docs/painter.md` — the module you are upgrading: crash-safety (crop → feather → composite-back, temp+rename, region leases) is DONE and proven; only the stub tile generator becomes real. Composite-back stays the sole preservation guarantee (Rev 4 §14 image-backend table).
3. Rev 4 §14 (`docs/Weltari V1 - Architecture & Structure (Rev 4).md`) — materialization reuses the Flow A contract; placement stays code-owned; "the database is the source of truth, not the image".
4. `docs/Coding Guide/AI Coding Guide.md` — A11 (image SDK stays fenced in `painter/` or `llm/`), B-llm (every model output is boundary data), C2 (provider failures are operational Results), D8 (any new dep needs `docs/dependencies.md` + exact pin + ASK FIRST).
5. `docs/llm.md` + `docs/engine.md` — the LlmClient seam and the materialize job you are chaining from.
6. `docs/ui-wireframes/pages/README.md` page 08 + UI Spec §1.8 — unchanged and binding; lasso/pencil (Flow A editing) and Flow-B click classification are week 8, do NOT stub them.

## Scope decision (already made)

This half makes the map's pixels REAL: a real image-generation backend for the painter, eager tile painting when a square materializes, and a VLM seam — used first for your OWN quality control: you must look at the generated map yourself and judge it, not just assert that bytes exist. Flow A lasso editing and Flow B click classification build on these seams in week 8. Chats/Feed/Wiki remain M6+.

## What to build, in recommended order

**1. Fact-check the image path (before any code):** the owner has ONE key — OpenRouter. Verify with current docs (context7/web search) how to generate images through it with our pinned `ai@6` + `@openrouter/ai-sdk-provider@2.10.0` (candidate model: `google/gemini-2.5-flash-image` — the no-mask branch of Rev 4 §14's table; composite-back is already our guarantee). If the pinned SDK can't do image output, a plain `fetch` to the OpenRouter REST endpoint inside the fence is fine — prefer zero new deps; anything new: ask me first with the `docs/dependencies.md` entry drafted.

**2. Real tile source behind the existing seam:** an `ImageSource` interface in `painter/` — `stub` (today's deterministic generator; stays the DEFAULT so tests, the kill harness and CI stay free and deterministic) and `openrouter` (env-selected, e.g. `WELTARI_IMAGE_BACKEND=openrouter`). Prompt = the sublocation stub's name + description + neighboring squares' names (world coherence). Provider failure → operational Result → runner retry (C7); the composite/temp+rename/idempotency mechanics must NOT change — a killed real-paint job regenerates (the only retry cost is one duplicate API call, Rev 4 §14). NOTE: real generation is not byte-deterministic — the idempotency check must key on the completed EVENT (it already does), and the "byte-identical rerun" unit tests keep running against the stub.

**3. Materialization paints its square:** when `sublocation.materialized` commits, eagerly enqueue ONE painter job for that square's region (Rev 4: materialization = the map-presence job; region lease already prevents overlap). The wl-map plugin already refreshes tiles on `painter.completed` — the reveal should now show real terrain. Keep the fixture trio painted too (seed or first-boot jobs — your call, document it).

**4. The VLM seam (B-llm):** a multimodal call through the LLM fence — image + prompt in, structured JSON out through `validateAt` (B6 gate 1 pattern, like the materialize stub). First consumer: a `tools/m5-map-qa.mjs` spot-check that feeds the current composited map + a stub's description to the VLM and asserts the described sublocation is plausibly visible. This seam is what Flow B classifies clicks with in week 8 — design the call shape for that, build only the QA consumer now.

**5. Look at the map yourself (this is a success criterion, not a nicety):** after painting ≥3 explored squares against the real backend, fetch the composited image (`GET /v1/images/<path>`), save it, and READ the image file directly — judge: does each tile match its stub description? Are the feathered seams acceptable? Does the map read as one place? Record your verdicts (and the image paths) in `docs/week7-results.md`; iterate the generation prompt until you would show it to me without apologizing.

**6. Hygiene:** docs pages in the same commits (painter.md, llm.md, dependencies.md if anything lands); no protocol changes expected (painter.completed already carries path+sha256) — if you need one, additive minor bump as usual.

## Success criteria to demonstrate

(a) `WELTARI_IMAGE_BACKEND=openrouter` + key: Explore a fog square → the reveal shows REAL painted terrain in `<wl-map>` end-to-end (materialize → eager paint → painter.completed → tile refresh), with the spinner/§1.14 masking covering the longer real window; (b) stub stays the default: `npm run gate` and `CYCLES=25` kill harness green with ZERO provider calls and zero cost; a kill during a real paint converges on retry (manual spot check, one duplicate API call max); (c) the VLM QA tool passes on the real provider: image + description in → schema-gated JSON verdict out, and a garbage/non-JSON reply is rejected with zero rows written; (d) your own visual inspection of ≥3 painted squares is recorded in week7-results.md with honest verdicts (including what you rejected and re-prompted); (e) provider failures during paint/VLM park cleanly after retries — never a corrupted or half-visible tile (composite-on-success), never a crash; (f) `npm run gate` green, idle RSS < 170 MB, spend within the budget below.

## Budget (owner)

Total real-provider budget for the week: **$[OWNER: fill in — suggest $5]**. Reference prices to check at session start: gemini-2.5-flash-image ≈ $0.04/image; VLM calls (flash-class) < $0.01 each; text turns at dev prefix (800 tokens) are negligible. Estimate before any batch >10 real calls and tell me the running total in each summary. Fake/stub remains the default everywhere — real backends run only when I've set the env.

## Notes carried over from Week 6

- Fresh worlds boot scene-less since 0.8.0 (the splash is the entry surface); the fixture trio arrives as seeded `sublocation.materialized` events. Old dev DBs start fully fogged — always demo on a fresh temp DB (`.claude/launch.json` `weltari-masking`; fresh = delete `%TEMP%\weltari-mask`).
- Fake-LLM triggers: `!move <subloc>` · `!art char:elias <pose>` · `!end [rest|continuation|travel]` · `!badshape` · `!ghosttool`; `WELTARI_FAKE_LLM_DELAY_MS` simulates the generation window. The materialize fake returns a fixed JSON stub ("The Mill Pond").
- The screenshot tool times out on infinitely-animating pages (map spinner, cover) — verify with timed DOM samples / `preview_eval`; the preview viewport can collapse to 0×0 after reloads (`preview_resize` fixes it). Browser clicks via `preview_eval` are more reliable than `preview_click` here.
- Windows dev box: `EADDRINUSE` streaks are the box, not the code; `self-watch.test.ts` can flake if run right after a harness run (port ranges overlap) — rerun in isolation before suspecting the code.
- The example-world fixture intentionally fails `verify-consistency`'s job-row check (row-inspection aid, pre-existing).
- CI runs structural scripts `npm run gate` does not (`scripts/check-*.mjs`) — run them locally when touching server code.
- Git pushes to main: I will approve them.

## Process rules (unchanged)

- Small conventional commits (one logical change each), pushed as you go; `npm run gate` must exit 0 before anything is called done; tests + docs page in the same commit.
- Never modify the spec/session documents in `docs/` (Brief, UI Spec, Stack Session/, Coding Guide/, Rev 3/Rev 4, ui-wireframes/).
- Modifying existing `tests/invariants/` files needs my `invariant-change` label — add new invariant tests freely.
- Zero new deps expected without asking; versions exact-pinned; secrets only via env (`OPENROUTER_API_KEY` is already the one key).
- After each milestone-sized step, summarize plainly what exists and what's next.
