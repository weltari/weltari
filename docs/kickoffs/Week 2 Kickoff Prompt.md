# Week 2–3 Kickoff — Milestone 2: the full kill -9 table under load (paste this to start the session)

Build Milestone 2 for Weltari in this repository (`D:\devproj\weltari`, remote `https://github.com/weltari/weltari`). The Week-1 walking skeleton is complete and pushed — all five success criteria passed (see `docs/week1-results.md`). I am not a professional developer — explain plainly, recommend, and let me decide only where a genuine value judgment remains.

## Read first, in this order

1. `CLAUDE.md` — the one-page agent index (commands, layout, never-violate rules).
2. `docs/Coding Guide/AI Coding Guide.md` — the binding rulebook; `docs/Coding Guide/Task Completion Checklist.md` — the definition of done; `docs/Coding Guide/Weltari Invariants & Test Templates.md` — the invariant list (I1–I14).
3. `docs/INDEX.md` → the module wiki pages for whatever you touch (`storage.md`, `ledger.md`, `llm.md`, `http.md`, `engine.md`, `tools.md`) — they describe what exists and the deviations already recorded.
4. `docs/week1-results.md` — the measured baseline, the proven LLM configuration, and the model-caching findings.
5. `docs/Stack Session/FINAL - Stack Decision.md` §6 (Milestone 2 scope + success criteria) and `docs/Stack Requirements Brief.md` §2/§4 — the requirements.
6. `docs/builder.md` — docs rules (module page changes in the same commit).

## What to build, in recommended order

**0. Hardening commit(s) first (small, ~1 session-hour):** the self-watch pieces the Guide mandates that Week 1 deferred — `observability/gauges.ts` (event-loop p99 + RSS every 15 s at `debug`, `warn` past 200 ms / 220 MB, mirrored as `dev.gauges` events — C13) with its 30-s smoke test (I14); the idle-quiet test (I13: one idle minute stays under a fixed info-line budget); and the cheap missing CI scripts: `scripts/check-dep-ledger.mjs` (every dep has a `## <name>` heading), `scripts/check-licenses.mjs` (A12/D8), the C6 handler grep, the C3 catch-audit grep, `tools/check-tests-accompany.mjs` (E2).

**1. Reflection fan-out** — at scene end, one ledger job per participating character plus one World Agent job (serialized per world via `serial_group`, already supported). First real job handlers through the runner. Scene-end emits `scene.ended` + enqueues jobs atomically (one WriteGate transaction — Brief §2.4).

**2. World-clock CRON + time-skip replay** — engine-owned fictional `WorldClock` driving scheduled rows (the croner scheduler exists); time-skip replays all due instances in scheduled-game-timestamp order: code-class instantly, LLM-class in background under a per-skip budget (default ~10).

**3. Painter job** — one image job: sharp crop → feather-mask composite → resize, under a region lease, temp-file + atomic rename + event append (composite-on-success, kill-safe). Use a fixture/stub image source — real generation backends are a later milestone; the crash-safety mechanics are what M2 proves. sharp is import-fenced to its home directory when added (extend eslint.config.mjs A11 table + `docs/dependencies.md`).

**4. Telegram echo** — grammY built-in long-polling behind the `GatewayConnector` interface (`start/stop/send/onInbound/health`), dedup via `UNIQUE(connector_id, external_msg_id)` insert (B7: validate with own Zod schema, silent-drop duplicates, 8 KB inbound cap). Ask me for a bot token when you need it (env var only — never committed). Echo turn results to Telegram and accept inbound text as a turn command.

**5. Kill-harness extension** — new fault points per the Brief §4 table: `mid_reflection`, `mid_painter`, `mid_cron`, plus a client-disconnect case; keep the existing three. CI stays 25 cycles/PR, 100 nightly.

## Success criteria (FINAL §6, Milestone 2 — all must be demonstrated)

(a) **100 kill/restart cycles** across the extended fault table with **zero lost or duplicated durable events and zero corrupted images** (hash-verified, composite-on-success proven); (b) new-scene opens block only on *that world + involved characters'* pending jobs; (c) **peak RSS < 256 MB** during reflection fan-out plus one painter composite; (d) time-skip replays code-class instantly and LLM-class in background under the per-skip budget.

## Notes carried over from Week 1

- **LLM config proven:** `anthropic/claude-sonnet-4.5` pinned to provider `anthropic`, explicit `cache_control` breakpoint (already the default). Implicit caching (Gemini) is probabilistic — do not rely on it. ~$2 of the $5 OpenRouter test key remains; the key file `openrouter_api.txt` is gitignored, env-var only, and will be deleted by me later. Reflections/CRON testing should use `WELTARI_FAKE_LLM=1` except for final spot checks.
- The nightly CI workflow runs the 100-cycle kill harness; the real-provider cache-hit job stays manual (no CI key, my decision).
- Recorded deferrals you may now need: `packages/plugin-sdk` (create when the GatewayConnector conformance tests land — it is the MIT home for them), root `fixtures/` (create if painter fixtures fit better there than in code), zustand (M3, real Scene page).
- Git pushes to main: I run in "accept edits" mode and will approve your pushes.

## Process rules (unchanged)

- Small conventional commits (one logical change each), pushed as you go; `npm run gate` must exit 0 before anything is called done; tests + docs page in the same commit; new deps need `docs/dependencies.md` entries with exact pins.
- Never modify the spec/session documents in `docs/` (Brief, UI Spec, Stack Session/, Coding Guide/, Rev 3/Rev 4).
- Modifying existing `tests/invariants/` files needs my `invariant-change` label — add new invariant tests freely.
- After each milestone-sized step, summarize plainly what exists and what's next.
