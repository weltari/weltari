// The map-click command seam (Rev 4 §14 Flow B, M5 part 2). Step 1 — the
// radius check — answers HERE, synchronously: a click inside a known
// footprint or radius enters that existing sublocation with ZERO model calls
// and ZERO rows. Only a click outside all radii enqueues the map_click job
// (VLM classify → story LLM → persist-or-discard); idempotent per request_id.
import type { MapClickCommand } from '@weltari/protocol';
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { Storage } from '../storage/db.js';
import {
  squareOf,
  sublocationAt,
  sublocationNear,
  worldExists,
} from './sublocations.js';

export type MapClickOutcome =
  | { outcome: 'enter'; clickId: string; sublocationId: string; name: string }
  | { outcome: 'classify'; clickId: string; jobKey: string };

export interface MapClickCommandOptions {
  storage: Storage;
  /** Wakes the ledger runner so the classify window starts immediately. */
  kick?: () => void;
}

export function createMapClickCommand(
  options: MapClickCommandOptions,
): (command: MapClickCommand) => Result<MapClickOutcome> {
  const { storage, kick } = options;
  return (command: MapClickCommand): Result<MapClickOutcome> => {
    if (!worldExists(storage, command.world_id)) {
      return err(
        new OperationalError(
          'world_not_found',
          `no events exist for world ${command.world_id}`,
        ),
      );
    }
    // Fog clicks are Explore's business (UI Spec §1.8) — Flow B reads only
    // ground the painter has already revealed.
    if (
      sublocationAt(storage, command.world_id, squareOf(command.point)) ===
      undefined
    ) {
      return err(
        new OperationalError(
          'unexplored_ground',
          'the click landed on unexplored fog — explore the square first',
        ),
      );
    }
    const clickId = command.request_id;
    const near = sublocationNear(storage, command.world_id, command.point);
    if (near !== undefined) {
      // Inside a known radius/footprint: enter it. Nothing enqueued, nothing
      // appended — the client jumps via its normal open-scene path.
      return ok({
        outcome: 'enter',
        clickId,
        sublocationId: near.sublocation_id,
        name: near.name,
      });
    }
    const jobKey = `map_click:${command.world_id}:${clickId}`;
    storage.ledger.enqueue({
      idempotency_key: jobKey,
      world_id: command.world_id,
      type: 'map_click',
      payload: {
        click_id: clickId,
        point: command.point,
        requested_by: command.actor_id,
      },
    });
    // A duplicate request_id is a silent no-op (I3) — still a 202: the job exists.
    kick?.();
    return ok({ outcome: 'classify', clickId, jobKey });
  };
}
