# Week-6 results — Milestone 4 part 2: scene lifecycle UX + the living map

All six success criteria PASS. Protocol bumped to **0.8.0** (additive):
`sublocation.materialized`, the `explore` command, open-scene
`sublocation_id`, hello `app_version`. The wl-map plugin is at **0.3.0**
(fog + Explore + spinner + materialized pins, hash re-verified).

**Structural change to note:** a fresh world no longer auto-opens scene
`s1`. The seed materializes the fixture trio instead (three explored map
squares from event one) and the splash is the entry surface — criterion (a)
requires it. The kill harness, RSS/cache tools and the gateway echo now
open their scenes through `open-scene` like any client.

## Criteria

### (a) Fresh DB → splash; Hang around masked; desktop + mobile — PASS

Fresh `%TEMP%\weltari-mask` DB, `WELTARI_FAKE_LLM_DELAY_MS=7000`. The Scene
route rendered "Adventure Awaits" with all three actions and the footer
"The Rainy Inn · Weltari v0.1.0" (app version from the 0.8.0 hello frame).
**Hang around** picked a random known sublocation (runs landed on The
Flooded Cellar and The Old Shrine), opened the scene AT it (backdrop
`data-sublocation` moved; `sublocation.changed` appended atomically with
`scene.started`), and the §1.14 cover animated the whole window — timed DOM
samples on the mobile-emulated run (375×812, rail as bottom bar, no
horizontal overflow): cover present t=1.3 s → 8.3 s, dismissed on the first
streamed sentence. Zero console errors or warnings on both viewports.

### (b) History from replay after restart; Continue masked — PASS

Played two scenes (Hang around → `!end continuation` → Stay longer →
`!end rest`), killed and restarted the server, reloaded. The splash
rendered (the replayed `scene.ended` is recognized as replay — see the
`sceneEndedLive`/`replayTarget` store fix, found by driving this exact
criterion) and the History modal listed both scenes with participants and
expandable read-only transcripts, rebuilt from replay alone. **Continue**
opened a NEW scene with the same title/participants under the cover
(samples: covered t=1.2 s → 8.2 s, then the opening narration streamed).

### (c) Explore end-to-end under the generation window — PASS

Map page, click fog square (5,1) → "Unexplored Area" + **Explore** →
POST `/v1/commands/explore` 202 → spinning loader over a grey overlay on
the target square for the full window (samples: spinner at t=0.6 s through
t≈7 s) → `sublocation.materialized` revealed the square with "The Mill
Pond" pin at the square center → pin click → masked jump into a scene at
`subloc:sq-5-1` with the default backdrop token fallback.

### (d) kill -9 at mid_materialize converges — PASS

`CYCLES=10 node tools/kill-harness.mjs` green over all **9** fault points:
"mid_materialize convergence ok: square {col:0,row:0} materialized exactly
once after restart" — the leased job retried after the kill, the
deterministic per-square id + occupancy check prevented twins, the reveal
was not lost, resume exact, verifier clean every cycle.

### (e) wl-map loads hash-verified after its edit — PASS

`computePluginContentHash` recomputed after every edit (including the
prettier pass); `plugin.json` bumped to 0.3.0; `GET /v1/plugins` served the
new provenance (`07926217ce60…`) and the element rendered. The plugin still
has ZERO imports (`eslint.config.mjs` bans every import specifier under
`plugins/wl-map/` — lint at 0 warnings proves it) and consumes only
documented surfaces: `/v1/events`, `/v1/images/*`,
`POST /v1/commands/explore`, and the `wl-map-jump` CustomEvent — a
third-party `<wl-map>` could do exactly the same. `plugin-hash` invariants
green (tamper ⇒ refusal).

### (f) Gate green; idle RSS; tokens only — PASS

- `npm run gate` exit 0 (format:check → lint 0 warnings → `tsc -b` +
  web → 240 tests incl. the new `materialize-gates` invariants → knip).
  One environmental flake noted: `self-watch.test.ts` can hit the
  documented Windows `EADDRINUSE` streak when run right after a harness
  run (port ranges overlap); it passes in isolation and in the clean run.
- `node tools/m3-plugin-proof.mjs`: **idle RSS 117.4 MB** (limit 170),
  drop-in + tamper-refusal both green.
- No hardcoded colors/durations outside `theme.css` (grep over
  `apps/web/src`); new tokens: `--wl-splash-*`, `--wl-modal-veil`,
  `--wl-map-fog-*`, `--wl-map-pending-fill`, `--wl-map-spinner-duration`,
  `--wl-map-reveal-duration`.
- CI structural scripts run locally: catch-audit, c6-handlers, dep-ledger,
  licenses, tests-accompany — all green. Zero new dependencies.

## Commits

`b4e823a` protocol 0.8.0 · `8ed0407` engine materialization (B6 double
gate, mid_materialize) · `1767e24` splash + History · `cb8fdd8` wl-map
0.3.0 · `5589b0a` harness + fixtures · `b46bc63` replayed-end splash fix.

## Carried forward

- Lasso/pencil map editing and Flow-B click classification need a VLM —
  deliberately NOT stubbed (zoom/search placeholders remain placeholders).
- The example-world fixture still fails `verify-consistency`'s job-row
  check (pre-existing: it is a row-inspection aid loaded without ledger
  rows, not a consistency subject).
- Old dev DBs (pre-0.8.0) have no materialized events: their map starts
  fully fogged and Hang around is disabled until squares are explored —
  fresh DBs preferred for demos, as before.
