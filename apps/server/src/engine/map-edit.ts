// The map-edit command seam (Rev 4 §14 Flow A, M5 part 2): durable intent
// before work — append map_edit.requested (the client's lock-overlay anchor)
// and enqueue ONE map_edit ledger job; the GM form, both B6 gates, the
// sublocation row and the painter edit are the job handler's business.
// Idempotent per request_id (the ledger key IS the edit id), so double
// submits and client retries are silent no-ops that still 202.
import type { MapEditCommand } from '@weltari/protocol';
import { err, ok, OperationalError, type Result } from '../errors.js';
import { editGeometry } from '../painter/commands.js';
import type { Storage } from '../storage/db.js';
import type { EventSink } from './event-sink.js';
import { squareOf, sublocationAt, worldExists } from './sublocations.js';

export interface MapEditCommandOptions {
  storage: Storage;
  sink: EventSink;
  /** Wakes the ledger runner so the lock window starts immediately. */
  kick?: () => void;
}

export function createMapEditCommand(
  options: MapEditCommandOptions,
): (command: MapEditCommand) => Result<{ jobKey: string; editId: string }> {
  const { storage, sink, kick } = options;
  return (
    command: MapEditCommand,
  ): Result<{ jobKey: string; editId: string }> => {
    if (!worldExists(storage, command.world_id)) {
      return err(
        new OperationalError(
          'world_not_found',
          `no events exist for world ${command.world_id}`,
        ),
      );
    }
    // Edits land on explored ground (week-8 criteria): the centroid's fog
    // square must already hold its reveal sublocation. Fog only ever recedes
    // (append-only log), so this boundary check cannot go stale.
    const { centroid } = editGeometry(command.points);
    if (
      sublocationAt(storage, command.world_id, squareOf(centroid)) === undefined
    ) {
      return err(
        new OperationalError(
          'unexplored_ground',
          'the drawn region centers on unexplored fog — explore the square first',
        ),
      );
    }
    const editId = command.request_id;
    const jobKey = `map_edit:${command.world_id}:${editId}`;
    // Idempotent re-submit: the intent event exists — do not append a twin.
    // Single process, no await between check and append (race-free).
    const alreadyRequested = storage.eventLog
      .readSince(0, 100000)
      .some(
        (e) =>
          e.type === 'map_edit.requested' &&
          e.world_id === command.world_id &&
          e.payload.edit_id === editId,
      );
    if (!alreadyRequested) {
      sink.append({
        world_id: command.world_id,
        actor_id: command.actor_id,
        type: 'map_edit.requested',
        payload: {
          edit_id: editId,
          points: command.points,
          intent: command.intent,
        },
      });
    }
    storage.ledger.enqueue({
      idempotency_key: jobKey,
      world_id: command.world_id,
      type: 'map_edit',
      payload: {
        edit_id: editId,
        points: command.points,
        intent: command.intent,
        requested_by: command.actor_id,
      },
    });
    // A duplicate request_id is a silent no-op (I3) — still a 202: the job exists.
    kick?.();
    return ok({ jobKey, editId });
  };
}
