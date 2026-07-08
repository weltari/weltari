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

/** The surrounding-pixels context for seamless continuation (week-7 fix for
 * cross-tile discontinuity): a crop of the CURRENT composite around the
 * region — painted neighbors plus checkerboard fog — that an editing-capable
 * backend receives as an input reference ("continue this exact painting into
 * the fog"). Geometry is painter-owned; the model only fills pixels. */
export interface TileContext {
  /** PNG crop of the current composite (window around the region). */
  window: Buffer;
  /** Where the region sits INSIDE the window (window pixel coordinates). */
  target: ImageRegion;
  /** Window pixel size. */
  width: number;
  height: number;
}

/** What a generation backend receives. `prompt` is world flavor (sublocation
 * stub + neighbors); the stub ignores it, a real model paints from it. */
export interface TileRequest {
  /** Ledger idempotency key — seeds the deterministic stub tile. */
  jobKey: string;
  region: ImageRegion;
  prompt: string;
  context?: TileContext;
}

export interface GeneratedTile {
  /** Encoded image (PNG/JPEG) of ANY size — the compositor resizes. */
  image: Buffer;
  /** 'region' = the image depicts the region alone; 'window' = the image
   * repaints the whole context window (edit mode) and the compositor
   * extracts the target rect before feathering. */
  coverage: 'region' | 'window';
}

export interface ImageSource {
  /** Name for logs/docs: 'stub' | 'openrouter'. */
  readonly name: string;
  /**
   * Provider failures throw OperationalError → runner retry (C7); a killed
   * real-paint job simply regenerates (the only retry cost is one duplicate
   * API call, Rev 4 §14). NOT byte-deterministic for real backends —
   * idempotency keys on the painter.completed EVENT, never bytes.
   */
  generateTile(request: TileRequest): Promise<GeneratedTile>;
}

const STUB_TILE_SIZE = 256; // "the model returns arbitrary sizes" — the resize step stays real

/** Deterministic stub: a solid tile whose color derives from the job key, at
 * a size the region does NOT match (forces the resize). Byte-identical per
 * key — the kill-retry unit tests keep running against THIS source. */
export function createStubImageSource(): ImageSource {
  return {
    name: 'stub',
    async generateTile(request: TileRequest): Promise<GeneratedTile> {
      const digest = createHash('sha256').update(request.jobKey).digest();
      const r = digest[0] ?? 0;
      const g = digest[1] ?? 0;
      const b = digest[2] ?? 0;
      const image = await sharp({
        create: {
          width: STUB_TILE_SIZE,
          height: STUB_TILE_SIZE,
          channels: 3,
          background: { r, g, b },
        },
      })
        .png()
        .toBuffer();
      return { image, coverage: 'region' };
    },
  };
}
