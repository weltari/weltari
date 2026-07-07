# Week 3 Kickoff — Milestone 3 begins: plugin proof + the real Scene page (paste this to start the session)

Build the first slice of Milestone 3 for Weltari in this repository (`D:\devproj\weltari`, remote `https://github.com/weltari/weltari`). Milestones 1 and 2 are complete and pushed — the full M2 kill table passed 100 cycles with zero lost/duplicated events and zero corrupted images (see `docs/week2-results.md`). I am not a professional developer — explain plainly, recommend, and let me decide only where a genuine value judgment remains.

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index (commands, layout incl. the M2 `painter/` addition, never-violate rules).
2. `docs/Coding Guide/AI Coding Guide.md` + `Task Completion Checklist.md` + `Weltari Invariants & Test Templates.md` (I1–I14).
3. `docs/INDEX.md` → the module pages for whatever you touch — now including `painter.md`, `gateway.md`, `plugin-sdk.md`, `week2-results.md`.
4. `docs/UI Spec (skeleton).md` — the binding UI requirements; §2 per-surface inventory drives the Scene page.
5. `docs/Stack Session/FINAL - Stack Decision.md` §6 (Milestone 3 scope + success criteria) and items 5/6/13 (frontend, map, plugin format).
6. `docs/builder.md` — docs rules (module page changes in the same commit).

## What to build, in recommended order (M3 part 1 — packaging/update can wait for part 2)

**1. The real VN Scene page** (`apps/web`) — replaces the bare Week-1 stream dump: sentence-by-sentence pacing with click / Auto-Advance, interrupt-anywhere (closes the turn envelope at the interruption point — needs an `interrupt-turn` command in `@weltari/protocol`), streaming narration from the SSE `stream` frames, the committed transcript from durable events. zustand lands now (the recorded M3 deferral): stores writable ONLY by the SSE reducer — the frontend stays render-only (Brief §2.5). Dedicated mobile layout per the Phase-2 decision.

**2. Plugin loader (backend + frontend halves)** — a plugin is a folder in `plugins/` (FINAL item 13): `plugin.json` manifest (name, semver, engine range, capabilities, provenance `{source_url, sha256}`), hash verified at install AND at every load (B10 — tampered byte ⇒ refused + `plugin.rejected` event, app boots without it); `frontend/*.mjs` custom elements served zero-build; `theme.css` custom-property overrides. The B-plugin boundary home is `apps/server/src/boundary/plugins/`.

**3. The default `<wl-map>` plugin** — Canvas 2D tiles + DOM overlay pins, written ONLY against documented map connector events (it dogfoods the plugin contract; lint must prove no private imports). Map events go into `@weltari/protocol`; the painter's `painter.completed` images are the tile source we already have.

**4. Drop-in proof** — with the server running: drop a folder into `plugins/` containing one CSS theme, one custom-element surface replacement, and one connector; restart; verify all three load and the provenance hash shows in dev mode (UI Spec §2.8 — the dev channel already exists: `?dev=1`).

## Success criteria to demonstrate this week (from FINAL §6 M3, part-1 subset)

(a) the drop-in plugin loads with **zero build step** and its provenance hash appears in dev mode; (b) the map renderer has **no private imports** (lint-verified); (c) scene-open and interrupt behavior: streamed sentences pace on click/auto, an interrupt closes the envelope and nothing after the interruption point is durable (B6); (d) idle RSS still **< 170 MB** with the plugins installed.

## Notes carried over from Week 2 (Milestone 2)

- **All M2 criteria passed** — `docs/week2-results.md`. The kill harness now covers 7 fault points (25/PR, 100/nightly) and `tools/m2-rss-check.mjs` runs nightly.
- **Live spot checks done with real provider + real Telegram** (2026-07-07): real-LLM reflection fan-out committed in-character text; the Telegram echo ran against `@xihsontestbot`. The token was shared in-chat for testing — **I should revoke/regenerate it via @BotFather**; the connector reads `TELEGRAM_BOT_TOKEN` env-only.
- **OpenRouter budget:** roughly $1.9 of the $5 key remains (spot checks cost cents). `openrouter_api.txt` stays gitignored, env-only. Fake LLM (`WELTARI_FAKE_LLM=1`) for all development; real calls only for final spot checks.
- **Recorded deviations/deferrals:** `apps/server/src/painter/` is a sanctioned layout addition (docs/painter.md); root `fixtures/` still deferred; zustand lands THIS week with the Scene page (dep ledger entry + exact pin required, D8).
- Prompt-prefix byte-stability (I5) and the two-gate rule (B6) bind every new prompt builder and every new tool call path you add.
- Git pushes to main: I run in accept-edits mode and will approve your pushes.

## Process rules (unchanged)

- Small conventional commits (one logical change each), pushed as you go; `npm run gate` must exit 0 before anything is called done; tests + docs page in the same commit; new deps need `docs/dependencies.md` entries with exact pins.
- Never modify the spec/session documents in `docs/` (Brief, UI Spec, Stack Session/, Coding Guide/, Rev 3/Rev 4).
- Modifying existing `tests/invariants/` files needs my `invariant-change` label — add new invariant tests freely.
- After each milestone-sized step, summarize plainly what exists and what's next.
