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
  const style =
    'A single terrain tile of a hand-painted top-down fantasy world map, ' +
    'muted earthy colors, soft painterly texture, viewed straight from above. ' +
    'No text, no labels, no borders, no grid lines, no UI elements.';
  const aligned =
    imageId === `map:${worldId}` &&
    region.width === SQUARE_PX &&
    region.height === SQUARE_PX &&
    region.x % SQUARE_PX === 0 &&
    region.y % SQUARE_PX === 0;
  if (!aligned) return `${style} Uncharted wilderness at the map frontier.`;
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
  return `${style} This tile shows: ${here.name} — ${here.description}${neighborLine}`;
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
    const { image_id, region } = payload.data;

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

    const result = await compositeRegion({
      imageId: image_id,
      region,
      jobKey: job.idempotency_key,
      imagesDir,
      basePath,
      ...(options.imageSource === undefined
        ? {}
        : { source: options.imageSource }),
      prompt: tilePromptFor(storage, job.world_id, image_id, region),
    });

    // The nastiest kill window: the composited file exists, the event does not.
    await faultPoint('mid_painter');
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
