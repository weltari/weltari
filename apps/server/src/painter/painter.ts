// The painter pipeline — the ONLY sharp site (A11 fence). M2 proved the
// crash-safety mechanics; M5 part 1 makes the pixels real behind the
// ImageSource seam (image-source.ts) — the mechanics here never change.
//
// Kill-safety shape (composite-on-success): every output is a NEW file written
// as temp-file + atomic rename; the painter.completed EVENT — not the file —
// is the truth about which image is current (Brief §2.1). A kill before the
// rename leaves only a temp file; a kill between rename and event append
// leaves an orphan file the idempotent retry regenerates (byte-identically on
// the stub source; a real backend regenerates different-but-valid pixels and
// the retry's event names the retry's file — the event is the truth).
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
import {
  createStubImageSource,
  type ImageSource,
  type TileContext,
} from './image-source.js';

export const BASE_IMAGE_SIZE = 512;
const FEATHER_PX = 8;

/** A polygon vertex in image-pixel coordinates (same space as ImageRegion). */
export interface MaskPoint {
  x: number;
  y: number;
}

export interface PaintSpec {
  imageId: string;
  region: ImageRegion;
  /** Ledger idempotency key — seeds the deterministic stub tile. */
  jobKey: string;
  imagesDir: string;
  /** Absolute path of the image to composite onto. */
  basePath: string;
  /** Where the tile pixels come from. ABSENT = the deterministic stub —
   * tests, the kill harness and CI stay free and offline by default. */
  source?: ImageSource;
  /** World flavor for a real backend (sublocation stub + neighbors). */
  prompt?: string;
  /**
   * Flow A (Rev 4 §14): the user-drawn polygon, image-pixel coordinates.
   * Present = composite back ONLY the masked interior (feathered) — pixels
   * inside the region but outside the polygon stay the base's, whatever the
   * model painted there. Absent = the whole region composites (fog reveals).
   */
  mask?: readonly MaskPoint[];
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

/**
 * Polygon alpha mask (Flow A): white interior on black, blurred so the
 * composite edge feathers across the drawn boundary — the composite-back of
 * ONLY the masked interior is the preservation guarantee (Rev 4 §14 step 5),
 * never the model. Vertices arrive in image pixels; rendered region-relative.
 */
async function polygonMask(
  region: ImageRegion,
  points: readonly MaskPoint[],
): Promise<Buffer> {
  const vertices = points
    .map((p) => `${(p.x - region.x).toFixed(2)},${(p.y - region.y).toFixed(2)}`)
    .join(' ');
  const svg =
    `<svg width="${String(region.width)}" height="${String(region.height)}" ` +
    'xmlns="http://www.w3.org/2000/svg">' +
    '<rect width="100%" height="100%" fill="black"/>' +
    `<polygon points="${vertices}" fill="white"/></svg>`;
  return sharp(Buffer.from(svg))
    .blur(FEATHER_PX / 2)
    .resize(region.width, region.height, { fit: 'fill' })
    .toColourspace('b-w')
    .raw()
    .toBuffer();
}

/** White-center mask whose blurred border feathers the composite edge.
 * Two sharp passes: inside ONE pipeline sharp orders resize BEFORE extend,
 * so the single-pass version silently returned (width+16)×(height+16) —
 * unnoticed while the joinChannel bug (see compositeRegion) dropped the mask
 * entirely; found by the week-8 polygon-mask test. */
async function featherMask(width: number, height: number): Promise<Buffer> {
  const bordered = await sharp({
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
    .png()
    .toBuffer();
  return sharp(bordered)
    .resize(width, height, { fit: 'fill' })
    .toColourspace('b-w')
    .raw()
    .toBuffer();
}

/**
 * Read-only PNG crop of a region (Flow B: the VLM's view of the clicked
 * surroundings). Lives here because sharp is fenced to painter/ (A11);
 * no compositing, no writes.
 */
export async function cropRegionPng(
  basePath: string,
  region: ImageRegion,
): Promise<Buffer> {
  return sharp(basePath)
    .extract({
      left: region.x,
      top: region.y,
      width: region.width,
      height: region.height,
    })
    .png()
    .toBuffer();
}

/**
 * crop → generate (ImageSource) → feather → resize → composite → temp+rename.
 * The crop is extracted exactly as a mask-capable backend would receive it
 * (Brief §3) — V1 backends paint from the prompt alone.
 */
export async function compositeRegion(spec: PaintSpec): Promise<PaintResult> {
  const { region, jobKey } = spec;
  const source = spec.source ?? createStubImageSource();

  // Region validation: extracting the bare region pins the region-read path
  // (out-of-bounds throws here, before any provider spend).
  await sharp(spec.basePath)
    .extract({
      left: region.x,
      top: region.y,
      width: region.width,
      height: region.height,
    })
    .toBuffer();

  // The context window (week-7 coherence fix): the region plus one
  // region-size margin of CURRENT pixels on each side, clamped to the
  // canvas. An editing backend continues roads/rivers/style from these
  // painted neighbors instead of painting blind; the stub ignores it.
  const meta = await sharp(spec.basePath).metadata();
  const baseWidth = meta.width;
  const baseHeight = meta.height;
  const wx = Math.max(0, region.x - region.width);
  const wy = Math.max(0, region.y - region.height);
  const windowWidth = Math.min(baseWidth, region.x + 2 * region.width) - wx;
  const windowHeight = Math.min(baseHeight, region.y + 2 * region.height) - wy;
  const windowRaw = await sharp(spec.basePath)
    .extract({ left: wx, top: wy, width: windowWidth, height: windowHeight })
    .removeAlpha()
    .raw()
    .toBuffer();
  // The fog checkerboard (and the feather greys) are pure grey; painted
  // terrain has chroma. An all-grey window means NO painted neighbor exists
  // to continue from — edit mode would anchor on nothing and drift (seen
  // live: the seeding tile came out as a zoomed-in courtyard and every later
  // tile faithfully continued the drift). Fall back to plain generation; the
  // style bible carries isolated tiles.
  let hasPaintedNeighbor = false;
  for (let offset = 0; offset < windowRaw.length; offset += 3) {
    const r = windowRaw[offset] ?? 0;
    const g = windowRaw[offset + 1] ?? 0;
    const b = windowRaw[offset + 2] ?? 0;
    if (Math.abs(r - g) > 8 || Math.abs(g - b) > 8 || Math.abs(r - b) > 8) {
      hasPaintedNeighbor = true;
      break;
    }
  }
  const context: TileContext | undefined = hasPaintedNeighbor
    ? {
        window: await sharp(windowRaw, {
          raw: { width: windowWidth, height: windowHeight, channels: 3 },
        })
          .png()
          .toBuffer(),
        target: {
          x: region.x - wx,
          y: region.y - wy,
          width: region.width,
          height: region.height,
        },
        width: windowWidth,
        height: windowHeight,
      }
    : undefined;

  const generated = await source.generateTile({
    jobKey,
    region,
    prompt: spec.prompt ?? '',
    ...(context === undefined ? {} : { context }),
  });

  // Edit-mode backends repaint the WHOLE window; only the target rect enters
  // the composite — composite-back stays the sole preservation guarantee.
  // Window coverage without a supplied window is a source contract bug.
  if (generated.coverage === 'window' && context === undefined) {
    throw new Error(
      `image source '${source.name}' returned window coverage without a context window`,
    );
  }
  const tile =
    generated.coverage === 'window' && context !== undefined
      ? await sharp(generated.image)
          .resize(windowWidth, windowHeight, { fit: 'fill' })
          .extract({
            left: context.target.x,
            top: context.target.y,
            width: context.target.width,
            height: context.target.height,
          })
          .png()
          .toBuffer()
      : generated.image;
  const mask =
    spec.mask === undefined
      ? await featherMask(region.width, region.height)
      : await polygonMask(region, spec.mask);
  // Two sharp passes on purpose: sharp orders removeAlpha AFTER joinChannel
  // inside one pipeline regardless of call order, silently stripping the
  // just-joined mask (found by the week-8 polygon-mask test — the M2 feather
  // never actually applied). Materialize plain RGB first, then join.
  const tileRgb = await sharp(tile)
    .resize(region.width, region.height, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();
  const feathered = await sharp(tileRgb, {
    raw: { width: region.width, height: region.height, channels: 3 },
  })
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

  // Content-addressed output (week-7 fix): the filename is the BYTES' hash,
  // never the job key. Two executions of one job racing on a lease-expiry
  // reclaim (real generations are slow) then write DIFFERENT files — the
  // event that commits always names a file matching its sha256; the loser's
  // file is an unreferenced orphan, never a corruption. The deterministic
  // stub still reruns byte-identically: same bytes => same name => no-op.
  const digest = sha256Of(composited);
  const relativePath = join(
    safeName(spec.imageId),
    `${digest.slice(0, 12)}.png`,
  );
  writeAtomically(join(spec.imagesDir, relativePath), composited);
  return {
    path: relativePath.replaceAll('\\', '/'),
    sha256: digest,
  };
}
