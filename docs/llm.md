# llm — apps/server/src/llm (the only AI-SDK site)

Purpose: normalize provider streaming/usage quirks behind one owned seam (`LlmClient`) while the ContextAssembler keeps 100% ownership of prompt content and order (FINAL item 9). `ai` + `@openrouter/ai-sdk-provider` are import-fenced here (A11).

## Contract

- Inputs: `LlmCall` — `{ kind, characterId, system: stablePrefix, prompt: dynamicTail, onTextDelta }`.
- Outputs: `Result<LlmCallResult>` — full text + `{inputTokens, outputTokens, cachedInputTokens}` + model + duration. Provider failures are `err(operational)`, never throws (C2).
- Never: reorder or rewrite prompt content; let SDK exceptions escape; log prompt content above `trace` (C12 — the debug line carries token counts only).

## File table

| File | What it does / talks to |
| --- | --- |
| `types.ts` | The seam: `LlmClient`, `LlmCall`, `LlmUsage`. Everything outside this dir imports only this. `CallKind` covers the scripted turn (`narrator`/`character`/`narration`) plus the cold-path kinds `reflection`, `world_agent` and `materialize` (M4 part 2: the sublocation-stub generation). M3: `LlmCall.toolset` ('narrator') offers tools; `LlmCallResult.toolCalls` returns RAW calls — callers must run both B6 gates. |
| `tools.ts` | Narrator tool definitions (`end_scene`, `change_sublocation`, `switch_art`) + `parseToolCall` — gate 1 of the B6 double gate (our own safeParse via `validateAt('llm', …)`, even when the provider "guaranteed" the shape). Gate 2 lives in `engine/scene-tools.ts`. |
| `model-registry.ts` | character/function → model+provider order+params; per-character pinning keeps prompt caches warm (owner decision #3). Config from env (`WELTARI_MODEL`, `WELTARI_PROVIDER_ORDER`). |
| `openrouter-client.ts` | `streamText` against OpenRouter; provider pinning via `extraBody.provider.order` (`allow_fallbacks:false`); usage accounting on (`usage.include`); `cached_tokens` extracted defensively from SDK usage or OpenRouter metadata; per-call `debug` log = the cache-hit observability (risk register #1). 120 s abort. M3: passes the narrator toolset as SDK `tool()`s with Zod inputSchemas (no execute — calls come back as data for the gates). |
| `structured.ts` | `parseLlmJson` — the ONE audited JSON.parse site for model output (B-llm): raw text or first ```json fence -> `unknown` for `validateAt`; null on failure (reject, never repair — B4). |
| `image-source.ts` | `createOpenRouterImageSource` (M5 part 1) — the painter's real tile backend, living here because `ai` + the provider are fenced in llm/ (A11). `generateImage` against OpenRouter's `/v1/images` endpoint (`WELTARI_IMAGE_MODEL`, aspect ratio 1:1 — the compositor resizes, Rev 4 §14 size rules); provider failure → OperationalError → runner retry (C7); per-call `debug` log carries sizes/tokens only (C12). Selected in main.ts by `WELTARI_IMAGE_BACKEND=openrouter` + key; the painter's stub stays the default ([painter.md](painter.md)). |
| `vlm.ts` | The VLM seam (M5 part 1, B-llm): `VlmClient.describe({kind, prompt, image, mediaType}) → Result<{text, usage, model, durationMs}>` — image + prompt in, RAW text out; callers run gate 1 themselves (`parseLlmJson` → `validateAt`) and gate 2 before anything durable (B6). `kind` names the consumer (`map_qa` now; `classify_click` = week-8 Flow B, which reuses this exact call shape). Cold-path `generateText`, temperature 0.2, `WELTARI_VLM_MODEL` (default `google/gemini-3.5-flash`); provider failure → `err(operational)` (C2). Week-7 consumer: `tools/m5-map-qa.mjs` ([tools.md](tools.md)). Tested offline through the provider's fetch seam. |
| `fake-client.ts` | Deterministic scripted double, selected by `WELTARI_FAKE_LLM=1`. Lives in src because the kill harness runs the real binary against it (I4). M3: scripts tool calls from public-API text triggers — `!end [type]`, `!move <id>`, `!art <char> <art>`, `!badshape`, `!ghosttool` — so tests, the harness and a browser can drive the whole B6 pipeline. M4 part 2: a deterministic JSON stub for `materialize` calls (malformed-stub rejection is driven by a stub client at the seam in the invariant tests). `WELTARI_FAKE_LLM_DELAY_MS` holds before each call's first token — the simulated 5–10 s generation window the §1.14 masking animations are verified against. |

## engine additions (scene turn)

| File | What it does / talks to |
| --- | --- |
| `engine/scene-turn.ts` | The scripted turn: `turn.started` durable first → Narrator (with the narrator toolset) → character → narration (sequential, each streamed sentence-by-sentence to StreamBus) → ONE transaction committing `turn.committed` + staged tool events (+ scene.ended with fan-out when end_scene staged), published after commit. Any failure voids the turn — zero partial durable rows (B6). `interruptTurn` closes the envelope immediately at the user's last-seen sentence: truncated `turn.committed` (marked `interrupted`), staged tool effects discarded, later LLM output finishes into the void. Fault-point hooks `mid_stream`/`between_calls`/`pre_commit` for the kill harness. |
| `engine/sentences.ts` | Incremental sentence splitter (deltas in → whole sentences out). |

## Events consumed/emitted

Emits `turn.started`, `turn.committed` (actor = commanding actor). Reads `turn.committed` for the transcript tail.

## Tests

Turn ordering + stream indexes + fault sequence; mid-turn failure leaves only `turn.started`; stable prefix byte-identical across turns while the tail changes (the cache contract); sentence splitter; registry routing/pinning.
