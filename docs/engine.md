# engine — apps/server/src/engine

Purpose: engine-owned truth and prompt assembly. No wall-clock reads here (lint-enforced, Guide A16); everything is a pure function of injected inputs so tests are deterministic and the stable prefix is byte-stable.

## Contract

- Inputs: character profiles, scene context (rendered world-clock text, transcript, external text).
- Outputs: `{ stablePrefix, dynamicTail }` — the I5 structural guard; events via `EventSink` (append-then-publish).
- Never: interpolate dynamic or external text into the stable prefix (Brief §2.6); treat external text as instructions (B14); read `Date.now()`/`new Date()`.

## File table

| File | What it does / talks to |
| --- | --- |
| `context-assembler.ts` | `assembleContext(profile, scene)` — stable-first order (skills → personality → memory core → goals), dynamic tail last; external text (wiki/transcript/player) tail-only inside `<external source=…>` wrappers with angle brackets neutralized so it cannot close its own wrapper. |
| `scene-lifecycle.ts` | `endScene`: scene.ended + one reflection job per participating character (derived from the scene's committed turns) + one World Agent job (`serial_group world_agent:<world>`), all in ONE WriteGate transaction (Brief §2.4); bus publish after commit. `openScene`: blocks (409) only on this world's World-Agent jobs + this scene's participants' reflections (Brief §4, criterion b); M4: appends one `character.joined` per KNOWN participant atomically with scene.started (the roster projection — unknown ids are skipped with a warn, B6 ethos), published after commit in append order. M4 part 2: optional `sublocation_id` opens the scene AT a known sublocation — registry-gated (`unknown_sublocation` 409), the `sublocation.changed` appends in the same transaction. M3: the atomicity core is extracted as `appendSceneEndWithFanOut` (runs inside a caller's transaction) so the Narrator's end_scene tool commits scene.ended + jobs in the SAME transaction as turn.committed. |
| `scene-tools.ts` | Gate 2 of the B6 double gate: validates shape-valid tool calls against game state (sublocation exists ∧ differs from current; character present ∧ pose in their art set; scene open ∧ not already ending). Valid effects are STAGED — the turn engine appends their durable events atomically with turn.committed; every rejection is a `dev.tool_rejected` trail frame with zero rows written (I8). M4 part 2: the sublocation list comes from the registry (fresh per turn), so materialized squares are enterable without a restart. |
| `sublocations.ts` | The sublocation registry (M4 part 2): known = fixture trio ∪ `sublocation.materialized` ∪ `sublocation.created` (M5 part 2 Flow A — those carry a `footprint` polygon) ∪ `map_click.resolved` with outcome `created` (M5 part 2 Flow B — the resolved event IS the persistent spawn's row) events per world — ONE projection read by the change_sublocation gate, open-scene's sublocation gate and explore's occupancy gate. Square math for the 8×8 fog grid (`squareOf`/`squareCenter`, protocol `MAP_FOG_GRID`); ids are deterministic per square (`subloc:sq-<col>-<row>`) so retries can never mint twins. Square occupancy counts only fixture/materialized rows: Flow-A/B sublocations are sub-square features and never block an Explore. Flow-B hit tests: `SUBLOCATION_RADIUS` (half a fog square) + `sublocationNear` (footprint containment wins, else nearest anchor within the radius) — the engine's authoritative copy of the rule the default map plugin mirrors. |
| `explore.ts` | The explore command seam (UI Spec §1.8): gates world-exists + square-empty (409 `world_not_found`/`square_occupied`), enqueues ONE `materialize` ledger job keyed by the square (I3: duplicate clicks are silent no-ops that still 202), kicks the runner so the spinner window tracks generation latency, not the 1 s poll. |
| `map-edit.ts` | The Flow-A command seam (Rev 4 §14, M5 part 2): gates world-exists + centroid-on-explored-ground (409 `world_not_found`/`unexplored_ground`), appends the durable `map_edit.requested` intent (the client's lock-overlay anchor; not re-appended for a duplicate request_id), enqueues ONE `map_edit` ledger job keyed by request_id (I3), kicks the runner. All geometry via painter-owned `editGeometry` ([painter.md](painter.md)). |
| `map-click.ts` | The Flow-B command seam (Rev 4 §14, M5 part 2). Step 1 — the radius check — answers HERE, synchronously: a click inside a known footprint or `SUBLOCATION_RADIUS` enters that sublocation with ZERO model calls and ZERO rows (202 `enter`); a fog click is refused (409 `unexplored_ground` — Explore owns fog); only a click outside all radii enqueues ONE `map_click` job keyed by request_id (202 `classify`, I3). |
| `fault-points.ts` | The `FaultPoint` union — the kill-harness contract (I4): Week-1 three + M2's `mid_reflection`/`mid_painter`/`mid_cron` + M3's `mid_update` + M4's `mid_materialize` + M5 part 2's `mid_map_edit`/`mid_map_click`. |
| `world-clock.ts` | The engine-owned fictional WorldClock: current time = projection of `world.time_advanced` events (epoch `2000-01-01T06:00Z`). `advanceTime` computes due world-cron occurrences (fictional-calendar math delegated to `ledger/scheduler.js` — A16), enqueues code-class first then the newest ≤budget LLM-class (default 10), all atomic with the time event; `kick` lets main drain the runner immediately (code-class = instant, Brief §4). |
| `fixture/rainy-inn.ts` | + `FIXTURE_WORLD_CRON`: `lamplighter` (code, fictional 06:00) and `evening_rumor` (LLM, fictional 18:00). |
| `fixture/rainy-inn.ts` | Deterministic Week-1 fixture world: Elias profile (`buildEliasProfile(targetPrefixTokens)` — sizes the memory core up to the ~50K-token success-criteria prefix), Narrator profile, lore generator (pure function, no randomness). M3: `FIXTURE_SUBLOCATIONS` (common_room/cellar/shrine — clients render placeholder backdrops per id) and `FIXTURE_ART_SETS` (Elias: neutral/smile/worried/working). M4 part 2: the trio carries stub descriptions; the fresh-world seed emits them as `sublocation.materialized` (the map starts with three explored squares) and NO scene auto-opens anymore — the splash (wireframe 03) is the entry surface; the gateway opens its echo scene on demand. |
| `event-sink.ts` | Documented under [http.md](http.md) (append-then-publish). |

## Deviations recorded

- ~~The root `fixtures/` directory is deferred~~ — resolved in M4:
  `fixtures/example-world/` + loader exist for row inspection
  (builder.md §4.3). The engine's own fixture world still ships as code here
  (type-safe imports); that split is deliberate.

## Tests

Invariants I5: `tests/invariants/prompt-prefix/context-assembler.test.ts` — byte-identical across calls, dynamic-only changes leave the prefix untouched, hostile-injection fixture, wrapper-escape neutralization, deterministic ~50K-token fixture scaling.
