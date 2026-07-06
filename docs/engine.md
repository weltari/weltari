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
| `fixture/rainy-inn.ts` | Deterministic Week-1 fixture world: Elias profile (`buildEliasProfile(targetPrefixTokens)` — sizes the memory core up to the ~50K-token success-criteria prefix), Narrator profile, lore generator (pure function, no randomness). |
| `event-sink.ts` | Documented under [http.md](http.md) (append-then-publish). |

## Deviations recorded

- The root `fixtures/` directory (data-file fixtures agents can load) is deferred; the Week-1 fixture world ships as code here so the engine and main.ts can import it type-safely. Revisit when world loading exists.

## Tests

Invariants I5: `tests/invariants/prompt-prefix/context-assembler.test.ts` — byte-identical across calls, dynamic-only changes leave the prefix untouched, hostile-injection fixture, wrapper-escape neutralization, deterministic ~50K-token fixture scaling.
