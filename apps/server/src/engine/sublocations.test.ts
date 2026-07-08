import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../storage/db.js';
import { FIXTURE_SUBLOCATIONS } from './fixture/rainy-inn.js';
import {
  knownSublocations,
  squareCenter,
  squareOf,
  sublocationAt,
  sublocationIdForSquare,
  worldExists,
} from './sublocations.js';

describe('sublocation registry (projection of the event log)', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(): Storage {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-subloc-'));
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    return storage;
  }

  it('starts as the fixture trio and grows with sublocation.materialized', () => {
    const s = setup();
    expect(knownSublocations(s, 'w1').map((x) => x.sublocation_id)).toEqual(
      FIXTURE_SUBLOCATIONS.map((x) => x.sublocation_id),
    );
    s.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'sublocation.materialized',
      payload: {
        sublocation_id: 'subloc:sq-5-1',
        name: 'The Mill Pond',
        description: 'A quiet pond.',
        square: { col: 5, row: 1 },
        map_position: squareCenter({ col: 5, row: 1 }),
      },
    });
    const known = knownSublocations(s, 'w1');
    expect(known.map((x) => x.sublocation_id)).toContain('subloc:sq-5-1');
    // Another world's materialization never leaks in.
    expect(
      knownSublocations(s, 'w2').map((x) => x.sublocation_id),
    ).not.toContain('subloc:sq-5-1');
  });

  it('sublocationAt finds fixture and materialized occupants by square', () => {
    const s = setup();
    // subloc:common_room (0.42, 0.55) -> square (3, 4)
    expect(sublocationAt(s, 'w1', { col: 3, row: 4 })?.sublocation_id).toBe(
      'subloc:common_room',
    );
    expect(sublocationAt(s, 'w1', { col: 5, row: 1 })).toBeUndefined();
  });

  it('square math round-trips: center of a square lands back in it', () => {
    for (const square of [
      { col: 0, row: 0 },
      { col: 3, row: 4 },
      { col: 7, row: 7 },
    ]) {
      expect(squareOf(squareCenter(square))).toEqual(square);
    }
    // The 1.0 edge clamps into the last square instead of overflowing.
    expect(squareOf({ x: 1, y: 1 })).toEqual({ col: 7, row: 7 });
  });

  it('sublocation ids are deterministic per square (idempotent by construction)', () => {
    expect(sublocationIdForSquare({ col: 5, row: 1 })).toBe('subloc:sq-5-1');
  });

  it('worldExists = anything durable happened in it', () => {
    const s = setup();
    expect(worldExists(s, 'w1')).toBe(false);
    s.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'scene.started',
      payload: { scene_id: 's1', title: 'Seed' },
    });
    expect(worldExists(s, 'w1')).toBe(true);
    expect(worldExists(s, 'w-ghost')).toBe(false);
  });
});
