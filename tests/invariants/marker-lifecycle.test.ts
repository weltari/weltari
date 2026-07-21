// The living-world loop (M7 part 4, Rev 4 §14/§17): the 1–5 live-marker
// rules are ENGINE invariants, asserted through public seams (the marker
// engine, event-log reads, the markers repository) — never by trusting a
// scheduler. Covered here: the top-up floor and refusal ceiling (I8: a
// refused drop appends ZERO rows), born-expired suppression, the lazy sweep
// + click-time re-validation, first-click-wins/second-joins, and the
// scene-end fan-out (follow-up in the same transaction; top-up fallback).
import { describe, expect, it } from 'vitest';
import type { WeltariEvent } from '@weltari/protocol';
import {
  appendMarkerDrop,
  createMarkerEngine,
  DEFAULT_MARKER_CONFIG,
  type MarkerEngine,
} from '../../apps/server/src/engine/markers.js';
import {
  appendSceneEndWithFanOut,
  appendSceneOpen,
} from '../../apps/server/src/engine/scene-lifecycle.js';
import { Bus } from '../../apps/server/src/http/bus.js';
import type { Storage } from '../../apps/server/src/storage/db.js';
import { captureLogger } from '../helpers/capture-logger.js';
import { tempStorage } from '../helpers/temp-storage.js';

const WORLD = 'w1';
const OWNER = 'user:owner';
const ELIAS = { character_id: 'char:elias', name: 'Elias' };
// The fixture trio is the registry base — materialized anchors on any world.
const ANCHOR = 'subloc:common_room';

function setup(): { storage: Storage; engine: MarkerEngine } {
  const { logger } = captureLogger();
  const storage = tempStorage();
  const engine = createMarkerEngine({
    storage,
    eventBus: new Bus(logger),
    logger,
    knownCharacters: [ELIAS],
  });
  return { storage, engine };
}

function advanceClock(storage: Storage, from: string, to: string): void {
  storage.eventLog.append({
    world_id: WORLD,
    actor_id: 'system:engine',
    type: 'world.time_advanced',
    payload: {
      from,
      to,
      code_enqueued: 0,
      llm_enqueued: 0,
      llm_skipped: 0,
    },
  });
}

/** Drop through the one public gate, inside a transaction like every caller. */
function drop(
  storage: Storage,
  extras: { droppedAt?: string; ttl?: number; cast?: string[] } = {},
): ReturnType<typeof appendMarkerDrop> {
  return storage.transact(() =>
    appendMarkerDrop(storage, DEFAULT_MARKER_CONFIG, {
      world_id: WORLD,
      actor_id: 'system:markers',
      sublocation_id: ANCHOR,
      involved_characters: extras.cast ?? [],
      premise_seed: 'Someone lingers by the hearth.',
      dropped_at_game_time: extras.droppedAt ?? '2000-01-01T06:00:00.000Z',
      ttl_game_minutes: extras.ttl ?? 180,
      source: 'cron',
    }),
  );
}

function markerEvents(storage: Storage): WeltariEvent[] {
  return storage.eventLog
    .readSince(0, 100000)
    .filter((e) => e.type.startsWith('marker.'));
}

describe('the 1–5 live invariant (Rev 4 §14)', () => {
  it('tops up to the minimum with generated content; drops above the maximum are refused with zero rows (I8)', async () => {
    const { storage, engine } = setup();
    // The boot path: an empty world gets its first marker from the top-up.
    expect(await engine.ensureMinimum(WORLD)).toBe(1);
    const [first] = storage.markers.live(WORLD);
    expect(first?.source).toBe('engine_topup');
    expect(first?.premise_seed).toContain('Elias'); // an available character rode along
    // Fill to the ceiling…
    while (storage.markers.live(WORLD).length < DEFAULT_MARKER_CONFIG.max) {
      expect(drop(storage).outcome).toBe('dropped');
    }
    const before = markerEvents(storage).length;
    // …and the sixth drop is refused structurally: ZERO rows, zero events.
    expect(drop(storage).outcome).toBe('refused_at_max');
    expect(markerEvents(storage)).toHaveLength(before);
    expect(storage.markers.live(WORLD)).toHaveLength(DEFAULT_MARKER_CONFIG.max);
    // ensureMinimum at the ceiling is a no-op.
    expect(await engine.ensureMinimum(WORLD)).toBe(0);
  });

  it('refuses an unanchored drop (materialized-only, Rev 4 §14)', () => {
    const { storage } = setup();
    const result = storage.transact(() =>
      appendMarkerDrop(storage, DEFAULT_MARKER_CONFIG, {
        world_id: WORLD,
        actor_id: 'system:markers',
        sublocation_id: 'subloc:nowhere',
        involved_characters: [],
        premise_seed: 'A shadow moves.',
        dropped_at_game_time: '2000-01-01T06:00:00.000Z',
        ttl_game_minutes: 60,
        source: 'cron',
      }),
    );
    expect(result.outcome).toBe('unknown_sublocation');
    expect(markerEvents(storage)).toHaveLength(0);
  });

  it('never drops a born-expired marker (time-skip replay suppression)', () => {
    const { storage } = setup();
    advanceClock(
      storage,
      '2000-01-01T06:00:00.000Z',
      '2000-01-01T12:00:00.000Z',
    );
    // Scheduled 06:00 + 60 min TTL = expired 07:00, five hours behind the
    // clock — during skip replay this occurrence never surfaces at all.
    const result = drop(storage, {
      droppedAt: '2000-01-01T06:00:00.000Z',
      ttl: 60,
    });
    expect(result.outcome).toBe('born_expired');
    expect(markerEvents(storage)).toHaveLength(0);
  });
});

describe('lazy game-time expiry (the sweep + click re-validation)', () => {
  it('the sweep expires due markers at a clock advance and tops back up', async () => {
    const { storage, engine } = setup();
    const dropped = drop(storage, { ttl: 60 });
    if (dropped.outcome !== 'dropped') throw new Error('drop failed');
    const markerId =
      dropped.event.type === 'marker.dropped'
        ? dropped.event.payload.marker_id
        : '';
    // Nothing due yet — the sweep commits nothing.
    expect(await engine.sweepExpired(WORLD)).toBe(0);
    advanceClock(
      storage,
      '2000-01-01T06:00:00.000Z',
      '2000-01-01T08:00:00.000Z',
    );
    expect(await engine.sweepExpired(WORLD)).toBe(1);
    expect(storage.markers.byId(markerId)?.state).toBe('expired');
    // Expiry dropped the live set to zero; the sweep's top-up restored it.
    expect(storage.markers.live(WORLD).length).toBeGreaterThanOrEqual(1);
    // A second sweep converges: nothing due, no duplicate expiry.
    expect(await engine.sweepExpired(WORLD)).toBe(0);
    expect(
      markerEvents(storage).filter(
        (e) => e.type === 'marker.expired' && e.payload.marker_id === markerId,
      ),
    ).toHaveLength(1);
  });

  it('a click on an expired-but-unswept marker is refused and settles it', async () => {
    const { storage, engine } = setup();
    const dropped = drop(storage, { ttl: 60 });
    if (dropped.outcome !== 'dropped') throw new Error('drop failed');
    const markerId =
      dropped.event.type === 'marker.dropped'
        ? dropped.event.payload.marker_id
        : '';
    advanceClock(
      storage,
      '2000-01-01T06:00:00.000Z',
      '2000-01-01T09:00:00.000Z',
    );
    // No sweep ran — the click IS the lazy judgment.
    const result = await engine.click({
      world_id: WORLD,
      actor_id: OWNER,
      marker_id: markerId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('marker_expired');
    const row = storage.markers.byId(markerId);
    expect(row?.state).toBe('expired');
    // Settled via the click path, and NO scene ever started.
    expect(
      markerEvents(storage).some(
        (e) =>
          e.type === 'marker.expired' &&
          e.payload.marker_id === markerId &&
          e.payload.expired_via === 'click',
      ),
    ).toBe(true);
    expect(
      storage.eventLog
        .readSince(0, 100000)
        .some((e) => e.type === 'scene.started'),
    ).toBe(false);
  });
});

describe('first click wins, second joins (the version race)', () => {
  it('two clicks on one marker instantiate exactly ONE scene; the loser joins it', async () => {
    const { storage, engine } = setup();
    const dropped = drop(storage, { cast: [ELIAS.character_id] });
    if (dropped.outcome !== 'dropped') throw new Error('drop failed');
    const markerId =
      dropped.event.type === 'marker.dropped'
        ? dropped.event.payload.marker_id
        : '';
    const first = await engine.click({
      world_id: WORLD,
      actor_id: OWNER,
      marker_id: markerId,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.outcome).toBe('instantiated');
    const second = await engine.click({
      world_id: WORLD,
      actor_id: OWNER,
      marker_id: markerId,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.outcome).toBe('join');
    expect(second.value.scene_id).toBe(first.value.scene_id);
    // Exactly ONE scene.started; the roster carries the re-validated cast;
    // the scene opened AT the marker's sublocation with the premise seed.
    const events = storage.eventLog.readSince(0, 100000);
    const starts = events.filter(
      (e) =>
        e.type === 'scene.started' &&
        e.payload.scene_id === first.value.scene_id,
    );
    expect(starts).toHaveLength(1);
    const start = starts[0];
    expect(
      start?.type === 'scene.started' ? start.payload.premise : undefined,
    ).toBe('Someone lingers by the hearth.');
    expect(
      events.some(
        (e) =>
          e.type === 'character.joined' &&
          e.payload.scene_id === first.value.scene_id &&
          e.payload.character_id === ELIAS.character_id,
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === 'sublocation.changed' &&
          e.payload.scene_id === first.value.scene_id &&
          e.payload.sublocation_id === ANCHOR,
      ),
    ).toBe(true);
  });

  it('click-time cast re-validation drops a character who wandered into another scene', async () => {
    const { storage, engine } = setup();
    const dropped = drop(storage, { cast: [ELIAS.character_id] });
    if (dropped.outcome !== 'dropped') throw new Error('drop failed');
    const markerId =
      dropped.event.type === 'marker.dropped'
        ? dropped.event.payload.marker_id
        : '';
    // Elias joins some other scene between drop and click.
    storage.transact(() =>
      appendSceneOpen(storage, [ELIAS], {
        world_id: WORLD,
        actor_id: OWNER,
        scene_id: 's-elsewhere',
        title: 'Elsewhere',
        participants: [ELIAS.character_id],
      }),
    );
    const result = await engine.click({
      world_id: WORLD,
      actor_id: OWNER,
      marker_id: markerId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The scene still opens — the Narrator works with who's here.
    expect(
      storage.eventLog
        .readSince(0, 100000)
        .some(
          (e) =>
            e.type === 'character.joined' &&
            e.payload.scene_id === result.value.scene_id,
        ),
    ).toBe(false);
  });
});

describe('the scene-end fan-out feeds the marker loop (Rev 4 §6/§14)', () => {
  it('a registered follow-up becomes a live marker in the same fan-out transaction', () => {
    const { storage, engine } = setup();
    const { markerEvents: fanOut } = storage.transact(() =>
      appendSceneEndWithFanOut(
        storage,
        [ELIAS],
        {
          world_id: WORLD,
          actor_id: OWNER,
          scene_id: 's1',
          follow_up_marker: {
            sublocation_id: ANCHOR,
            premise_seed: 'The stranger said to come back after dark.',
          },
        },
        engine,
      ),
    );
    const followUp = fanOut.find(
      (e) => e.type === 'marker.dropped' && e.payload.source === 'scene_end',
    );
    expect(followUp).toBeDefined();
    if (followUp?.type !== 'marker.dropped') return;
    expect(followUp.payload.scene_id).toBe('s1');
    expect(followUp.payload.premise_seed).toBe(
      'The stranger said to come back after dark.',
    );
    const row = storage.markers.byId(followUp.payload.marker_id);
    expect(row?.state).toBe('dropped');
    expect(row?.proposed_by_scene_id).toBe('s1');
  });

  it('a scene with no follow-up still leaves the world above the minimum (top-up path)', () => {
    const { storage, engine } = setup();
    expect(storage.markers.live(WORLD)).toHaveLength(0);
    const { markerEvents: fanOut } = storage.transact(() =>
      appendSceneEndWithFanOut(
        storage,
        [ELIAS],
        { world_id: WORLD, actor_id: OWNER, scene_id: 's1' },
        engine,
      ),
    );
    expect(
      fanOut.filter(
        (e) =>
          e.type === 'marker.dropped' && e.payload.source === 'engine_topup',
      ),
    ).toHaveLength(DEFAULT_MARKER_CONFIG.min);
    expect(storage.markers.live(WORLD).length).toBeGreaterThanOrEqual(
      DEFAULT_MARKER_CONFIG.min,
    );
  });

  it('a follow-up at the ceiling is refused with zero rows (I8) — the map never overfills', () => {
    const { storage, engine } = setup();
    while (storage.markers.live(WORLD).length < DEFAULT_MARKER_CONFIG.max) {
      expect(drop(storage).outcome).toBe('dropped');
    }
    const before = markerEvents(storage).length;
    storage.transact(() =>
      appendSceneEndWithFanOut(
        storage,
        [ELIAS],
        {
          world_id: WORLD,
          actor_id: OWNER,
          scene_id: 's1',
          follow_up_marker: {
            sublocation_id: ANCHOR,
            premise_seed: 'One too many.',
          },
        },
        engine,
      ),
    );
    expect(markerEvents(storage)).toHaveLength(before);
    expect(storage.markers.live(WORLD)).toHaveLength(DEFAULT_MARKER_CONFIG.max);
  });
});
