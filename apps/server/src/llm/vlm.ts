// The VLM seam (M5 part 1, B-llm): one multimodal call shape — image + prompt
// in, RAW TEXT out. Like every model output it is boundary data: callers run
// gate 1 themselves (parseLlmJson → validateAt), and any durable effect needs
// gate 2 (B6). Week-7 consumer: the map-QA spot check (tools/m5-map-qa.mjs);
// week 8 reuses the same shape for Flow B click classification (Rev 4 §14).
// `ai` + the provider live here because llm/ is the AI-SDK fence (A11).
import { generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { Logger } from '../observability/logger.js';
import type { LlmUsage } from './types.js';

/** Gate-1 subject for the map-QA consumer (B6): reject, never repair (B4).
 * Lives with the seam so the tool and the tests gate identically. */
export const mapQaVerdictSchema = z.strictObject({
  visible: z.boolean(),
  confidence: z.enum(['low', 'medium', 'high']),
  reasoning: z.string().min(1).max(2000),
});

/** Named per consumer so routing/params can split later (§15 per-function
 * config); 'classify_click' is week 8's Flow B. */
export type VlmKind = 'map_qa' | 'classify_click';

export interface VlmCall {
  kind: VlmKind;
  prompt: string;
  /** Encoded image bytes (PNG/JPEG) — never a path; the caller owns IO. */
  image: Uint8Array;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export interface VlmCallResult {
  /** RAW model text — a B6 gate-1 subject, never durable as-is. */
  text: string;
  usage: LlmUsage;
  model: string;
  durationMs: number;
}

export interface VlmClient {
  describe(call: VlmCall): Promise<Result<VlmCallResult>>;
}

export interface OpenRouterVlmClientOptions {
  apiKey: string;
  /** OpenRouter multimodal model id (WELTARI_VLM_MODEL). */
  model: string;
  logger: Logger;
  timeoutMs?: number;
  /** Test seam: intercept HTTP without touching a provider. */
  fetch?: typeof fetch;
  /** SDK-internal retry count (default 2); tests set 0 for determinism. The
   * ledger runner owns real retry policy (C7) for job-driven callers. */
  maxRetries?: number;
}

export function createOpenRouterVlmClient(
  options: OpenRouterVlmClientOptions,
): VlmClient {
  const openrouter = createOpenRouter({
    apiKey: options.apiKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const timeoutMs = options.timeoutMs ?? 120000;

  return {
    async describe(call: VlmCall): Promise<Result<VlmCallResult>> {
      const startedAt = performance.now();
      try {
        const result = await generateText({
          model: openrouter.chat(options.model, { usage: { include: true } }),
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: call.prompt },
                { type: 'image', image: call.image, mediaType: call.mediaType },
              ],
            },
          ],
          // Classification, not prose: keep it cold and short.
          temperature: 0.2,
          maxOutputTokens: 600,
          ...(options.maxRetries === undefined
            ? {}
            : { maxRetries: options.maxRetries }),
          abortSignal: AbortSignal.timeout(timeoutMs),
        });
        const usage: LlmUsage = {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          cachedInputTokens:
            result.usage.inputTokenDetails.cacheReadTokens ?? 0,
        };
        const durationMs = Math.round(performance.now() - startedAt);
        // C12: token counts only — never prompt or image content.
        options.logger.debug(
          {
            model: options.model,
            call_kind: call.kind,
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            duration_ms: durationMs,
          },
          'vlm call finished',
        );
        return ok({
          text: result.text,
          usage,
          model: options.model,
          durationMs,
        });
      } catch (thrown) {
        return err(
          new OperationalError(
            'vlm_call_failed',
            thrown instanceof Error
              ? thrown.message
              : 'unknown provider failure',
            { cause: thrown },
          ),
        );
      }
    },
  };
}
