# Milestone 3 part 1 — success-criteria results (2026-07-07)

Measured on the owner's Windows dev box against the FakeLLM
(`WELTARI_FAKE_LLM=1`) per the kickoff instruction. Criteria from FINAL §6
Milestone 3, part-1 subset (Week 3 Kickoff). Everything below is rerunnable;
the acceptance command is quoted per row.

## Verdicts

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| a | The drop-in plugin loads with **zero build step** and its provenance hash appears in dev mode | **PASS** — `plugins/proof-dropin` (one CSS theme + one custom-element surface + one connector, plain files, no toolchain) loaded on boot; `GET /v1/plugins` served all three capabilities with `sha256 85892f4a02c9…` equal to the computed content hash; the dev overlay renders exactly this endpoint (verified in-browser for wl-map: `⬡ wl-map@0.1.0 sha256:076289fe…`) | `node tools/m3-plugin-proof.mjs` → `M3-PROOF PASS` |
| b | The map renderer has **no private imports** (lint-verified) | **PASS** — `eslint.config.mjs` bans every import specifier under `plugins/wl-map/`; `npx eslint plugins --max-warnings 0` exits 0, and an injected `import … from '../../apps/server/src/main.js'` fails the rule (proven both directions) | `npx eslint plugins --max-warnings 0` |
| c | Scene-open and interrupt behavior: streamed sentences pace on click/auto; an interrupt closes the envelope and **nothing after the interruption point is durable** (B6) | **PASS** — unit-pinned with a gated LLM double (`scene-turn.test.ts`: truncated `turn.committed` marked `interrupted` holds only the seen sentence; a staged `change_sublocation` was discarded; interrupt-before-display voids the turn) and demonstrated in a real browser against a fault-pause server (`✋ Interrupt` mid-stream → `— interrupted —` in the transcript) | `npx vitest run apps/server/src/engine/scene-turn.test.ts` → 10 passed |
| d | Idle RSS **< 170 MB** with the plugins installed | **PASS — 107.9 MB** peak over a 6 s idle window (500 ms gauge sampling) with `wl-map` + `proof-dropin` loaded | `node tools/m3-plugin-proof.mjs` (criterion d line) |

## What part 1 shipped

- **The real VN Scene page** (`apps/web`): zustand store writable only by the
  SSE reducer; sentence pacing (click / Auto-Advance); interrupt-anywhere via
  the chatbox; VN line-up with speaker rise + `art.switched` poses; backdrop
  slide on `sublocation.changed`; soft close with the `end_type` button set;
  dedicated mobile layout; all visuals as `--wl-*` tokens
  (docs/web.md §Customizing the UI; `apps/web/structure.md`).
- **The B6 two-gate tool pipeline** with the first Narrator tools
  (`end_scene`, `change_sublocation`, `switch_art`): shape gate in `llm/`,
  state gate in `engine/scene-tools.ts`, staged effects committing atomically
  with `turn.committed` (end_scene shares the transaction with its fan-out),
  rejections as dev-trail frames with zero rows (I8 —
  `tests/invariants/llm-tool-gates.test.ts`).
- **`interrupt-turn`** end to end (engine + HTTP + protocol + UI).
- **The plugin loader** (B10): strict manifests, content hash verified at
  every load, `plugin.rejected` on refusal, zero-build asset serving,
  connectors joining the gateway host (`tests/invariants/plugin-hash.test.ts`).
- **The default `<wl-map>` plugin**: Canvas 2D tiles from `painter.completed`
  images (via the new read-only `GET /v1/images/*`), DOM pins anchored to
  `map_position` world coordinates, zero imports.
- Protocol 0.1.0 → 0.4.0 (all additive; schemas re-emitted each step).

## Notes / carried forward

- The kill harness re-run after the turn-commit refactor: **25/25 cycles over
  all 7 fault points, zero duplicate or lost events, zero corrupted images,
  resume exact** — the atomic tool-effect transaction kept the `pre_commit`
  semantics (`CYCLES=25 node tools/kill-harness.mjs`).
- Deferred to part 2 (per kickoff): packaging/update path, map fog/explore
  interactions, real backdrop/character art (tokens + `backdrop_path` are the
  slots), enabling the Narrator toolset on real-provider spot checks.
- Windows dev-box note: this box intermittently sits near ephemeral-port
  exhaustion (observed 15.6k TIME_WAIT of a 16.4k dynamic range — an external
  loopback-churning process). Mitigations shipped: test HTTP servers bind
  deterministic sub-ephemeral ports; harness + tests retry `connect
  EADDRINUSE` persistently; the harness rotates its server port per cycle.
  Owner option if it recurs: widen the range
  (`netsh int ipv4 set dynamicport tcp start=32768 num=32768`, admin).
