// paint-region command seam: durable intent before work (Brief §2.4) — the
// command only writes the ledger row; every pixel is the job handler's
// business. Image lease = serial_group per IMAGE: painter jobs CHAIN — each
// composites onto the latest completed composite for its image — so two
// paints for one image must never run concurrently, same region or not.
// (M2 shipped per-region granularity; week-7's first real-backend run proved
// that loses tiles: three ~10 s generations claimed together, all read the
// same base, last writer won. Invisible on the ~5 ms stub.)
import {
  MAP_FOG_GRID,
  type ImageRegion,
  type MapSquare,
  type PaintRegionCommand,
} from '@weltari/protocol';
import { ok, type Result } from '../errors.js';
import type { Storage } from '../storage/db.js';
import { BASE_IMAGE_SIZE } from './painter.js';

export function createPaintRegionCommand(
  storage: Storage,
): (command: PaintRegionCommand) => Result<{ jobKey: string }> {
  return (command: PaintRegionCommand): Result<{ jobKey: string }> => {
    const jobKey = `painter:${command.image_id}:${command.request_id}`;
    storage.ledger.enqueue({
      idempotency_key: jobKey,
      world_id: command.world_id,
      type: 'painter',
      payload: { image_id: command.image_id, region: command.region },
      serial_group: `painter:${command.image_id}`,
    });
    // A duplicate request_id is a silent no-op (I3) — still a 202: the job exists.
    return ok({ jobKey });
  };
}

/** The pixel rect of one fog square on the world-map base (painter-owned
 * geometry: code places, the model only fills — Rev 4 §14). */
export function squareRegion(square: MapSquare): ImageRegion {
  const px = BASE_IMAGE_SIZE / MAP_FOG_GRID;
  return {
    x: square.col * px,
    y: square.row * px,
    width: px,
    height: px,
  };
}

/**
 * Eagerly enqueue THE paint job for one fog square of a world's map (M5:
 * materialization = the map-presence job). Deterministic key per square, so
 * the materialize handler's post-kill retry, the fixture-trio boot enqueue
 * and any future caller converge on one job — the ledger dedupes forever.
 */
export function enqueueSquarePaint(
  storage: Storage,
  worldId: string,
  square: MapSquare,
): void {
  const imageId = `map:${worldId}`;
  const region = squareRegion(square);
  storage.ledger.enqueue({
    idempotency_key: `painter:${imageId}:sq-${String(square.col)}-${String(square.row)}`,
    world_id: worldId,
    type: 'painter',
    payload: { image_id: imageId, region },
    serial_group: `painter:${imageId}`,
  });
}
