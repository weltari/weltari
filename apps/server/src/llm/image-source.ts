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
import type {
  GeneratedTile,
  ImageSource,
  TileRequest,
} from '../painter/image-source.js';

export interface OpenRouterImageSourceOptions {
  apiKey: string;
  /** OpenRouter image model id (WELTARI_IMAGE_MODEL). */
  model: string;
  logger: Logger;
  timeoutMs?: number;
}

/** Windows are 2 or 3 region-units per axis (margins clamp at map edges), so
 * exactly these ratios occur — all Gemini-supported tiers. */
function aspectRatioOf(width: number, height: number): '1:1' | '2:3' | '3:2' {
  if (width === height) return '1:1';
  return width < height ? '2:3' : '3:2';
}

export function createOpenRouterImageSource(
  options: OpenRouterImageSourceOptions,
): ImageSource {
  const openrouter = createOpenRouter({ apiKey: options.apiKey });
  const timeoutMs = options.timeoutMs ?? 120000;

  return {
    name: 'openrouter',
    async generateTile(request: TileRequest): Promise<GeneratedTile> {
      const startedAt = performance.now();
      // Edit mode (week-7 coherence fix): when the painter supplies the
      // context window, it travels as an input reference (`input_references`
      // on /v1/images) and the model CONTINUES the existing painting into
      // the fog instead of painting blind — geometric coherence across tile
      // seams. The checkerboard is the fog marker (Rev 4 §14 no-mask branch:
      // region-in-words; composite-back remains the sole guarantee).
      const editMode = request.context !== undefined;
      const prompt =
        request.context === undefined
          ? request.prompt
          : {
              images: [request.context.window],
              text:
                `${request.prompt}\n\nThe attached image is a crop of the current map canvas, ` +
                'spanning roughly 300×300 meters seen from high above. Repaint the ENTIRE crop ' +
                'at the same framing: keep every already-painted area as it is (same layout, ' +
                'same colors, same style), and replace every gray checkerboard placeholder ' +
                'area with newly painted terrain at exactly the same aerial viewpoint and the ' +
                'same small feature scale as the already-painted areas — do NOT zoom in. ' +
                'Continue roads, rivers, forests and field patterns seamlessly across the old ' +
                'edges. Return the full repainted crop.',
            };
      // Regions are square, but a clamped edge window can be 2:3 / 3:2 —
      // ask for the window's ratio so the compositor's fill-resize does not
      // distort the continuation (Gemini supports these tiers; Rev 4 §14).
      const aspectRatio =
        request.context === undefined
          ? ('1:1' as const)
          : aspectRatioOf(request.context.width, request.context.height);
      try {
        const result = await generateImage({
          model: openrouter.imageModel(options.model),
          prompt,
          aspectRatio,
          abortSignal: AbortSignal.timeout(timeoutMs),
        });
        // C12: token/size accounting only — never prompt content above trace.
        options.logger.debug(
          {
            model: options.model,
            job_key: request.jobKey,
            edit_mode: editMode,
            media_type: result.image.mediaType,
            bytes: result.image.uint8Array.byteLength,
            input_tokens: result.usage.inputTokens ?? 0,
            output_tokens: result.usage.outputTokens ?? 0,
            duration_ms: Math.round(performance.now() - startedAt),
          },
          'image generation finished',
        );
        return {
          image: Buffer.from(result.image.uint8Array),
          coverage: editMode ? 'window' : 'region',
        };
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
