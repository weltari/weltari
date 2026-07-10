# Week 4 Kickoff — Milestone 3 part 2: packaging + self-update + animation masking (paste this to start the session)

Build the second half of Milestone 3 for Weltari in this repository (`D:\devproj\weltari`, remote `https://github.com/weltari/weltari`). Milestones 1–2 and M3 part 1 are complete and pushed: the crash-safe engine, the real VN Scene page with the B6 tool surface (`end_scene` / `change_sublocation` / `switch_art`), interrupt-anywhere, the hash-verified plugin loader, and the lint-clean `<wl-map>` plugin — all four part-1 criteria PASS (`docs/week3-results.md`). I am not a professional developer — explain plainly, recommend, and let me decide only where a genuine value judgment remains.

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index (commands, layout incl. the M3 `plugins/` addition, never-violate rules).
2. `docs/Coding Guide/AI Coding Guide.md` + `Task Completion Checklist.md` + `Weltari Invariants & Test Templates.md` — B12 (update metadata is untrusted) binds everything this week.
3. `docs/INDEX.md` → module pages for whatever you touch — start with `week3-results.md`, `plugins.md`, `web.md`, `http.md`, `repo.md`.
4. `docs/Stack Session/FINAL - Stack Decision.md` §6 (Milestone 3 criteria) and items 1/12 (runtime pinning, packaging + self-update design).
5. `docs/UI Spec (skeleton).md` §1.14 (animations cover generation) — binding for the masking criterion.
6. `docs/builder.md` — docs rules (module page changes in the same commit).

## What to build, in recommended order

**1. Fastify serves the built frontend** (FINAL item 2 — the missing packaging prerequisite): `vite build` output served as static files from the same process (new route in `http/`, containment-guarded like the plugin/image routes; SPA fallback to index.html). Acceptance: `npm run build && node apps/server/dist/main.js` serves the full Scene page on `:7777` with zero Vite process.

**2. The update path (B-update, Guide B12)** — the updater job checks GitHub Releases (croner-scheduled + startup check), `safeParse`s the release JSON, emits a durable `update.available` event (protocol addition); apply = download to `versions/vNext`, verify SHA-256 **and** minisign signature, then flip a `current` pointer on restart. The pointer-flip code path takes a `VerifiedArtifact` value only the verifier constructs (compiler-confined). A kill -9 mid-update must leave the running version intact (idempotent startup swap) — extend the kill harness with a `mid_update` fault point.

**3. Packaging** — the Docker multi-arch image (ghcr) and one Windows zip bundling the pinned Node runtime, the app bundle, and prebuilt natives (better-sqlite3, sharp) + a launcher script honoring the `current` pointer and the exit-code contract (exit 3 = corrupt_state: do not blindly restart). Docker = notify-and-let-host-pull (no in-container apply).

**4. Animation masking (UI Spec §1.14)** — scene-open and map-jump animations that fully cover a 5–10 s generation window: use `WELTARI_FAULT_PAUSE_MS` (or a new latency-injection env var) to simulate slow generation and verify on desktop + a mobile-emulated browser that the user never stares at a frozen screen (clock-spin / slide / fade vocabulary; all durations as `--wl-*` tokens).

**5. Real-provider spot check with the tool surface** (carried over from Week 3): one short run against OpenRouter (`anthropic/claude-sonnet-4.5`, pinned provider) where the Narrator actually calls `change_sublocation` / `switch_art` / `end_scene` through the SDK toolset — the tools have only ever run against the FakeLLM. Budget: ~$1.9 remains on the key; a few turns cost cents. `openrouter_api.txt` stays gitignored, env-only; fake LLM for all development.

## Success criteria to demonstrate (FINAL §6 M3, part-2 subset)

(a) download-verify-swap-on-restart survives `kill -9` mid-update (idempotent startup swap, harness-proven); (b) the Docker image and the Windows archive both boot the full app (frontend included) on a clean machine/dir; (c) scene-open and map-jump animations fully mask a simulated 5–10 s generation window on desktop and mobile-emulated browser; (d) idle RSS still **< 170 MB** with the plugins installed (re-run `tools/m3-plugin-proof.mjs` on the packaged build).

## Notes carried over from Week 3

- **Recorded deviations/deferrals:** root `fixtures/` still deferred; the Scene-page cast is a hardcoded fixture constant until a roster projection event exists; map fog/explore interactions and real art are later milestones (token slots + `backdrop_path` are ready).
- **UI is my approved prototype** (owner Figma never landed) — reskin path documented in `docs/web.md` §Customizing the UI + `apps/web/structure.md`. Keep everything themable by tokens.
- **Windows dev box:** intermittent ephemeral-port exhaustion (an external process; mitigations shipped — see `docs/week3-results.md` notes). If harness/tests streak `EADDRINUSE`, that's the box, not the code; the `netsh` widening command is in the notes.
- Fake-LLM tool triggers for manual testing: `!move <subloc>` · `!art char:elias <pose>` · `!end [rest|continuation|travel]` · `!badshape` · `!ghosttool`.
- New deps this week (minisign verification, anything for packaging) need `docs/dependencies.md` entries with exact pins (D8). Prompt-prefix byte-stability (I5) and the two-gate rule (B6) bind every new prompt builder and tool path.
- Git pushes to main: I run in accept-edits mode and will approve your pushes.

## Process rules (unchanged)

- Small conventional commits (one logical change each), pushed as you go; `npm run gate` must exit 0 before anything is called done; tests + docs page in the same commit; new deps need `docs/dependencies.md` entries with exact pins.
- Never modify the spec/session documents in `docs/` (Brief, UI Spec, Stack Session/, Coding Guide/, Rev 3/Rev 4).
- Modifying existing `tests/invariants/` files needs my `invariant-change` label — add new invariant tests freely.
- After each milestone-sized step, summarize plainly what exists and what's next.
