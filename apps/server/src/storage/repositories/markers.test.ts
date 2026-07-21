// The markers repository (M7 part 4, Rev 4 §14/§17): the markers table as a
// projection of the marker.* events — fed by the append in-transaction,
// rebuilt at boot. Outcome tests through the public repository seam only
// (Guide test rule 5). Terminal rows stay: instantiated answers the join
// race, expired is the audit trail; "live" = state 'dropped'.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../db.js';

function tempStorage(): { storage: Storage; dbPath: string } {
  const dbPath = join(
    mkdtempSync(join(tmpdir(), 'weltari-markers-')),
    'w.sqlite',
  );
  return { storage: openStorage({ dbPath }), dbPath };
}

function dropMarker(
  storage: Storage,
  markerId: string,
  extras: {
    sublocationId?: string;
    cast?: string[];
    droppedAt?: string;
    ttl?: number;
    expiresAt?: string;
    source?: 'scene_end' | 'cron' | 'engine_topup';
    sceneId?: string;
  } = {},
): void {
  storage.eventLog.append({
    world_id: 'w1',
    actor_id: 'system:markers',
    type: 'marker.dropped',
    payload: {
      marker_id: markerId,
      kind: 'map_event',
      sublocation_id: extras.sublocationId ?? 'subloc:tide-bell',
      involved_characters: extras.cast ?? ['char:elias'],
      premise_seed: 'Something rattles inside a crate on the pier.',
      dropped_at_game_time: extras.droppedAt ?? '2000-01-01T12:00:00.000Z',
      ttl_game_minutes: extras.ttl ?? 180,
      expires_at_game_time: extras.expiresAt ?? '2000-01-01T15:00:00.000Z',
      source: extras.source ?? 'cron',
      ...(extras.sceneId === undefined ? {} : { scene_id: extras.sceneId }),
    },
  });
}

describe('markers repository (projection of marker.* events)', () => {
  it('folds dropped → instantiated, keeping the terminal row for the join race', () => {
    const { storage } = tempStorage();
    dropMarker(storage, 'marker:m1', { source: 'scene_end', sceneId: 's0' });
    let row = storage.markers.byId('marker:m1');
    expect(row?.state).toBe('dropped');
    expect(row?.proposed_by_scene_id).toBe('s0');
    expect(row?.involved_characters).toEqual(['char:elias']);
    expect(row?.version).toBe(1);
    expect(storage.markers.live('w1')).toHaveLength(1);

    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'marker.instantiated',
      payload: {
        marker_id: 'marker:m1',
        scene_id: 's-marker-m1',
        game_time: '2000-01-01T13:00:00.000Z',
      },
    });
    row = storage.markers.byId('marker:m1');
    expect(row?.state).toBe('instantiated');
    expect(row?.instantiated_scene_id).toBe('s-marker-m1');
    expect(row?.version).toBe(2);
    // Instantiated leaves the live set but the row STAYS — the second
    // click's join answer reads it.
    expect(storage.markers.live('w1')).toHaveLength(0);
  });

  it('folds dropped → expired and keeps the audit row out of the live set', () => {
    const { storage } = tempStorage();
    dropMarker(storage, 'marker:m1');
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:marker_sweep',
      type: 'marker.expired',
      payload: {
        marker_id: 'marker:m1',
        game_time: '2000-01-01T16:00:00.000Z',
        expired_via: 'sweep',
      },
    });
    const row = storage.markers.byId('marker:m1');
    expect(row?.state).toBe('expired');
    expect(row?.version).toBe(2);
    expect(storage.markers.live('w1')).toHaveLength(0);
  });

  it('lists the live set oldest drop first, per world', () => {
    const { storage } = tempStorage();
    dropMarker(storage, 'marker:m1');
    dropMarker(storage, 'marker:m2', { sublocationId: 'subloc:long-pier' });
    storage.eventLog.append({
      world_id: 'w2',
      actor_id: 'system:markers',
      type: 'marker.dropped',
      payload: {
        marker_id: 'marker:other-world',
        kind: 'map_event',
        sublocation_id: 'subloc:elsewhere',
        involved_characters: [],
        premise_seed: 'A stranger waits.',
        dropped_at_game_time: '2000-01-01T12:00:00.000Z',
        ttl_game_minutes: 60,
        expires_at_game_time: '2000-01-01T13:00:00.000Z',
        source: 'engine_topup',
      },
    });
    expect(storage.markers.live('w1').map((m) => m.marker_id)).toEqual([
      'marker:m1',
      'marker:m2',
    ]);
    expect(storage.markers.live('w2')).toHaveLength(1);
  });

  it('a transition event on a settled or missing row is corruption (Guide C2)', () => {
    const { storage } = tempStorage();
    dropMarker(storage, 'marker:m1');
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'marker.instantiated',
      payload: {
        marker_id: 'marker:m1',
        scene_id: 's-marker-m1',
        game_time: '2000-01-01T13:00:00.000Z',
      },
    });
    // A second transition on the settled row: the engine's fused re-check
    // makes this unreachable, so the projection refuses it loudly.
    expect(() =>
      storage.eventLog.append({
        world_id: 'w1',
        actor_id: 'system:marker_sweep',
        type: 'marker.expired',
        payload: {
          marker_id: 'marker:m1',
          game_time: '2000-01-01T16:00:00.000Z',
          expired_via: 'sweep',
        },
      }),
    ).toThrow(/no live row/);
    expect(() =>
      storage.eventLog.append({
        world_id: 'w1',
        actor_id: 'user:owner',
        type: 'marker.instantiated',
        payload: {
          marker_id: 'marker:ghost',
          scene_id: 's-x',
          game_time: '2000-01-01T13:00:00.000Z',
        },
      }),
    ).toThrow(/no live row/);
  });

  it('a duplicate marker id refuses at the projection (PRIMARY KEY)', () => {
    const { storage } = tempStorage();
    dropMarker(storage, 'marker:m1');
    expect(() => {
      dropMarker(storage, 'marker:m1');
    }).toThrow();
  });

  it('rebuild after reopen reproduces the identical projection (kill-safety)', () => {
    const { storage, dbPath } = tempStorage();
    dropMarker(storage, 'marker:m1');
    dropMarker(storage, 'marker:m2');
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'marker.instantiated',
      payload: {
        marker_id: 'marker:m1',
        scene_id: 's-marker-m1',
        game_time: '2000-01-01T13:00:00.000Z',
      },
    });
    storage.close();

    const reopened = openStorage({ dbPath });
    const m1 = reopened.markers.byId('marker:m1');
    expect(m1?.state).toBe('instantiated');
    expect(m1?.instantiated_scene_id).toBe('s-marker-m1');
    expect(m1?.version).toBe(2);
    expect(reopened.markers.live('w1').map((m) => m.marker_id)).toEqual([
      'marker:m2',
    ]);
    reopened.close();
  });
});
