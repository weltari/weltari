# Week 6 Kickoff — Milestone 4 part 2: the scene lifecycle UX + the living map (paste this to start the session)

Build the second half of Milestone 4 for Weltari in this repository (`D:\devproj\weltari`, remote `https://github.com/weltari/weltari`). Milestones 1–3 and M4 part 1 are complete and pushed: crash-safe engine, ledger, painter, gateway echo, the VN Scene page with two-gate tools, plugin loader with `<wl-map>`, packaging + minisign-verified self-update, §1.14 masking, and the wireframe UI shell — Left Nav Rail + routes (Scene / Map / Gameday / Config), three scene display modes, the `character.joined` roster projection (protocol 0.7.0). All criteria PASS (`docs/week1-results.md` … `docs/week5-results.md`). The first release tag `v0.1.0` exists and the owner has a minisign keypair. I am not a professional developer — explain plainly, recommend, and let me decide only where a genuine value judgment remains.

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index.
2. `docs/ui-wireframes/pages/README.md` — pages 03 (scene splash), 04 (History modal), 08 (map) are this week's surfaces; §0 global language stays binding.
3. `docs/Coding Guide/AI Coding Guide.md` + `Task Completion Checklist.md` — A13/A14, B-http, and the B6 double gate bind everything; the map work adds LLM-generated content, so B6 is the heart of this week.
4. `docs/web.md` + `apps/web/structure.md` (rule 6 §1.14 masking applies to every new transition) + `docs/plugins.md` (the map renderer is a plugin — new map state must arrive over the documented event surface, never private access).
5. `docs/UI Spec (skeleton).md` — §1.8 (map UI contract: fog, Explore, spinner square, one reveal path, pins on world coordinates) and §1.14 are the binding sections this week.
6. `docs/builder.md` + `docs/data-model.md` — docs and schema rules; new tables/events need data-model.md entries in the same commit.

## Scope decision (already made)

This half finishes the Scene page's lifecycle chrome and makes the map alive: fog, Explore, and sublocation materialization — the engine addition of the week. Lasso/pencil map editing and Flow-B click classification need a VLM: they are a LATER milestone; do NOT stub them (the zoom/search placeholders from part 1 may stay placeholders). Chats/Feed/Wiki remain M5+.

## What to build, in recommended order

**1. Scene splash / landing (wireframe 03):** when no scene is active (fresh world after the fixture seed is consumed, or after exit/soft-close ends the last scene), the Scene route shows "Adventure Awaits" with three actions: **History scene** (opens the History surface), **Open Map** (navigates to /map), **Hang around** (picks a random known sublocation and opens a scene there through the §1.14 cover). Footer: world name + app version. Decorative shapes are optional — tokens only if you add them.

**2. History surface (wireframe 04):** a modal over the Scene route listing played scenes — a pure store projection of replayed `scene.started`/`scene.ended` (+ first divider/participants). Each row: title, when (fictional time if known), participants, a read-only transcript view, and a **Continue** affordance that opens a NEW scene with the same title/participants through the cover (scene.ended is final — no resurrecting closed envelopes).

**3. Map fog + Explore + materialization (the engine addition):** per Rev 4 §14 / UI Spec §1.8.
   - Durable fog state: an additive protocol event (e.g. `sublocation.materialized`) carrying id/name/map_position — the map's fog grid is a projection; explored = materialized.
   - `POST /v1/commands/explore` (world_id, actor_id, target square/position): enqueues ONE LLM-class ledger job that generates the new sublocation stub (name + short description) behind the full B6 double gate (schema gate, then engine-state gate: square empty, world exists), then appends the event. Idempotent per square; kill-safe like every job (extend the kill harness with a `mid_materialize` fault point — Explore reveals and materialization reveals share one render path, so one proof covers both).
   - `<wl-map>` plugin update: render the fog grid (very faint borders), hover overlay, "Unexplored Area" + Explore on click, spinning loader over the target square while the job runs, reveal on the event. The plugin consumes ONLY the public stream + commands (recompute `computePluginContentHash` and update `plugin.json` or the loader refuses).
   - New sublocations must be enterable: pin click → the existing masked jump; the engine-state gate for `change_sublocation` accepts materialized ids, not just the fixture trio (backdrop token falls back to default for unknown ids).

**4. Protocol/store additions:** additive minor bump (0.8.0), schema emit + tests + docs in the same commits, store projections only via the SSE reducer.

**5. Hygiene:** `fixtures/example-world/events.jsonl` gains the new event type(s) (the loader will fail loudly otherwise — that is the point); `docs/data-model.md` if any table changes.

## Success criteria to demonstrate

(a) fresh DB → splash renders; **Hang around** opens a random-sublocation scene under the cover, zero console errors (desktop + mobile-emulated); (b) after playing ≥2 scenes and restarting the server, the History modal lists them from replay alone, and Continue opens a follow-up scene masked; (c) Explore end-to-end with `WELTARI_FAKE_LLM_DELAY_MS`: click fog square → spinner square animates for the full generation window → reveal → the new pin jumps into a scene; (d) kill -9 at `mid_materialize` converges after restart (harness cycle green — no duplicate squares, no lost reveal); (e) the wl-map plugin still loads hash-verified after its edit, and a third-party `<wl-map>` could do the same from documented surfaces only (no new private imports — lint fences prove it); (f) `npm run gate` green, idle RSS < 170 MB (`node tools/m3-plugin-proof.mjs`), no hardcoded colors/durations outside `theme.css`.

## Notes carried over from Week 5

- CI is green again as of `ec26c82` (the catch-audit false positive is fixed) — keep it green; remember the CI runs structural scripts that `npm run gate` does not (`scripts/check-*.mjs` — run them locally when touching server code).
- Owner state: minisign keypair exists (private key stored offline by the owner; `WELTARI_UPDATE_PUBKEY` goes in the owner's `.env`), `v0.1.0` tagged. If the release workflow needs follow-up fixes, that is in scope as `fix(ci)` commits.
- Fake-LLM triggers: `!move <subloc>` · `!art char:elias <pose>` · `!end [rest|continuation|travel]` · `!badshape` · `!ghosttool`. `WELTARI_FAKE_LLM_DELAY_MS` simulates the 5–10 s window; `.claude/launch.json` has the `weltari-masking` config (fresh DB = delete `%TEMP%\weltari-mask`).
- The screenshot tool times out on infinitely-animating pages (the map!) — verify with timed DOM samples / `preview_snapshot`.
- Windows dev box: `EADDRINUSE` streaks are the box, not the code (`docs/week3-results.md`).
- Old dev DBs predate protocol 0.7.0 (empty line-up until a new scene opens) — prefer fresh temp DBs for demos.
- Zero new deps expected; anything new needs `docs/dependencies.md` + exact pin, ask first.
- Git pushes to main: I will approve them.

## Process rules (unchanged)

- Small conventional commits (one logical change each), pushed as you go; `npm run gate` must exit 0 before anything is called done; tests + docs page in the same commit.
- Never modify the spec/session documents in `docs/` (Brief, UI Spec, Stack Session/, Coding Guide/, Rev 3/Rev 4, ui-wireframes/).
- Modifying existing `tests/invariants/` files needs my `invariant-change` label — add new invariant tests freely.
- After each milestone-sized step, summarize plainly what exists and what's next.
