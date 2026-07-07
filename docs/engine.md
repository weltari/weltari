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
| `scene-lifecycle.ts` | `endScene`: scene.ended + one reflection job per participating character (derived from the scene's committed turns) + one World Agent job (`serial_group world_agent:<world>`), all in ONE WriteGate transaction (Brief §2.4); bus publish after commit. `openScene`: blocks (409) only on this world's World-Agent jobs + this scene's participants' reflections (Brief §4, criterion b); M4: appends one `character.joined` per KNOWN participant atomically with scene.started (the roster projection — unknown ids are skipped with a warn, B6 ethos), published after commit in append order. M3: the atomicity core is extracted as `appendSceneEndWithFanOut` (runs inside a caller's transaction) so the Narrator's end_scene tool commits scene.ended + jobs in the SAME transaction as turn.committed. |
| `scene-tools.ts` | Gate 2 of the B6 double gate: validates shape-valid tool calls against game state (sublocation exists ∧ differs from current; character present ∧ pose in their art set; scene open ∧ not already ending). Valid effects are STAGED — the turn engine appends their durable events atomically with turn.committed; every rejection is a `dev.tool_rejected` trail frame with zero rows written (I8). |
| `fault-points.ts` | The `FaultPoint` union — the kill-harness contract (I4): Week-1 three + M2's `mid_reflection`/`mid_painter`/`mid_cron`. |
| `world-clock.ts` | The engine-owned fictional WorldClock: current time = projection of `world.time_advanced` events (epoch `2000-01-01T06:00Z`). `advanceTime` computes due world-cron occurrences (fictional-calendar math delegated to `ledger/scheduler.js` — A16), enqueues code-class first then the newest ≤budget LLM-class (default 10), all atomic with the time event; `kick` lets main drain the runner immediately (code-class = instant, Brief §4). |
| `fixture/rainy-inn.ts` | + `FIXTURE_WORLD_CRON`: `lamplighter` (code, fictional 06:00) and `evening_rumor` (LLM, fictional 18:00). |
| `fixture/rainy-inn.ts` | Deterministic Week-1 fixture world: Elias profile (`buildEliasProfile(targetPrefixTokens)` — sizes the memory core up to the ~50K-token success-criteria prefix), Narrator profile, lore generator (pure function, no randomness). M3: `FIXTURE_SUBLOCATIONS` (common_room/cellar/shrine — clients render placeholder backdrops per id) and `FIXTURE_ART_SETS` (Elias: neutral/smile/worried/working). |
| `event-sink.ts` | Documented under [http.md](http.md) (append-then-publish). |

## Deviations recorded

- ~~The root `fixtures/` directory is deferred~~ — resolved in M4:
  `fixtures/example-world/` + loader exist for row inspection
  (builder.md §4.3). The engine's own fixture world still ships as code here
  (type-safe imports); that split is deliberate.

## Tests

Invariants I5: `tests/invariants/prompt-prefix/context-assembler.test.ts` — byte-identical across calls, dynamic-only changes leave the prefix untouched, hostile-injection fixture, wrapper-escape neutralization, deterministic ~50K-token fixture scaling.
