// The manual wiki edit seam (M6 part 5, owner ruling 2026-07-11: user edits
// apply IMMEDIATELY — the Proposal pipeline is deferred). One durable
// subwiki.edited with USER actor provenance per flush; the wiki view folds
// subwiki.updated AND subwiki.edited latest-wins, so a later World Agent
// pass may supersede the text but never silently — every write stays in the
// append-only log with its author.
import type { SubwikiEditCommand } from '@weltari/protocol';
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { Storage } from '../storage/db.js';
import type { EventSink } from './event-sink.js';
import { knownSublocations } from './sublocations.js';

export interface SubwikiEditOptions {
  storage: Storage;
  sink: EventSink;
}

export function createSubwikiEditCommand(
  options: SubwikiEditOptions,
): (command: SubwikiEditCommand) => Result<{ sublocationId: string }> {
  const { storage, sink } = options;
  return (command): Result<{ sublocationId: string }> => {
    // The target must be a known sublocation — registry-gated like every
    // sublocation-addressed command (stubs included: the wiki page lists
    // whatever the World Agent has written about, which are stubs too).
    const known = knownSublocations(storage, command.world_id).some(
      (s) => s.sublocation_id === command.sublocation_id,
    );
    // Narrator stubs materialize into the registry, but a subwiki entry can
    // also exist for an interior stub — accept any sublocation the SUBWIKI
    // already knows, even if the registry does not list it.
    const hasEntry = storage.eventLog
      .readSince(0, 100000)
      .some(
        (e) =>
          (e.type === 'subwiki.updated' || e.type === 'subwiki.edited') &&
          e.world_id === command.world_id &&
          e.payload.sublocation_id === command.sublocation_id,
      );
    if (!known && !hasEntry) {
      return err(
        new OperationalError('unknown_sublocation', 'no such sublocation'),
      );
    }
    sink.append({
      world_id: command.world_id,
      actor_id: command.actor_id,
      type: 'subwiki.edited',
      payload: {
        sublocation_id: command.sublocation_id,
        entry: command.entry,
      },
    });
    return ok({ sublocationId: command.sublocation_id });
  };
}
