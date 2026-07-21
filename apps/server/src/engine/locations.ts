// CRON world movement (M7 part 4, Rev 4 §14): V1's "living world" — a
// scheduled code-class occurrence moves a few characters between
// sublocations. Constraints, engine-enforced: the mover SKIPS characters
// currently in an active scene (presence check — their location is the
// scene's business); targets are MATERIALIZED sublocations only (stubs are
// invisible to the map's mechanical loops); events are stamped with the
// occurrence's SCHEDULED fictional time so positions read true on landing
// after a skip; idempotency per occurrence rides the world_cron.completed
// natural key (the handler's re-check gates the whole append). The world
// advances ONLY via CRON events — there is no continuous simulation tick.
//
// Location events are §4.5's sanctioned hot-path exception (like character
// location changes generally): engine-committed through each character's
// mailbox because map, CRON and chat need them fresh.
import type { Storage } from '../storage/db.js';
import type { NewEvent } from '../storage/repositories/event-log.js';
import { presenceOf } from './chat.js';
import { pickIndex } from './outreach.js';
import type { KnownCharacter } from './scene-lifecycle.js';
import { materializedSublocations } from './sublocations.js';

/** Movement events carry the world-cron system actor. */
export const MOVEMENT_ACTOR_ID = 'system:world_cron';

/** How many characters one movement occurrence relocates at most ("a few
 * random characters", Rev 4 §14 governance table). */
export const MOVEMENT_BATCH = 2;

/**
 * Latest known sublocation per character — a pure fold of
 * character.location_changed. A character with no movement history has no
 * entry (their first move carries no `from_sublocation_id`, and the map
 * shows no bubble until the world first moves them).
 */
export function characterLocationsOf(
  storage: Storage,
  worldId: string,
): Map<string, string> {
  const locations = new Map<string, string>();
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.world_id !== worldId) continue;
    if (event.type === 'character.location_changed') {
      locations.set(
        event.payload.character_id,
        event.payload.to_sublocation_id,
      );
    }
  }
  return locations;
}

/**
 * Plan one movement occurrence: up to MOVEMENT_BATCH available characters,
 * each to a materialized sublocation different from where they stand.
 * Deterministic per (world, occurrence) — the same occurrence always moves
 * the same characters to the same places, so a lease-expiry retry that
 * slipped past the completed-event gate could never diverge. PURE planning:
 * returns NewEvents for the handler to append atomically with its
 * world_cron.completed.
 */
export function planMovementEvents(
  storage: Storage,
  roster: readonly KnownCharacter[],
  worldId: string,
  scheduledFor: string,
): NewEvent[] {
  const anchors = materializedSublocations(storage, worldId);
  if (anchors.length === 0) return [];
  const locations = characterLocationsOf(storage, worldId);
  // Presence check: never a character who is in_scene (their invitation
  // reservations ride presence too — a reserved character stays put).
  const available = roster.filter(
    (c) => presenceOf(storage, worldId, c.character_id).state === 'available',
  );
  const events: NewEvent[] = [];
  const moved = new Set<string>();
  for (let i = 0; i < MOVEMENT_BATCH && moved.size < available.length; i++) {
    const candidates = available.filter((c) => !moved.has(c.character_id));
    const character =
      candidates[
        pickIndex(
          `${worldId}:${scheduledFor}:mover:${String(i)}`,
          candidates.length,
        )
      ];
    if (character === undefined) break;
    moved.add(character.character_id);
    const current = locations.get(character.character_id);
    const targets = anchors.filter((s) => s.sublocation_id !== current);
    const target =
      targets[
        pickIndex(
          `${worldId}:${scheduledFor}:target:${character.character_id}`,
          targets.length,
        )
      ];
    if (target === undefined) continue; // one anchor and they stand on it
    events.push({
      world_id: worldId,
      actor_id: MOVEMENT_ACTOR_ID,
      type: 'character.location_changed',
      payload: {
        character_id: character.character_id,
        ...(current === undefined ? {} : { from_sublocation_id: current }),
        to_sublocation_id: target.sublocation_id,
        game_time: scheduledFor,
      },
    });
  }
  return events;
}
