// CRON world movement (M7 part 4, Rev 4 §14): the world moves on its own —
// mailbox-routed location events at world-cron occurrences, presence-checked
// (never a character in an active scene), targets MATERIALIZED sublocations
// only, idempotent per occurrence (the world_cron.completed natural key
// gates the whole batch). Asserted through public seams: the planner, the
// code handler, event-log reads and the locations fold.
import { describe, expect, it } from 'vitest';
import {
  characterLocationsOf,
  planMovementEvents,
} from '../../apps/server/src/engine/locations.js';
import { appendSceneOpen } from '../../apps/server/src/engine/scene-lifecycle.js';
import { createEventSink } from '../../apps/server/src/engine/event-sink.js';
import { materializedSublocations } from '../../apps/server/src/engine/sublocations.js';
import { createWorldCronCodeHandler } from '../../apps/server/src/ledger/handlers/world-cron.js';
import { Bus } from '../../apps/server/src/http/bus.js';
import type { LedgerJob } from '../../apps/server/src/storage/repositories/ledger.js';
import { captureLogger } from '../helpers/capture-logger.js';
import { tempStorage } from '../helpers/temp-storage.js';

const WORLD = 'w1';
const ROSTER = [
  { character_id: 'char:elias', name: 'Elias' },
  { character_id: 'char:mara', name: 'Mara' },
];
const OCCURRENCE = '2000-01-01T09:00:00.000Z';

function movementJob(scheduledFor: string): LedgerJob {
  return {
    id: 7,
    idempotency_key: `wcron:world_movement:${WORLD}:${scheduledFor}`,
    world_id: WORLD,
    type: 'world_cron.code',
    payload: { cron_type: 'world_movement', scheduled_for: scheduledFor },
    state: 'running',
    attempts: 1,
    max_attempts: 5,
    run_at: '2026-07-17T12:00:00.000Z',
    lease_until: '2026-07-17T12:01:00.000Z',
    worker_id: 'w',
    serial_group: null,
    last_error: null,
  };
}

describe('CRON world movement (Rev 4 §14)', () => {
  it('moves available characters onto materialized sublocations, stamped with the scheduled time', () => {
    const storage = tempStorage();
    const events = planMovementEvents(storage, ROSTER, WORLD, OCCURRENCE);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const anchors = new Set(
      materializedSublocations(storage, WORLD).map((s) => s.sublocation_id),
    );
    for (const event of events) {
      if (event.type !== 'character.location_changed') throw new Error('type');
      expect(anchors.has(event.payload.to_sublocation_id)).toBe(true);
      expect(event.payload.game_time).toBe(OCCURRENCE);
      expect(event.payload.from_sublocation_id).toBeUndefined(); // first move
    }
    // Deterministic per occurrence: a lease-expiry retry could never diverge.
    expect(planMovementEvents(storage, ROSTER, WORLD, OCCURRENCE)).toEqual(
      events,
    );
    storage.close();
  });

  it('skips characters who are in a scene (presence check) and never twins a mover', () => {
    const storage = tempStorage();
    storage.transact(() =>
      appendSceneOpen(storage, ROSTER, {
        world_id: WORLD,
        actor_id: 'user:owner',
        scene_id: 's-busy',
        title: 'Busy',
        participants: ['char:elias'],
      }),
    );
    const events = planMovementEvents(storage, ROSTER, WORLD, OCCURRENCE);
    const movers = events.map((e) =>
      e.type === 'character.location_changed'
        ? e.payload.character_id
        : 'wrong-type',
    );
    expect(movers).not.toContain('char:elias');
    expect(new Set(movers).size).toBe(movers.length);
    storage.close();
  });

  it('a later move carries the from pointer and the locations fold tracks latest', () => {
    const storage = tempStorage();
    storage.eventLog.append({
      world_id: WORLD,
      actor_id: 'system:world_cron',
      type: 'character.location_changed',
      payload: {
        character_id: 'char:mara',
        to_sublocation_id: 'subloc:common_room',
        game_time: '2000-01-01T06:00:00.000Z',
      },
    });
    const events = planMovementEvents(storage, ROSTER, WORLD, OCCURRENCE);
    const maraMove = events.find(
      (e) =>
        e.type === 'character.location_changed' &&
        e.payload.character_id === 'char:mara',
    );
    if (maraMove !== undefined) {
      if (maraMove.type !== 'character.location_changed') throw new Error('t');
      expect(maraMove.payload.from_sublocation_id).toBe('subloc:common_room');
      expect(maraMove.payload.to_sublocation_id).not.toBe('subloc:common_room');
    }
    storage.transact(() => {
      for (const event of events) storage.eventLog.append(event);
      return null;
    });
    const locations = characterLocationsOf(storage, WORLD);
    for (const event of events) {
      if (event.type !== 'character.location_changed') continue;
      expect(locations.get(event.payload.character_id)).toBe(
        event.payload.to_sublocation_id,
      );
    }
    storage.close();
  });

  it('the code handler appends movement + completed atomically, idempotent per occurrence', async () => {
    const storage = tempStorage();
    const { logger } = captureLogger();
    const handler = createWorldCronCodeHandler({
      storage,
      sink: createEventSink(storage, new Bus(logger)),
      logger,
      occurrenceEvents: (worldId, cronType, scheduledFor) =>
        cronType === 'world_movement'
          ? planMovementEvents(storage, ROSTER, worldId, scheduledFor)
          : [],
    });
    await handler(movementJob(OCCURRENCE));
    const afterFirst = storage.eventLog.readSince(0, 100000);
    const moves = afterFirst.filter(
      (e) => e.type === 'character.location_changed',
    );
    expect(moves.length).toBeGreaterThanOrEqual(1);
    expect(
      afterFirst.filter((e) => e.type === 'world_cron.completed'),
    ).toHaveLength(1);
    // The retry no-ops on the completed natural key: ZERO duplicate moves.
    await handler(movementJob(OCCURRENCE));
    expect(storage.eventLog.readSince(0, 100000)).toHaveLength(
      afterFirst.length,
    );
    storage.close();
  });
});
