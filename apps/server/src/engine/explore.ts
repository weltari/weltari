// The explore command seam (UI Spec §1.8): durable intent before work — the
// command only writes ONE materialize ledger row; the LLM stub and the
// sublocation.materialized reveal are the job handler's business. Idempotent
// per square (the ledger key IS the square), so double clicks and client
// retries are silent no-ops that still 202.
import type { ExploreCommand } from '@weltari/protocol';
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { Storage } from '../storage/db.js';
import { sublocationAt, worldExists } from './sublocations.js';

export interface ExploreCommandOptions {
  storage: Storage;
  /** Wakes the ledger runner so the spinner window starts immediately. */
  kick?: () => void;
}

export function createExploreCommand(
  options: ExploreCommandOptions,
): (command: ExploreCommand) => Result<{ jobKey: string }> {
  const { storage, kick } = options;
  return (command: ExploreCommand): Result<{ jobKey: string }> => {
    if (!worldExists(storage, command.world_id)) {
      return err(
        new OperationalError(
          'world_not_found',
          `no events exist for world ${command.world_id}`,
        ),
      );
    }
    const occupant = sublocationAt(storage, command.world_id, command.square);
    if (occupant !== undefined) {
      return err(
        new OperationalError(
          'square_occupied',
          `square is already ${occupant.sublocation_id}`,
        ),
      );
    }
    const { col, row } = command.square;
    const jobKey = `materialize:${command.world_id}:${String(col)}:${String(row)}`;
    storage.ledger.enqueue({
      idempotency_key: jobKey,
      world_id: command.world_id,
      type: 'materialize',
      payload: { square: command.square },
    });
    // A duplicate square is a silent no-op (I3) — still a 202: the job exists.
    kick?.();
    return ok({ jobKey });
  };
}
