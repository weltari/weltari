# llm — apps/server/src/llm (the only AI-SDK site)

Purpose: normalize provider streaming/usage quirks behind one owned seam (`LlmClient`) while the ContextAssembler keeps 100% ownership of prompt content and order (FINAL item 9). `ai` + `@openrouter/ai-sdk-provider` are import-fenced here (A11).

## Contract

- Inputs: `LlmCall` — `{ kind, characterId, system: stablePrefix, prompt: dynamicTail, onTextDelta }`.
- Outputs: `Result<LlmCallResult>` — full text + `{inputTokens, outputTokens, cachedInputTokens}` + model + duration. Provider failures are `err(operational)`, never throws (C2).
- Never: reorder or rewrite prompt content; let SDK exceptions escape; log prompt content above `trace` (C12 — the debug line carries token counts only).

## File table

| File | What it does / talks to |
| --- | --- |
| `types.ts` | The seam: `LlmClient`, `LlmCall`, `LlmUsage`. Everything outside this dir imports only this. |
| `model-registry.ts` | character/function → model+provider order+params; per-character pinning keeps prompt caches warm (owner decision #3). Config from env (`WELTARI_MODEL`, `WELTARI_PROVIDER_ORDER`). |
| `openrouter-client.ts` | `streamText` against OpenRouter; provider pinning via `extraBody.provider.order` (`allow_fallbacks:false`); usage accounting on (`usage.include`); `cached_tokens` extracted defensively from SDK usage or OpenRouter metadata; per-call `debug` log = the cache-hit observability (risk register #1). 120 s abort. |
| `fake-client.ts` | Deterministic scripted double, selected by `WELTARI_FAKE_LLM=1`. Lives in src because the kill harness runs the real binary against it (I4). |

## engine additions (scene turn)

| File | What it does / talks to |
| --- | --- |
| `engine/scene-turn.ts` | The scripted turn: `turn.started` durable first → Narrator → character → narration (sequential, each streamed sentence-by-sentence to StreamBus) → `turn.committed` with all steps. Any failure voids the turn — zero partial durable rows (B6). Fault-point hooks `mid_stream`/`between_calls`/`pre_commit` for the kill harness. |
| `engine/sentences.ts` | Incremental sentence splitter (deltas in → whole sentences out). |

## Events consumed/emitted

Emits `turn.started`, `turn.committed` (actor = commanding actor). Reads `turn.committed` for the transcript tail.

## Tests

Turn ordering + stream indexes + fault sequence; mid-turn failure leaves only `turn.started`; stable prefix byte-identical across turns while the tail changes (the cache contract); sentence splitter; registry routing/pinning.
