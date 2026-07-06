// paint-region command seam: durable intent before work (Brief §2.4) — the
// command only writes the ledger row; every pixel is the job handler's
// business. Region lease = serial_group per (image, region): two jobs for the
// same region can never run concurrently (FINAL item 10).
import type { PaintRegionCommand } from '@weltari/protocol';
import { ok, type Result } from '../errors.js';
import type { Storage } from '../storage/db.js';

export function regionKey(region: {
  x: number;
  y: number;
  width: number;
  height: number;
}): string {
  return `${String(region.x)}-${String(region.y)}-${String(region.width)}-${String(region.height)}`;
}

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
      serial_group: `painter:${command.image_id}:${regionKey(command.region)}`,
    });
    // A duplicate request_id is a silent no-op (I3) — still a 202: the job exists.
    return ok({ jobKey });
  };
}
