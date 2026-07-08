// The real tile backend (M5 part 1) — OpenRouter image generation through the
// AI-SDK fence (A11: `ai` + the provider import live only in llm/). It
// implements the painter's ImageSource seam; the composite/temp+rename
// mechanics never see which source filled the pixels. Output is NOT
// byte-deterministic — idempotency keys on the painter.completed EVENT, and a
// killed real-paint job regenerates at the cost of one duplicate API call
// (Rev 4 §14, no-mask branch: composite-back is the sole preservation
// guarantee).
import { generateImage } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { OperationalError } from '../errors.js';
import type { Logger } from '../observability/logger.js';
import type { ImageSource, TileRequest } from '../painter/image-source.js';

export interface OpenRouterImageSourceOptions {
  apiKey: string;
  /** OpenRouter image model id (WELTARI_IMAGE_MODEL). */
  model: string;
  logger: Logger;
  timeoutMs?: number;
}

export function createOpenRouterImageSource(
  options: OpenRouterImageSourceOptions,
): ImageSource {
  const openrouter = createOpenRouter({ apiKey: options.apiKey });
  const timeoutMs = options.timeoutMs ?? 120000;

  return {
    name: 'openrouter',
    async generateTile(request: TileRequest): Promise<Buffer> {
      const startedAt = performance.now();
      try {
        const result = await generateImage({
          model: openrouter.imageModel(options.model),
          prompt: request.prompt,
          // Fog squares are square; tier/ratio models (Gemini) get resized to
          // the region by the compositor afterwards (Rev 4 §14 size rules).
          aspectRatio: '1:1',
          abortSignal: AbortSignal.timeout(timeoutMs),
        });
        // C12: token/size accounting only — never prompt content above trace.
        options.logger.debug(
          {
            model: options.model,
            job_key: request.jobKey,
            media_type: result.image.mediaType,
            bytes: result.image.uint8Array.byteLength,
            input_tokens: result.usage.inputTokens ?? 0,
            output_tokens: result.usage.outputTokens ?? 0,
            duration_ms: Math.round(performance.now() - startedAt),
          },
          'image generation finished',
        );
        return Buffer.from(result.image.uint8Array);
      } catch (thrown) {
        // Provider failure = operational (C2/C7): the runner retries, the
        // canvas is untouched (composite-on-success), nothing half-visible.
        throw new OperationalError(
          'image_generation_failed',
          thrown instanceof Error ? thrown.message : 'unknown provider failure',
          { cause: thrown },
        );
      }
    },
  };
}
