# tools — kill harness & consistency verifier

Purpose: the permanent crash-torture rig (Invariant I4; owner mandate: Week-1 checks become permanent CI, never throwaway scripts).

## File table

| File | What it does / talks to |
| --- | --- |
| `tools/kill-harness.mjs` | Spawns the real built server (`WELTARI_FAKE_LLM=1`, fault points on, `WELTARI_FAULT_PAUSE_MS=400`, `WELTARI_LEASE_SECONDS=2`), per cycle: proves a `Last-Event-ID` reconnect delivers exactly the missed events, drives the cycle's fault-point action, SIGKILLs, then runs the verifier offline. M2 round-robin (Brief §4 table): `mid_stream` → `between_calls` → `pre_commit` → `mid_reflection` (end-scene fan-out; the follow-up scene open is the criterion-b demonstration incl. a cross-world 202 probe) → `mid_painter` (paint-region) → `mid_cron` (advance-time) → `client_disconnect` (SSE aborted mid-narration; the turn must still commit) → `mid_update` (M3 part 2, criterion a: apply-update against a local signed release fixture, killed after verification before the pointer flip; the next cycle proves convergence — staged event + pointer flipped by the retried job — and a torn flip fails immediately). The release fixture reuses the compiled test signers (`tests/dist/helpers/minisign.js` + `tar.js`) on a local HTTP server with a fresh version per mid_update cycle. `CYCLES` env: 25 per PR, 100 nightly. Works on Windows (`kill('SIGKILL')` = TerminateProcess); M3 hardening for Windows ephemeral-port pressure: per-cycle server-port rotation + persistent `EADDRINUSE` retry. |
| `tools/m3-plugin-proof.mjs` | M3 criteria (a) + (d): `PROOF_MAIN` / `PROOF_PLUGINS_DIR` / `PROOF_NODE` env overrides retarget it at an extracted package (part-2 criterion d measures the shipped artifact). Authors a drop-in plugin (theme + custom element + connector, plain files), boots the real server with `plugins/` (incl. wl-map), verifies `GET /v1/plugins` lists all three capabilities with the computed provenance sha256, fetches the zero-build assets, samples idle RSS from the server's gauges (< 170 MB), then flips one byte and proves the B10 refusal on restart (`plugin.rejected` durable, assets 404, app boots without it). Cleans up after itself. |
| `tools/verify-consistency.mjs` | Offline checks after each kill: `PRAGMA integrity_check`; event ids strictly increasing + unique; payloads all JSON; envelope discipline (≤1 commit per turn, no commit without start — started-without-committed is the expected voided-turn shape, B6); scene.ended fan-out atomicity (event ⇒ all its job rows); cold-path outcome events unique per natural key (reflection/world-agent/world-cron/painter — kill-retry stayed idempotent); world clock monotonic per world; painter hash check (`<images-dir>` arg: every painter.completed's file exists and matches its sha256 — zero corrupted images); update.staged unique per version + pointer discipline (`<versions-dir>` arg: a `current` pointer must name a complete version dir — no torn flips, B12); ledger states legal, running rows leased. Exit 1 = CI fails. |
| `tools/m2-rss-check.mjs` | M2 criterion (c): spawns the server with the ~50K-token prefix and 200 ms gauges, drives turn → end-scene fan-out + painter composite + 3-day time-skip, takes peak `rss_mb` from the server's own gauge lines. Exit 1 at ≥ 256 MB. |

| `tools/cache-hit-check.mjs` | The success-criteria / nightly real-provider runner (Guide §0.14): spawns the real server (`LOG_LEVEL=debug`, `WELTARI_PREFIX_TOKENS` default 50000), plays `TURNS` (default 20) consecutive turns over the live SSE stream, measures time-to-first-sentence per turn, reads per-call `cached_tokens` from the debug log, samples idle RSS at the end. Voided turns (provider 429/5xx) are retried after a backoff. Requires `OPENROUTER_API_KEY` (env only). Exit 0 = criteria a, b, e all pass. |

| `tools/check-tests-accompany.mjs` | E2 gate: `git diff` against the PR base — a new `apps/server/src` or `packages/*/src` file with no test file added/modified in the same range exits 1. Runs in the PR-only `tests-accompany` CI job. |

| `tools/update-fixture.mjs` | Manual dev fixture (M4, Config update surface): the kill harness's signed-release trio as a standalone local server — `node tools/update-fixture.mjs [version] [port]` prints the `WELTARI_UPDATE_RELEASES_URL` + `WELTARI_UPDATE_PUBKEY` to start the server with; the Config page then shows the real update.available → Apply → update.staged round-trip. Fresh keypair per run — nothing it signs verifies anywhere else. |

## CI wiring

- `.github/workflows/ci.yml` → `kill-harness` job, `CYCLES=25`, every push/PR.
- `.github/workflows/nightly.yml` → `CYCLES=100` at 03:30 UTC + manual dispatch. The nightly real-provider cache-hit check joins here (see file comment).

## Why the fault pause

`FAULT_POINT:<name>` is printed, the harness reacts in milliseconds — but a microtask can commit first. `WELTARI_FAULT_PAUSE_MS` holds the engine at `between_calls`/`pre_commit` so the SIGKILL reliably lands inside the window; `mid_stream` needs no hold (many event-loop yields during streaming, and nothing durable exists in that phase either way).
