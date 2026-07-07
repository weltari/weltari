# Week 5 Kickoff — Milestone 4 part 1: the wireframe UI shell on existing surfaces (paste this to start the session)

Build the first half of Milestone 4 for Weltari in this repository (`D:\devproj\weltari`, remote `https://github.com/weltari/weltari`). Milestones 1–3 are complete and pushed: the crash-safe engine, ledger, painter, gateway echo, the VN Scene page with the two-gate tool surface, the hash-verified plugin loader with `<wl-map>`, packaging (Docker + Windows zip), the minisign-verified self-update path, and the §1.14 masking animations — all criteria PASS (`docs/week1-results.md` … `docs/week4-results.md`). I am not a professional developer — explain plainly, recommend, and let me decide only where a genuine value judgment remains.

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index (commands, layout, never-violate rules).
2. `docs/ui-wireframes/pages/README.md` — the binding design reference for this milestone: 15 hand-drawn pages described in words (global design language §0, the Left Nav Rail §0.1, resolved questions at the bottom). Sketches are intent, not pixel spec.
3. `docs/Coding Guide/AI Coding Guide.md` + `Task Completion Checklist.md` — A13/A14 (frontend fences) and B-http bind everything this week.
4. `docs/web.md` + `apps/web/structure.md` (the binding module contract — rule 6 §1.14 masking applies to every new transition) + `docs/INDEX.md` → pages for whatever you touch.
5. `docs/UI Spec (skeleton).md` — §1.4 pacing, §1.7 soft close, §1.13 theming, §1.14 masking stay binding on every new page.
6. `docs/builder.md` — docs rules (module page changes in the same commit).

## Scope decision (already made)

This milestone builds the wireframe pages that today's backend can already serve, plus ONE small engine addition (the roster projection). Chats, Feed, and Wiki pages need whole backend systems (Rev 4 §8/§10) — they are Milestone 5+; do NOT stub fake versions of them. The rail shows only working destinations (a disabled entry with a "later" tooltip is fine).

## What to build, in recommended order

**1. The app shell + Left Nav Rail** (wireframes §0.1): client-side routing (History API is fine — no new deps without asking), the fixed icon rail (logo → Scene ▶ · Map 🌐 · Config ⚙ stacked; blinking clock + profile bottom-anchored; Chats/Feed/Wiki entries present but disabled "M5"). The current Scene page becomes the Scene route unchanged. Everything themable by `--wl-*` tokens only; dedicated mobile behavior (rail collapses per your judgment — recommend bottom bar on mobile, note the deviation).

**2. Scene display modes** (wireframes pages 05/06/07): the top-right control cluster — VN ↔ Reader switch (book icon), transcript/log panel toggle, auto-advance, exit. Reader mode = the prose-first pane over the same store (the transcript component is most of it); VN-with-log = current stage + docked transcript. One store, three views — zero new game state.

**3. The Map page** (wireframe 08): promote `<wl-map>` from modal to a full route (the modal stays for in-scene use). Zoom +/− controls and the search field can be visual placeholders wired to nothing (fog/explore/lasso are the map-part-2 milestone) — but pin-jump (§1.14 masked) must keep working from the page.

**4. The Gameday clock flow** (wireframes 11–13): clicking the rail clock opens the advance-time screen — "— GAMEDAY N —", the circular dial with the sun/moon bead, digital time from `world.time_advanced` (fictional time is READ, never invented — UI Spec §11). Advancing calls `POST /v1/commands/advance-time` and the dial animation masks the replay (§1.14; reuse/extend `SceneCover` vocabulary). Skip size control: recommend presets (+1h/+6h/to-morning) capped at +48h per the spec.

**5. Config page** (wireframe 15 + UI Spec §2.8): loaded plugins with provenance hashes (the dev-overlay data, presented calmly), the update surface (`update.available` badge → Apply button → `apply-update`, showing 409 `updates_disabled` states honestly with what to do about them), connection/version info. This makes the update path visible without dev mode.

**6. The roster projection (the one engine addition):** a `character.joined`-style durable event (protocol addition, additive minor bump; emitted at scene open from participants) so the Scene page cast stops being the hardcoded `CAST` constant in `SceneStage.tsx` — the recorded Week-3 deviation. Tests + schema emit + docs in the same commit, I8/B6 untouched.

**7. Hygiene sweep (small commits):** root `fixtures/` seeded example world + `docs/data-model.md` (both builder.md obligations deferred since Week 1); `.env.example` un-ignore if my pending task chip didn't already land it.

## Success criteria to demonstrate

(a) every built route reachable from the rail on desktop AND mobile-emulated browser, browser-verified, zero console errors; (b) VN ↔ Reader ↔ log-panel switches preserve scene state mid-turn (switch during a streaming turn, nothing lost); (c) the Gameday flow advances fictional time end-to-end with the animation masking the replay window (drive with `WELTARI_FAKE_LLM_DELAY_MS`); (d) Config shows a real `update.available` → Apply → `update.staged` round-trip against a local fixture release (reuse the harness fixture pattern from `tools/kill-harness.mjs`); (e) the cast renders from the roster event (grep: `CAST` constant gone); (f) `npm run gate` green, idle RSS still < 170 MB (`node tools/m3-plugin-proof.mjs`), no hardcoded colors/durations outside `theme.css` (grep for `#[0-9a-f]` in new tsx as a spot check).

## Notes carried over from Week 4

- **Owner actions pending (not agent work):** minisign keypair (`minisign -G`) before real self-updates; first `v*` tag to exercise the ghcr release workflow.
- Fake-LLM triggers for manual testing: `!move <subloc>` · `!art char:elias <pose>` · `!end [rest|continuation|travel]` · `!badshape` · `!ghosttool`. `WELTARI_FAKE_LLM_DELAY_MS` simulates the 5–10 s generation window; `.claude/launch.json` has the `weltari-masking` preview config.
- Plugin content edits require re-running `computePluginContentHash` and updating `plugin.json` (the loader refuses otherwise); the web client cache-busts plugin assets by hash.
- Windows dev box: intermittent ephemeral-port exhaustion — `EADDRINUSE` streaks are the box, not the code (mitigations + `netsh` widening command in `docs/week3-results.md`).
- The screenshot tool times out on infinitely-animating pages; verify §1.14 behavior with timed DOM samples (the Week-4 pattern) instead.
- New deps need `docs/dependencies.md` entries with exact pins (D8) — this milestone should need zero; ask before adding a router library.
- Git pushes to main: I run in accept-edits mode and will approve your pushes.

## Process rules (unchanged)

- Small conventional commits (one logical change each), pushed as you go; `npm run gate` must exit 0 before anything is called done; tests + docs page in the same commit.
- Never modify the spec/session documents in `docs/` (Brief, UI Spec, Stack Session/, Coding Guide/, Rev 3/Rev 4, ui-wireframes/).
- Modifying existing `tests/invariants/` files needs my `invariant-change` label — add new invariant tests freely.
- After each milestone-sized step, summarize plainly what exists and what's next.
