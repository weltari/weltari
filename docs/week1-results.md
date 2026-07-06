# Week-1 walking skeleton — success-criteria results (2026-07-06)

Measured with `tools/cache-hit-check.mjs` (real OpenRouter key, env-only) and `tools/kill-harness.mjs`, on the owner's Windows dev box. Criteria from the Week-1 kickoff / FINAL de-risk plan §6.

## Verdicts

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| a | First sentence < 10 s with ~50K-token stable prefix, 256K-class model | **PASS — 3.9 s cold (turn 1), worst later turn 8.2 s** | 20-turn run, `anthropic/claude-sonnet-4.5` (1M-class), prefix measured 58.2K provider tokens |
| b | Provider-reported cached tokens ≥ 80% of the stable prefix on turns 2+ across 20 turns | **PASS — 57/57 calls, ~98% cached, deterministic** (58,233/58,235 tokens cached on every call) | explicit `cache_control` breakpoint on the system message |
| c | Every kill/restart cycle consistent, zero duplicate or lost events, `Last-Event-ID` resume | **PASS — 25/25 cycles** (mid_stream / between_calls / pre_commit round-robin), resume exact every cycle | `tools/kill-harness.mjs`, permanent CI (25/PR, 100/nightly) |
| d | Same stream consumed by `curl -N` with resume | **PASS** — hello frame + replay + live tail + `Last-Event-ID: N` resume all verified over plain curl | http smoke (docs/http.md) + every harness cycle uses raw HTTP |
| e | Idle RSS < 150 MB | **PASS — 104.6 MB** after the 20-turn run + 10 s idle (73–100 MB across other runs) | criteria runner RSS sample |

## Model findings (the criterion-b shootout)

| Model (pinned provider) | Cold first sentence @ ~50–68K prefix | Cache reliability turns 2+ |
| --- | --- | --- |
| `openai/gpt-4.1-mini` (openai) | 26.8 s @ 68K — **too slow cold** | 57/57 calls ~95–98% (automatic caching, reliable) |
| `google/gemini-2.5-flash` (google-ai-studio) | **1.6 s** — fastest prefill | 6/15 calls — implicit caching is probabilistic, character call never hit |
| `x-ai/grok-4.1-fast` (xai) | n/a — reasoning ate the 600-token output budget; turns voided | n/a |
| `anthropic/claude-haiku-4.5` (anthropic) | 2.8 s | 9/9 deterministic (`cache_control`) — but 200K context is under 256K-class |
| **`anthropic/claude-sonnet-4.5` (anthropic) — chosen default** | **3.9 s** | **57/57 deterministic ~98%** |

Two conclusions the risk register predicted: cross-provider routing silently kills caches (pin `provider.order`, owner decision #3), and implicit/automatic caching is not dependable enough to bet the token budget on — the explicit `cache_control` breakpoint is. The `LlmClient` seam sends it on every call; providers with automatic caching ignore it harmlessly.

## Bug found by the criteria run (fixed)

AI SDK v6 `streamText` does **not** throw on mid-stream provider errors (429 injected into the SSE stream); it ends the stream and calls `onError`. Before the fix, an errored stream could commit a turn with partial text and zero usage — a B6 violation. The client now captures `onError` and returns `err(operational)`, voiding the turn.

## Cost

The whole Week-1 measurement campaign (one 20-turn gpt-4.1-mini run, one 20-turn sonnet-4.5 run, four probes) spent roughly **$3 of the $5 key**.

## Standing decisions triggered

- Decision trigger (b) *not* tripped: caching works with pinned providers + explicit breakpoints — the AI-SDK-based LLM layer stays.
- Decision trigger (a) tripped only for `gpt-4.1-mini` cold prefill → resolved by model choice, not stack change (as the plan prescribes: "revisit context-size strategy, not the stack").
- `tools/cache-hit-check.mjs` is the nightly real-provider check (Guide §0.14); it needs the `OPENROUTER_API_KEY` repo secret before the nightly workflow can run it.
