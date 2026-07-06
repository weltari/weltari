// The painter pipeline — the ONLY sharp site (A11 fence). M2 proves the
// crash-safety mechanics with a stub image source; real generation backends
// are a later milestone (FINAL item 10).
//
// Kill-safety shape (composite-on-success): every output is a NEW file written
// as temp-file + atomic rename; the painter.completed EVENT — not the file —
// is the truth about which image is current (Brief §2.1). A kill before the
// rename leaves only a temp file; a kill between rename and event append
// leaves an orphan file the idempotent retry regenerates byte-identically
// (same base + same job key => same pixels => same hash).
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ImageRegion } from '@weltari/protocol';
import sharp from 'sharp';

export const BASE_IMAGE_SIZE = 512;
const STUB_TILE_SIZE = 256; // "the model returns arbitrary sizes" — resize proves the step
const FEATHER_PX = 8;

export interface PaintSpec {
  imageId: string;
  region: ImageRegion;
  /** Ledger idempotency key — seeds the deterministic stub tile. */
  jobKey: string;
  imagesDir: string;
  /** Absolute path of the image to composite onto. */
  basePath: string;
}

export interface PaintResult {
  /** Path relative to imagesDir (what painter.completed carries). */
  path: string;
  sha256: string;
}

/** Filesystem-safe name for ids like `map:w1`. */
export function safeName(id: string): string {
  return id.replaceAll(/[^a-zA-Z0-9_-]/g, '-');
}

function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Temp-file + atomic rename; the idempotent-retry case (target already has
 * identical bytes after a kill between rename and event append) is a no-op. */
function writeAtomically(absolutePath: string, buffer: Buffer): void {
  mkdirSync(dirname(absolutePath), { recursive: true });
  if (existsSync(absolutePath)) {
    if (sha256Of(readFileSync(absolutePath)) === sha256Of(buffer)) return;
    // Different bytes can only mean a previous engine version or corruption;
    // the deterministic regeneration wins (the event that names it is truth).
    rmSync(absolutePath);
  }
  const temp = `${absolutePath}.tmp-${String(process.pid)}`;
  writeFileSync(temp, buffer);
  renameSync(temp, absolutePath);
}

/**
 * Deterministic fixture base (builder.md §4.3): a neutral checkerboard so
 * composite edges are visible in tests. Created lazily, atomically, once.
 */
export async function ensureBaseImage(
  imagesDir: string,
  imageId: string,
): Promise<string> {
  const absolutePath = join(imagesDir, safeName(imageId), 'base.png');
  if (existsSync(absolutePath)) return absolutePath;
  const square = 32;
  const channels = 3;
  const raw = Buffer.alloc(BASE_IMAGE_SIZE * BASE_IMAGE_SIZE * channels);
  for (let y = 0; y < BASE_IMAGE_SIZE; y++) {
    for (let x = 0; x < BASE_IMAGE_SIZE; x++) {
      const light = (Math.floor(x / square) + Math.floor(y / square)) % 2 === 0;
      const value = light ? 200 : 120;
      const offset = (y * BASE_IMAGE_SIZE + x) * channels;
      raw[offset] = value;
      raw[offset + 1] = value;
      raw[offset + 2] = value;
    }
  }
  const png = await sharp(raw, {
    raw: { width: BASE_IMAGE_SIZE, height: BASE_IMAGE_SIZE, channels },
  })
    .png()
    .toBuffer();
  writeAtomically(absolutePath, png);
  return absolutePath;
}

/** Stub generation backend: a solid tile whose color derives from the job key
 * (deterministic) at a size the region does NOT match (forces the resize). */
async function stubGenerateTile(jobKey: string): Promise<Buffer> {
  const digest = createHash('sha256').update(jobKey).digest();
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
}

/** White-center mask whose blurred border feathers the composite edge. */
async function featherMask(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .extend({
      top: FEATHER_PX,
      bottom: FEATHER_PX,
      left: FEATHER_PX,
      right: FEATHER_PX,
      background: { r: 0, g: 0, b: 0 },
    })
    .blur(FEATHER_PX / 2)
    .resize(width, height, { fit: 'fill' })
    .toColourspace('b-w')
    .raw()
    .toBuffer();
}

/**
 * crop → (stub) generate → feather → resize → composite → temp+rename.
 * The crop is extracted exactly as the real mask-capable backend would
 * receive it (Brief §3) — the stub only proves the mechanics.
 */
export async function compositeRegion(spec: PaintSpec): Promise<PaintResult> {
  const { region, jobKey } = spec;

  // The crop the generation backend would receive; the stub ignores its pixels
  // but extracting it pins the region-read path (out-of-bounds throws here).
  await sharp(spec.basePath)
    .extract({
      left: region.x,
      top: region.y,
      width: region.width,
      height: region.height,
    })
    .toBuffer();

  const tile = await stubGenerateTile(jobKey);
  const mask = await featherMask(region.width, region.height);
  const feathered = await sharp(tile)
    .resize(region.width, region.height, { fit: 'fill' })
    .removeAlpha()
    .joinChannel(mask, {
      raw: { width: region.width, height: region.height, channels: 1 },
    })
    .png()
    .toBuffer();

  // removeAlpha keeps the output RGB like the base — chained composites see a
  // constant channel layout no matter how many regions have been painted.
  const composited = await sharp(spec.basePath)
    .composite([{ input: feathered, left: region.x, top: region.y }])
    .removeAlpha()
    .png()
    .toBuffer();

  const relativePath = join(
    safeName(spec.imageId),
    `${sha256Of(Buffer.from(jobKey)).slice(0, 12)}.png`,
  );
  writeAtomically(join(spec.imagesDir, relativePath), composited);
  return {
    path: relativePath.replaceAll('\\', '/'),
    sha256: sha256Of(composited),
  };
}
