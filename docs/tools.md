# tools — kill harness & consistency verifier

Purpose: the permanent crash-torture rig (Invariant I4; owner mandate: Week-1 checks become permanent CI, never throwaway scripts).

## File table

| File | What it does / talks to |
| --- | --- |
| `tools/kill-harness.mjs` | Spawns the real built server (`WELTARI_FAKE_LLM=1`, fault points on, `WELTARI_FAULT_PAUSE_MS=400`), per cycle: proves a `Last-Event-ID` reconnect delivers exactly the missed events, POSTs a turn, SIGKILLs at the cycle's fault point (`mid_stream` → `between_calls` → `pre_commit`, round-robin), then runs the verifier offline. `CYCLES` env: 25 per PR, 100 nightly. Works on Windows (`kill('SIGKILL')` = TerminateProcess). |
| `tools/verify-consistency.mjs` | Offline checks after each kill: `PRAGMA integrity_check`; event ids strictly increasing + unique; payloads all JSON; envelope discipline (≤1 commit per turn, no commit without start — started-without-committed is the expected voided-turn shape, B6); ledger states legal, running rows leased. Exit 1 = CI fails. |

| `tools/cache-hit-check.mjs` | The success-criteria / nightly real-provider runner (Guide §0.14): spawns the real server (`LOG_LEVEL=debug`, `WELTARI_PREFIX_TOKENS` default 50000), plays `TURNS` (default 20) consecutive turns over the live SSE stream, measures time-to-first-sentence per turn, reads per-call `cached_tokens` from the debug log, samples idle RSS at the end. Voided turns (provider 429/5xx) are retried after a backoff. Requires `OPENROUTER_API_KEY` (env only). Exit 0 = criteria a, b, e all pass. |

| `tools/check-tests-accompany.mjs` | E2 gate: `git diff` against the PR base — a new `apps/server/src` or `packages/*/src` file with no test file added/modified in the same range exits 1. Runs in the PR-only `tests-accompany` CI job. |

## CI wiring

- `.github/workflows/ci.yml` → `kill-harness` job, `CYCLES=25`, every push/PR.
- `.github/workflows/nightly.yml` → `CYCLES=100` at 03:30 UTC + manual dispatch. The nightly real-provider cache-hit check joins here (see file comment).

## Why the fault pause

`FAULT_POINT:<name>` is printed, the harness reacts in milliseconds — but a microtask can commit first. `WELTARI_FAULT_PAUSE_MS` holds the engine at `between_calls`/`pre_commit` so the SIGKILL reliably lands inside the window; `mid_stream` needs no hold (many event-loop yields during streaming, and nothing durable exists in that phase either way).
