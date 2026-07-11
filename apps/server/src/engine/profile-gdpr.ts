// The user's ownership surface over the GM's profiling store (M7 part 2,
// Rev 4 §9 guardrails): fully viewable, exportable, deletable. View/export
// read the side store directly (the entries never ride the event stream);
// delete physically removes rows and appends profile.deleted in the SAME
// transaction — and because the store is not a log projection, no replay
// can resurrect what was erased.
import type { DeleteProfileCommand, UserProfileView } from '@weltari/protocol';
import type { WeltariEvent } from '@weltari/protocol';
import { ok, type Result } from '../errors.js';
import type { EventBus } from '../http/bus.js';
import type { Storage } from '../storage/db.js';
import { flagOf } from './config-flags.js';

/** The GET /v1/profile (+ /export) body. */
export function profileView(
  storage: Storage,
  worldId: string,
  actorId: string,
): UserProfileView {
  return {
    actor_id: actorId,
    profiling_enabled: flagOf(storage, worldId, 'profiling_enabled'),
    entries: storage.userProfile.list(actorId).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      body: entry.body,
      context_id: entry.context_id,
      created_at: entry.created_at,
    })),
  };
}

export interface DeleteProfileOptions {
  storage: Storage;
  eventBus: EventBus;
}

export function createDeleteProfileCommand(
  options: DeleteProfileOptions,
): (command: DeleteProfileCommand) => Result<{ removed: number }> {
  const { storage, eventBus } = options;
  return (command): Result<{ removed: number }> => {
    let removed = 0;
    let deleted: WeltariEvent | undefined;
    storage.transact(() => {
      removed = storage.userProfile.deleteAll(command.actor_id);
      // An empty profile deletes silently (removed 0) WITHOUT an event —
      // nothing happened, nothing to audit.
      if (removed > 0) {
        deleted = storage.eventLog.append({
          world_id: command.world_id,
          actor_id: command.actor_id,
          type: 'profile.deleted',
          payload: { user_actor_id: command.actor_id, removed },
        });
      }
    });
    if (deleted !== undefined) eventBus.publish(deleted);
    return ok({ removed });
  };
}
