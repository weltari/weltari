# Week-5 results — Milestone 4 part 1: the wireframe UI shell (2026-07-08)

All six success criteria PASS. Everything below was demonstrated against the
real stack (FakeLLM, `WELTARI_FAKE_LLM_DELAY_MS=7000` where the criterion
exercises a generation window).

| # | Criterion | Result |
| --- | --- | --- |
| a | Every built route reachable from the rail, desktop AND mobile-emulated, zero console errors | **PASS** — `/` (Scene), `/map`, `/gameday`, `/config` each reached via rail clicks on desktop and on a 375×812 viewport (rail renders as the bottom bar — recorded deviation, docs/web.md); browser back/forward honored; an installed `console.error` + `window.onerror` + `unhandledrejection` hook stayed empty across the full sweep. |
| b | VN ↔ Reader ↔ log-panel switches preserve scene state mid-turn | **PASS** — switched to Reader while a turn was streaming: the live paced sentence carried over; advanced one sentence in Reader; switched back to VN showing the advanced cursor (2 sentences). Mode/log state is pure view state; pacing lives in the shell, the store is untouched. |
| c | Gameday flow advances fictional time end-to-end, animation masks the replay | **PASS** — "To morning" skip (12:00 → 06:00 +1 day): `world.time_advanced` read from the stream (GAMEDAY 2, 06:00), timed DOM samples show the dial in `advancing` state with "the world catches up… (1 of 2 occurrences)" for the full 7 s LLM-class occurrence, settling exactly when `world_cron.completed` caught up. §1.11 grey-out verified (presets disabled while a scene was active; exit-scene → enabled). |
| d | Config shows a real update.available → Apply → update.staged round-trip against a local fixture release | **PASS** — `tools/update-fixture.mjs` (harness artifact-trio pattern, fresh minisign keypair) + a server started with its printed env: boot check announced 0.9.0, Apply → "verified and staged … (was 0.1.0)" with the artifact sha256. Notify-only mode retest: Apply → 409 `updates_disabled` rendered with plain-language help. |
| e | Cast renders from the roster event | **PASS** — protocol 0.7.0 `character.joined` emitted at scene open (atomic with scene.started) + fixture seed; line-up shows "Elias the Clockmender · neutral" from the stream; `grep CAST apps/web/src` = no matches. |
| f | Gate green, idle RSS < 170 MB, no hardcoded colors/durations | **PASS** — `npm run gate` exit 0 (206 tests / 43 files); `tools/m3-plugin-proof.mjs`: idle RSS **109.9 MB**; `#[0-9a-f]` grep over apps/web src (theme.css excluded) = no hits; all new motion values are `--wl-*` tokens (`--wl-gameday-*`, `--wl-clock-blink-duration`, rail tokens). |

## What exists now

- **App shell:** Left Nav Rail (wireframes §0.1) + History-API routing
  (`router.ts`, no new deps). Chats/Feed/Wiki are present but disabled with
  "Milestone 5" tooltips. Mobile: bottom bar (deviation recorded).
- **Scene display modes:** top-right control cluster — VN ↔ Reader, log
  panel, auto-advance, exit (two-tap confirm → end-scene). One store, three
  views.
- **Map page:** `<wl-map>` as a full route; zoom/search placeholder chrome;
  pin-jump still §1.14-masked (the modal stays for in-scene use).
- **Gameday clock:** rail clock → dial screen; time READ from
  `world.time_advanced`; +1h/+6h/to-morning presets (≤ +48h, forward-only,
  greyed in-scene); dial masks the cron replay window.
- **Config page:** connection/protocol/app-version, the update surface
  (honest 409s + job-failure surfacing), plugin provenance + refusals.
- **Engine addition (the one):** `character.joined` roster projection
  (protocol 0.7.0, additive).
- **Hygiene:** `fixtures/` example world + loader, `docs/data-model.md`,
  `.env.example` tracked (chip branch `claude/great-curran-254907` is now
  superseded — safe to delete).

## Notes / carry-overs

- Owner actions still pending: minisign keypair (`minisign -G`), first `v*`
  tag for the ghcr release workflow.
- Old dev databases predate protocol 0.7.0 and show an empty line-up until a
  new scene opens (delete the dev DB to re-seed).
- `.prettierignore` now excludes `.claude/` — another session's open harness
  worktree was failing `format:check`.
- M4 part 2 candidates (next): map fog/explore/lasso wiring, Scene splash
  (wireframe 03) + History modal (04), World home (01) once world listing
  exists.
