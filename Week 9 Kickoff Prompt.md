# Week 9 Kickoff — Milestone 6 part 1: the in-scene creation loop (paste this to start the session)

Build the first half of Milestone 6 for Weltari in this repository (`D:\devproj\weltari`, remote `https://github.com/weltari/weltari`). Milestones 1–5 are complete: crash-safe engine + ledger, VN Scene page with two-gate tools, plugin loader, packaging + minisign self-update, the UI shell, the living fog map — and since week 8 the map is a two-way surface (`docs/week8-results.md`): Flow A lasso edits (GM form → pro-model edit paint → composite-back of only the drawn polygon) and Flow B click-to-jump-in (radius check → VLM classify → story invention → persist-or-discard), 11 kill-harness fault points, all at $0.93 of $5. I am not a professional developer — explain plainly, recommend, and let me decide only where a genuine value judgment remains.

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index.
2. `docs/week8-results.md` — what part 2 proved: the 7-edit visual iteration (mode `modify`, the red-outline pixel marker, `WELTARI_EDIT_IMAGE_MODEL`), the two sharp-pipeline bugs (the M2 feather never applied until now), the live GM-form park, and the open nits below.
3. Rev 4 §6 + §14 (`docs/Weltari V1 - Architecture & Structure (Rev 4).md`) — the creation-authority note (§ "Sublocation creation authority", resolved): the Narrator creates identity stubs (children freely; parentless only after a strict all-parentless query); `materialize_sublocation` owns map presence with code-owned frontier placement; interiors never touch the map — their only asset is the backdrop image, **fired immediately at creation** for fluid in-scene switching.
4. `docs/engine.md` (scene-tools/scene-lifecycle/sublocations) + `docs/painter.md` — the seams you are extending: the B6 tool pipeline the create tool joins, the registry the stub lands in, and the painter that will render backdrops (a NEW image_id class, not the world map).
5. UI Spec §1.6/§1.7 — backdrop slide transitions and the soft-close button set ("Jump to the next scene") — THIS milestone wires them for real; binding.
6. `docs/Coding Guide/AI Coding Guide.md` — A11 fences, B6 double gate, C2/C7, D8 (deps: ask first).

## Scope (recommended split — adjust with me at session start)

**The in-scene creation loop (owner-described, 2026-07-08):** the Narrator invents a place mid-scene → a `create_sublocation` narrator tool (B6 double-gated: schema gate, then engine gate incl. the parentless rule) commits an identity stub → in parallel, a ledger job generates the stub's backdrop image (painter, new `backdrop:<sublocation_id>` image class — interiors have their own coordinate space, the map is untouched) → `change_sublocation` to the new stub plays the slide transition the moment the backdrop lands (placeholder until then) → a parentless stub ALSO gets its map presence via the existing materialize/Flow-A contract (code-owned frontier placement, region lock included). At scene end, the soft-close "Jump to the next scene" button actually opens the follow-up scene at the created place.

**Owner decisions to settle at session start (from the week-8 review):**
- World-agent awareness: should places that were MENTIONED in a scene but never entered (and/or Flow-B transient discoveries) reach the world agent's context? Today nothing reads them. Decide and, if yes, extend the context assembler deliberately.
- Whether Flow-B transient text staying in the `map_click.resolved` audit event is acceptable "never enters the DB" semantics (week-8 note), or should move to an ephemeral stream frame.

Chats (Rev 4 §8) / Feed / Wiki remain M6 part 2+.

## Notes carried over from Week 8 (read these — they will save you real money)

- **Measured costs:** reveal tile ≈ $0.07 (`google/gemini-3.1-flash-image`); Flow-A edit ≈ $0.24 (GM form + `google/gemini-3-pro-image` — flash-class NEVER paints a drawn feature legibly, do not retry it); VLM classify < $0.01; DeepSeek text call < $0.01. Backdrops are a new image class — measure the first one before any batch, and expect the style prompt to need the week-7/8 iterate-by-looking loop (budget ~3 iterations).
- Estimate before any batch >10 calls; report the running total each summary; track EXACT spend via `GET https://openrouter.ai/api/v1/credits` deltas. ⚠️ The key is SHARED — it accrued ~$0.14 of unrelated usage mid-session in week 8 — so bracket every real run with a credits reading, immediately before and after.
- **Rotate the OpenRouter key now** (owner task, due since M5 closed): it was shared in a chat transcript and shows external usage. If real calls suddenly 401, ask me.
- The edit-mode recipe that works (do not re-derive it): mode `modify` + half-size context margin + the red polygon outline drawn on the copy sent to the model + the 3 px mask shrink (a model CAN paint the marker back — the shrink is what makes that harmless). All in `painter.ts`/`llm/image-source.ts`, tested.
- Week-8 nit to watch: ONE live SSE frame missed an open browser tab (the park event); reload/replay healed it exactly as designed. If it recurs, instrument `attachSseClient` write errors before suspecting the plugin.
- The `%TEMP%\weltari-real` demo world has edit 6's red-line remnant baked into its history — delete the folder for a fresh demo, or lasso over it (that IS the designed repair).
- The kill harness must stay ZERO-cost: whatever the creation loop adds, fakes drive it (`WELTARI_FAKE_LLM=1` + stub source + fake VLM). New fault points follow the `FaultPoint` union pattern; new natural-key outcome events get the fused idempotency re-check + interleaved-execution test (the week-7/8 pattern, `docs/ledger.md`) AND a `verify-consistency` uniqueness sweep entry.
- Windows dev box: preview viewport can collapse to 0×0 (`preview_resize` with explicit width/height fixes it); browser clicks via `preview_eval` dispatch, not `preview_click`; the screenshot tool times out on animating pages — verify with DOM samples + fetching `/v1/images/*` directly.
- `weltari-real` launch config = real-backend browser demo (`%TEMP%\weltari-real`; delete for fresh). `weltari-masking` = free fake/stub demo (`%TEMP%\weltari-mask`).
- Git pushes to main: I will approve them (run the push and let me approve, or hand me the command). Check first whether the week-8 commits (f454764…64f1714) are already pushed.

## Success criteria to demonstrate (proposal — confirm at session start)

(a) In the browser on the real backend: mid-scene, the Narrator invents a place → `create_sublocation` commits the stub through both B6 gates (an invalid call writes ZERO rows and shows in the dev trail) → the backdrop job runs in parallel while the scene continues → `change_sublocation` to the stub plays the slide transition with the REAL generated backdrop; (b) a parentless stub lands on the map via the existing placement contract — pin + painted square, region locked while in flight; (c) scene end with a continuation offers "Jump to the next scene" and it opens AT the created place; (d) your own visual inspection of ≥3 generated backdrops recorded in `docs/week9-results.md` (rejections included — expect prompt iterations); (e) stub/fake defaults: `npm run gate` + `CYCLES=25` harness green at $0.00, including any new fault points; (f) gate green, idle RSS < 170 MB, spend within budget.

## Budget (owner)

Total real-provider budget for the week: **$[OWNER: fill in — week 8 used $0.93 of $5; ~$4.07 remains on the top-up, and backdrops are an unmeasured new image class]**. Fake/stub remains the default everywhere — real backends run only when I've set the env.

## Process rules (unchanged)

- Small conventional commits (one logical change each); `npm run gate` must exit 0 before anything is called done; tests + docs page in the same commit.
- Never modify the spec/session documents in `docs/` (Brief, UI Spec, Stack Session/, Coding Guide/, Rev 3/Rev 4, ui-wireframes/).
- Modifying existing `tests/invariants/` files needs my `invariant-change` label — add new invariant tests freely.
- Zero new deps expected without asking; versions exact-pinned; secrets only via env.
- After each milestone-sized step, summarize plainly what exists and what's next.
