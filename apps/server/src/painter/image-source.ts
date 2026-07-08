// The ImageSource seam (M5 part 1): the ONE place a painter job's pixels come
// from. `stub` is the permanent DEFAULT — deterministic, free, offline — so
// tests, the kill harness and CI never touch a provider. Real backends
// (llm/image-source.ts, env-selected via WELTARI_IMAGE_BACKEND=openrouter)
// implement the same interface; the composite/temp+rename/idempotency
// mechanics around it never change (Rev 4 §14: composite-back is the sole
// preservation guarantee, whatever fills the pixels).
import { createHash } from 'node:crypto';
import type { ImageRegion } from '@weltari/protocol';
import sharp from 'sharp';

/** What a generation backend receives. `prompt` is world flavor (sublocation
 * stub + neighbors); the stub ignores it, a real model paints from it. */
export interface TileRequest {
  /** Ledger idempotency key — seeds the deterministic stub tile. */
  jobKey: string;
  region: ImageRegion;
  prompt: string;
}

export interface ImageSource {
  /** Name for logs/docs: 'stub' | 'openrouter'. */
  readonly name: string;
  /**
   * Returns an encoded image (PNG/JPEG) of ANY size — the compositor resizes
   * to the region. Provider failures throw OperationalError → runner retry
   * (C7); a killed real-paint job simply regenerates (the only retry cost is
   * one duplicate API call, Rev 4 §14). NOT byte-deterministic for real
   * backends — idempotency keys on the painter.completed EVENT, never bytes.
   */
  generateTile(request: TileRequest): Promise<Buffer>;
}

const STUB_TILE_SIZE = 256; // "the model returns arbitrary sizes" — the resize step stays real

/** Deterministic stub: a solid tile whose color derives from the job key, at
 * a size the region does NOT match (forces the resize). Byte-identical per
 * key — the kill-retry unit tests keep running against THIS source. */
export function createStubImageSource(): ImageSource {
  return {
    name: 'stub',
    async generateTile(request: TileRequest): Promise<Buffer> {
      const digest = createHash('sha256').update(request.jobKey).digest();
      const r = digest[0] ?? 0;
      const g = digest[1] ?? 0;
      const b = digest[2] ?? 0;
      return sharp({
        create: {
          width: STUB_TILE_SIZE,
          height: STUB_TILE_SIZE,
          channels: 3,
          background: { r, g, b },
        },
      })
        .png()
        .toBuffer();
    },
  };
}
