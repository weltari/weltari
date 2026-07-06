// The painter job handler (Milestone 2 step 3). Idempotent per job_key: the
// committed painter.completed event gates the retry after a kill -9 — the
// deterministic pipeline regenerates the same bytes, so the nastiest window
// (file renamed, event not yet appended) heals itself on replay.
import { join } from 'node:path';
import { z } from 'zod';
import { CorruptStateError } from '../../errors.js';
import type { EventSink } from '../../engine/event-sink.js';
import type { FaultPointHook } from '../../engine/fault-points.js';
import type { Logger } from '../../observability/logger.js';
import { compositeRegion, ensureBaseImage } from '../../painter/painter.js';
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

export interface PainterHandlerOptions {
  storage: Storage;
  sink: EventSink;
  imagesDir: string;
  logger: Logger;
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
