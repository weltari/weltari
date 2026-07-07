# Milestone 2 — success-criteria results (2026-07-07)

Measured with `tools/kill-harness.mjs` (extended M2 fault table), `tools/m2-rss-check.mjs`, and a scripted criterion-(d) run, on the owner's Windows dev box. Criteria from FINAL §6, Milestone 2. All engine work ran against the FakeLLM (`WELTARI_FAKE_LLM=1`) per the kickoff instruction — crash-safety mechanics, not provider behavior, are what M2 proves.

## Verdicts

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| a | 100 kill/restart cycles across the extended fault table, zero lost or duplicated durable events, zero corrupted images (hash-verified, composite-on-success) | **PASS — 100/100 cycles** over all 7 fault points (`mid_stream`, `between_calls`, `pre_commit`, `mid_reflection`, `mid_painter`, `mid_cron`, `client_disconnect`); verifier ran after every kill: ids strictly increasing, envelopes clean, fan-out atomic, outcome events unique per natural key, every `painter.completed` file matched its sha256 | `CYCLES=100 node tools/kill-harness.mjs` |
| b | New-scene opens block only on *that world + involved characters'* pending jobs | **PASS** — after every `mid_reflection` kill the harness polls open-scene until the fan-out drains (blocked ⇒ 409), and the first 409 triggers the cross-world probe: an unrelated world opened with 202 instantly. Character scoping pinned by unit tests (`scene-lifecycle.test.ts`) | harness `criterion b probe ok` line + unit suite |
| c | Peak RSS < 256 MB during reflection fan-out plus one painter composite | **PASS — peak 129.4 MB** (50K-token prefix, fan-out + painter + 3-day time-skip driven concurrently, 200 ms gauge sampling) | `node tools/m2-rss-check.mjs` |
| d | Time-skip replays code-class instantly and LLM-class in background under the per-skip budget (default ~10) | **PASS** — a 30-day skip enqueued 30 code + 10 LLM occurrences (20 skipped over budget, newest kept); all 30 code occurrences were durable within 500 ms of the 202 (the kicked drain), LLM in background; class ordering pinned by `world-clock.test.ts` | advance-time response `{code_enqueued:30, llm_enqueued:10, llm_skipped:20}` |

## What the extended fault table proves

- **mid_reflection** — SIGKILL lands between the LLM result and the `reflection.committed` append. The lease (2 s in harness) expires, the retry re-runs the handler, and the idempotency gate (committed event per scene+character) keeps the projection single. `scene.ended` is never found without its job rows (one WriteGate transaction).
- **mid_painter** — SIGKILL lands between the atomic rename and the event append (the nastiest window). The deterministic pipeline regenerates byte-identical output on retry; the verifier hashes every committed image.
- **mid_cron** — SIGKILL lands between an occurrence's execution and its `world_cron.completed` append; retry is a no-op past the committed event; the world clock stays monotonic (`from` = previous `to`, verified offline).
- **client_disconnect** — an SSE client aborted mid-narration costs nothing durable: the turn still commits, and the next cycle's `Last-Event-ID` resume delivers every missed event exactly once.

## Notes

- Job leases are 2 s in the harness (`WELTARI_LEASE_SECONDS`) so a killed-mid-job lease expires within one cycle; production default stays 60 s.
- Real-provider spot checks passed 2026-07-07: a real-LLM turn + scene-end fan-out committed an in-character `reflection.committed` and `world_agent.committed` (`anthropic/claude-sonnet-4.5`, pinned provider); a live Telegram message to the owner's test bot ran a real turn end-to-end and the transcript echoed back with zero send failures (dedup row recorded). Token was env-only and is to be revoked by the owner; cost a few cents of the remaining OpenRouter budget.
