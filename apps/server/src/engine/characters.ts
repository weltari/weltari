// The character registry (M7 part 2, Rev 4 §9): who exists in a world — the
// fixture seed profiles ∪ every character.created event, with the user's
// character.lock_set overlaid latest-wins. A projection like everything else:
// consent-gated applies append character.created, this fold makes them real
// for chat rosters, reflections and profile lookups; nothing revisits when
// make_character (week 18) lands — it appends the same event.
import type { SetCharacterLockCommand, WeltariEvent } from '@weltari/protocol';
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { Storage } from '../storage/db.js';
import type { CharacterProfile } from './context-assembler.js';
import type { EventSink } from './event-sink.js';

type CharacterCreated = Extract<
  WeltariEvent,
  { type: 'character.created' }
>['payload'];

/** Every character.created payload for the world, in event order (later
 * events for the same id never occur — the apply gate dedups ids). */
export function createdCharactersOf(
  storage: Storage,
  worldId: string,
): CharacterCreated[] {
  const created: CharacterCreated[] = [];
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.world_id !== worldId) continue;
    if (event.type === 'character.created') created.push(event.payload);
  }
  return created;
}

/** A created character's SEED profile — the event-borne counterpart of a
 * fixture profile. liveProfile() folds durable memory on top exactly like it
 * does for fixtures (M7 part 1: multi-character by construction). */
function profileOf(payload: CharacterCreated): CharacterProfile {
  return {
    character_id: payload.character_id,
    name: payload.name,
    skills: payload.skills,
    personality: payload.personality,
    memory_core: payload.core,
    goals: payload.goals,
  };
}

/**
 * The world's full character roster: seed (fixture/config) profiles ∪
 * created ones, each with the user's evolution lock overlaid (Rev 4 §7: the
 * latest character.lock_set wins over the seed profile's own flag — the
 * reflection gate reads the folded value). Fixture ids shadow nothing: the
 * apply gate refuses a create whose id collides.
 */
/**
 * The LIVE lock overlay for one profile (M7 part 2, Rev 4 §7): the latest
 * character.lock_set wins over the seed profile's own flag. The reflection
 * handlers apply this at RUN time, so the user's toggle gates the very next
 * evolution — no restart needed (the boot-time roster fold applies the same
 * events; this is the freshness path).
 */
export function withLiveLock(
  storage: Storage,
  worldId: string,
  profile: CharacterProfile,
): CharacterProfile {
  let locked = profile.locked;
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.world_id !== worldId) continue;
    if (
      event.type === 'character.lock_set' &&
      event.payload.character_id === profile.character_id
    ) {
      locked = event.payload.locked;
    }
  }
  return locked === undefined ? profile : { ...profile, locked };
}

export function characterProfilesOf(
  storage: Storage,
  worldId: string,
  seeds: readonly CharacterProfile[],
): CharacterProfile[] {
  const byId = new Map<string, CharacterProfile>(
    seeds.map((p) => [p.character_id, p]),
  );
  for (const payload of createdCharactersOf(storage, worldId)) {
    if (!byId.has(payload.character_id)) {
      byId.set(payload.character_id, profileOf(payload));
    }
  }
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.world_id !== worldId) continue;
    if (event.type !== 'character.lock_set') continue;
    const profile = byId.get(event.payload.character_id);
    if (profile === undefined) continue;
    byId.set(event.payload.character_id, {
      ...profile,
      locked: event.payload.locked,
    });
  }
  return [...byId.values()];
}

export interface SetCharacterLockOptions {
  storage: Storage;
  sink: EventSink;
  /** The world's seed profiles — created characters fold in per call. */
  seedProfiles: readonly CharacterProfile[];
}

/**
 * The user-facing evolution lock (M7 part 2, Rev 4 §7/§11): the flag that
 * has gated character.evolved since 0.16.0, finally user-settable. Durable
 * as character.lock_set (USER actor provenance); registry-gated — locking a
 * character that does not exist is a 409, zero rows.
 */
export function createSetCharacterLockCommand(
  options: SetCharacterLockOptions,
): (
  command: SetCharacterLockCommand,
) => Result<{ characterId: string; locked: boolean }> {
  const { storage, sink, seedProfiles } = options;
  return (command): Result<{ characterId: string; locked: boolean }> => {
    const known = characterProfilesOf(
      storage,
      command.world_id,
      seedProfiles,
    ).some((p) => p.character_id === command.character_id);
    if (!known) {
      return err(
        new OperationalError('unknown_character', 'no such character'),
      );
    }
    sink.append({
      world_id: command.world_id,
      actor_id: command.actor_id,
      type: 'character.lock_set',
      payload: {
        character_id: command.character_id,
        locked: command.locked,
      },
    });
    return ok({ characterId: command.character_id, locked: command.locked });
  };
}
