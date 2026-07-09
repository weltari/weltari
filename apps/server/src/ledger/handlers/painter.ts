// The painter job handler (Milestone 2 step 3). Idempotent per job_key: the
// committed painter.completed event gates the retry after a kill -9 — the
// deterministic pipeline regenerates the same bytes, so the nastiest window
// (file renamed, event not yet appended) heals itself on replay.
import { join } from 'node:path';
import { MAP_FOG_GRID, type ImageRegion } from '@weltari/protocol';
import { z } from 'zod';
import { CorruptStateError } from '../../errors.js';
import type { EventSink } from '../../engine/event-sink.js';
import type { FaultPointHook } from '../../engine/fault-points.js';
import {
  knownSublocations,
  squareOf,
  sublocationAt,
} from '../../engine/sublocations.js';
import type { Logger } from '../../observability/logger.js';
import type { ImageSource } from '../../painter/image-source.js';
import {
  BASE_IMAGE_SIZE,
  compositeRegion,
  ensureBaseImage,
} from '../../painter/painter.js';
import type { Storage } from '../../storage/db.js';
import type { JobHandler } from '../runner.js';

const payloadSchema = z.strictObject({
  image_id: z.string().min(1),
  region: z.strictObject({
    x: z.int().nonnegative(),
    y: z.int().nonnegative(),
    width: z.int().positive(),
    height: z.int().positive(),
  }),
  /** Flow A (M5 part 2): the drawn polygon, image pixels — composite-back
   * touches only its interior (painter.ts). Absent = whole-region reveal. */
  mask: z
    .array(
      z.strictObject({
        x: z.number().nonnegative(),
        y: z.number().nonnegative(),
      }),
    )
    .min(3)
    .max(128)
    .optional(),
});

const SQUARE_PX = BASE_IMAGE_SIZE / MAP_FOG_GRID;

/**
 * World flavor for the generation backend (Rev 4 §14: prompt = the stub's
 * name + description + neighboring squares' names). Derived from the DB at
 * paint time — the database, not the job payload, is the source of truth.
 * Regions that don't map to a fog square (or worlds without a stub there)
 * get a generic frontier prompt; the stub source ignores all of it.
 */
export function tilePromptFor(
  storage: Storage,
  worldId: string,
  imageId: string,
  region: ImageRegion,
): string {
  // The style bible, v4 (week-7 visual QA, docs/week7-results.md): ONE
  // shared block pins camera, palette, light direction, building scale and
  // edge discipline for EVERY tile of a map — cross-tile style coherence is
  // this text; cross-tile geometric coherence is the context window the
  // compositor sends alongside (image-source.ts edit mode). History: v1
  // produced interior floor plans, side views and vignettes; v2 pinned the
  // camera and depiction level; v3 added intact roofs; v4 adds the fixed
  // light direction, the building-size cap (largest ≤ ¼ tile — readable at
  // the 64 px map scale without dominating) and keep-off-the-edges (only
  // linear features may exit, so they CAN continue into neighbors).
  const style =
    'A square terrain tile of one continuous hand-painted fantasy world ' +
    'map, seen directly from above like a painted aerial survey ' +
    '(orthographic bird’s-eye view, no horizon, no side angle). Every tile ' +
    'of this map shares ONE style: soft painterly texture; muted earthy ' +
    'palette of moss green, ochre, slate grey and cool river blue; soft ' +
    'daylight from the north-west, shadows falling gently to the ' +
    'south-east. Terrain fills the entire canvas edge-to-edge: no border, ' +
    'no frame, no vignette, no parchment margin, no text, no labels, no ' +
    'grid, no UI. Buildings appear as intact rooftops in the landscape — ' +
    'never interior floor plans, never cutaways, no flames or glowing ' +
    'openings. The tile covers roughly 100×100 meters: at most one to ' +
    'three buildings, the largest at most a quarter of the tile across, ' +
    'placed clearly inside the tile away from its edges — only roads, ' +
    'rivers, fields and forests may run off the edges and continue beyond.';
  const aligned =
    imageId === `map:${worldId}` &&
    region.width === SQUARE_PX &&
    region.height === SQUARE_PX &&
    region.x % SQUARE_PX === 0 &&
    region.y % SQUARE_PX === 0;
  if (!aligned) {
    // Flow-A edit regions are not grid-aligned: the DB is still the source
    // of truth at paint time — the created sublocation whose pin (mask
    // centroid) falls inside the region supplies the flavor.
    if (imageId !== `map:${worldId}`) {
      return `${style} Uncharted wilderness at the map frontier.`;
    }
    const here = knownSublocations(storage, worldId).find((s) => {
      if (s.footprint === undefined || s.map_position === undefined)
        return false;
      const px = s.map_position.x * BASE_IMAGE_SIZE;
      const py = s.map_position.y * BASE_IMAGE_SIZE;
      return (
        px >= region.x &&
        px < region.x + region.width &&
        py >= region.y &&
        py < region.y + region.height
      );
    });
    if (here?.map_position === undefined) {
      return `${style} Uncharted wilderness at the map frontier.`;
    }
    const at = squareOf(here.map_position);
    const near = knownSublocations(storage, worldId)
      .filter((s) => {
        if (s.sublocation_id === here.sublocation_id) return false;
        if (s.map_position === undefined) return false;
        const sq = squareOf(s.map_position);
        return Math.abs(sq.col - at.col) <= 1 && Math.abs(sq.row - at.row) <= 1;
      })
      .map((s) => s.name);
    const nearLine =
      near.length === 0
        ? ''
        : ` It sits among these areas of the same map: ${near.join(', ')} — blend naturally toward them at the edges.`;
    return `${style} Within the area, add: ${here.name} — ${here.description}${nearLine}`;
  }
  const square = {
    col: region.x / SQUARE_PX,
    row: region.y / SQUARE_PX,
  };
  const here = sublocationAt(storage, worldId, square);
  if (here === undefined) {
    return `${style} Uncharted wilderness at the map frontier.`;
  }
  const neighbors = knownSublocations(storage, worldId)
    .filter((s) => {
      if (s.sublocation_id === here.sublocation_id) return false;
      if (s.map_position === undefined) return false;
      const at = squareOf(s.map_position);
      return (
        Math.abs(at.col - square.col) <= 1 && Math.abs(at.row - square.row) <= 1
      );
    })
    .map((s) => s.name);
  const neighborLine =
    neighbors.length === 0
      ? ''
      : ` It borders these areas of the same map: ${neighbors.join(', ')} — blend naturally toward them at the edges.`;
  return `${style} The area being revealed contains: ${here.name} — ${here.description}${neighborLine}`;
}

/**
 * The backdrop prompt (M6 part 1, Rev 4 §6: one sublocation = one backdrop
 * image). Derived from the DB at paint time like every tile prompt — the
 * created stub (or any registry entry) supplies the flavor; an interior also
 * names its exterior-atomic parent for coherence. The style block is the
 * backdrop counterpart of the map's style bible: eye-level VN stage, no
 * people, no text — the week-7/8 iterate-by-looking loop starts from v1 here.
 */
export function backdropPromptFor(
  storage: Storage,
  worldId: string,
  imageId: string,
): string {
  // Style bible v2 (week-9 visual QA, docs/week9-results.md): v1's "calm,
  // uncluttered lower third" came back as a literally EMPTY band of raw
  // canvas, and the parent's description leaked its furniture into the
  // child's room — every line below exists because of a looked-at defect.
  const style =
    'A visual-novel background illustration seen from eye level, as if ' +
    'standing inside the scene: hand-painted, soft ambient light, muted ' +
    'earthy palette of moss green, ochre, slate grey and warm lamplight — ' +
    'the same rainy storybook world as its map. An empty stage awaiting its ' +
    'actors: no people, no characters, no animals, no text, no labels, no ' +
    'UI. Paint EVERY pixel of the square canvas edge-to-edge — no frame, no ' +
    'border, no margin, no blank band, no transparency checkerboard. The ' +
    'lower third of the scene stays visually simple (open floor, ground or ' +
    'water, fully painted) so dialogue panels can sit over it.';
  const sublocationId = imageId.slice('backdrop:'.length);
  const known = knownSublocations(storage, worldId);
  const here = known.find((s) => s.sublocation_id === sublocationId);
  if (here === undefined) {
    return `${style} A quiet, half-lit interior whose story has not begun.`;
  }
  const parent =
    here.parent_id === undefined
      ? undefined
      : known.find((s) => s.sublocation_id === here.parent_id);
  // Name the parent for world coherence but WITHOUT its description — v1
  // pulled the parent's furniture into the child's room.
  const parentLine =
    parent === undefined
      ? ''
      : ` It belongs to ${parent.name}, but paint ONLY the inside of ${here.name} itself.`;
  return `${style} The place: ${here.name} — ${here.description}${parentLine}`;
}

export interface PainterHandlerOptions {
  storage: Storage;
  sink: EventSink;
  imagesDir: string;
  logger: Logger;
  /** ABSENT = the deterministic stub (painter/image-source.ts). */
  imageSource?: ImageSource;
  faultPoint?: FaultPointHook;
}

export function createPainterHandler(
  options: PainterHandlerOptions,
): JobHandler {
  const { storage, sink, imagesDir, logger } = options;
  const faultPoint = options.faultPoint ?? ((): void => undefined);

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new CorruptStateError(
        'painter_payload',
        `job ${String(job.id)} payload does not match {image_id, region}`,
      );
    }
    const { image_id, region, mask } = payload.data;

    // The event log is the truth about the current image: latest completed
    // composite wins; a fresh image gets the deterministic fixture base.
    let currentPath: string | null = null;
    let already = false;
    for (const event of storage.eventLog.readSince(0, 100000)) {
      if (
        event.type === 'painter.completed' &&
        event.payload.image_id === image_id
      ) {
        currentPath = event.payload.path;
        if (event.payload.job_key === job.idempotency_key) already = true;
      }
    }
    if (already) {
      logger.debug(
        { job_id: job.id, image_id },
        'painter job already committed — idempotent no-op',
      );
      return;
    }

    const basePath =
      currentPath === null
        ? await ensureBaseImage(imagesDir, image_id)
        : join(imagesDir, currentPath);

    const isBackdrop = image_id.startsWith('backdrop:');
    const result = await compositeRegion({
      imageId: image_id,
      region,
      jobKey: job.idempotency_key,
      imagesDir,
      basePath,
      ...(options.imageSource === undefined
        ? {}
        : { source: options.imageSource }),
      ...(mask === undefined ? {} : { mask }),
      ...(isBackdrop ? { kind: 'backdrop' as const } : {}),
      prompt: isBackdrop
        ? backdropPromptFor(storage, job.world_id, image_id)
        : tilePromptFor(storage, job.world_id, image_id, region),
    });

    // The nastiest kill window: the composited file exists, the event does not.
    await faultPoint('mid_painter');
    // Last-instant idempotency re-check, with NO await between it and the
    // append (week-7 fix): a slow real generation can outlive its lease, the
    // sweep reclaims the "dead" job, and a second execution runs while this
    // one still awaits the provider. Executions interleave only at await
    // points in this single-process runtime, so check+append back-to-back is
    // race-free — the loser lands here, sees the winner's event, and no-ops
    // (its content-addressed file is an unreferenced orphan, not a lie).
    const committedMeanwhile = storage.eventLog
      .readSince(0, 100000)
      .some(
        (event) =>
          event.type === 'painter.completed' &&
          event.payload.image_id === image_id &&
          event.payload.job_key === job.idempotency_key,
      );
    if (committedMeanwhile) {
      logger.warn(
        { job_id: job.id, image_id, job_key: job.idempotency_key },
        'painter job overlapped its own lease-expiry retry — one duplicate generation, zero duplicate events',
      );
      return;
    }
    sink.append({
      world_id: job.world_id,
      actor_id: 'system:painter',
      type: 'painter.completed',
      payload: {
        image_id,
        region,
        path: result.path,
        sha256: result.sha256,
        job_key: job.idempotency_key,
      },
    });
  };
}
