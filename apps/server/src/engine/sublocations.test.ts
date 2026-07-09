import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../storage/db.js';
import { FIXTURE_SUBLOCATIONS } from './fixture/rainy-inn.js';
import {
  knownSublocations,
  latestBackdropPath,
  solveFrontierSquare,
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

  function appendStub(
    s: Storage,
    sublocationId: string,
    name: string,
    parentId?: string,
  ): void {
    s.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:narrator',
      type: 'sublocation.stub_created',
      payload: {
        scene_id: 's1',
        sublocation_id: sublocationId,
        name,
        description: 'A new place.',
        ...(parentId === undefined ? {} : { parent_id: parentId }),
      },
    });
  }

  it('stubs fold into the registry: interiors inherit the parent anchor, parentless stay position-less (M6 part 1)', () => {
    const s = setup();
    appendStub(
      s,
      'subloc:stub-the-inn-kitchen',
      'The Inn Kitchen',
      'subloc:common_room',
    );
    appendStub(s, 'subloc:stub-the-river-park', 'The River Park');
    const known = knownSublocations(s, 'w1');
    const kitchen = known.find(
      (x) => x.sublocation_id === 'subloc:stub-the-inn-kitchen',
    );
    expect(kitchen?.parent_id).toBe('subloc:common_room');
    expect(kitchen?.map_position).toEqual({ x: 0.42, y: 0.55 });
    const park = known.find(
      (x) => x.sublocation_id === 'subloc:stub-the-river-park',
    );
    expect(park?.map_position).toBeUndefined();
    // Neither claims a fog square (interiors and unmaterialized stubs are
    // invisible to the map's mechanical loops).
    expect(sublocationAt(s, 'w1', { col: 3, row: 4 })?.sublocation_id).toBe(
      'subloc:common_room',
    );
  });

  it('a later materialization gives a parentless stub its map presence (same id)', () => {
    const s = setup();
    appendStub(s, 'subloc:stub-the-river-park', 'The River Park');
    s.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'sublocation.materialized',
      payload: {
        sublocation_id: 'subloc:stub-the-river-park',
        name: 'The River Park',
        description: 'A new place.',
        square: { col: 4, row: 4 },
        map_position: squareCenter({ col: 4, row: 4 }),
      },
    });
    const park = knownSublocations(s, 'w1').find(
      (x) => x.sublocation_id === 'subloc:stub-the-river-park',
    );
    expect(park?.map_position).toEqual(squareCenter({ col: 4, row: 4 }));
    expect(sublocationAt(s, 'w1', { col: 4, row: 4 })?.sublocation_id).toBe(
      'subloc:stub-the-river-park',
    );
  });

  it('solveFrontierSquare picks the free square nearest the anchor that touches the explored area', () => {
    const s = setup();
    // Explore the fixture trio's squares: common_room (3,4), cellar (3,5),
    // shrine (4,2) — seeded as materialized like a fresh world boot.
    for (const f of FIXTURE_SUBLOCATIONS) {
      s.eventLog.append({
        world_id: 'w1',
        actor_id: 'system:engine',
        type: 'sublocation.materialized',
        payload: {
          sublocation_id: f.sublocation_id,
          name: f.name,
          description: f.description,
          square: squareOf(f.map_position),
          map_position: f.map_position,
        },
      });
    }
    const anchor = { x: 0.42, y: 0.55 }; // the common room, square (3,4)
    const solved = solveFrontierSquare(s, 'w1', anchor);
    expect(solved).toBeDefined();
    if (solved === undefined) return;
    // Free, and adjacent (8-neighborhood) to an explored square.
    expect(sublocationAt(s, 'w1', solved)).toBeUndefined();
    const explored = [
      { col: 3, row: 4 },
      { col: 3, row: 5 },
      { col: 4, row: 2 },
    ];
    expect(
      explored.some(
        (sq) =>
          Math.abs(sq.col - solved.col) <= 1 &&
          Math.abs(sq.row - solved.row) <= 1 &&
          !(sq.col === solved.col && sq.row === solved.row),
      ),
    ).toBe(true);
    // Deterministic: the same state solves to the same square.
    expect(solveFrontierSquare(s, 'w1', anchor)).toEqual(solved);
  });

  it('solveFrontierSquare returns undefined on a full map (the stub stays map-less)', () => {
    const s = setup();
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        s.eventLog.append({
          world_id: 'w1',
          actor_id: 'system:engine',
          type: 'sublocation.materialized',
          payload: {
            sublocation_id: `subloc:sq-${String(col)}-${String(row)}`,
            name: `Square ${String(col)},${String(row)}`,
            description: 'Filled.',
            square: { col, row },
            map_position: squareCenter({ col, row }),
          },
        });
      }
    }
    expect(solveFrontierSquare(s, 'w1', { x: 0.5, y: 0.5 })).toBeUndefined();
  });

  it('latestBackdropPath reads the newest painter.completed for the backdrop image class', () => {
    const s = setup();
    expect(latestBackdropPath(s, 'subloc:stub-x')).toBeUndefined();
    for (const path of ['a.png', 'b.png']) {
      s.eventLog.append({
        world_id: 'w1',
        actor_id: 'system:painter',
        type: 'painter.completed',
        payload: {
          image_id: 'backdrop:subloc:stub-x',
          region: { x: 0, y: 0, width: 512, height: 512 },
          path: `backdrop-subloc-stub-x/${path}`,
          sha256: 'f'.repeat(64),
          job_key: `painter:backdrop:subloc:stub-x:${path}`,
        },
      });
    }
    expect(latestBackdropPath(s, 'subloc:stub-x')).toBe(
      'backdrop-subloc-stub-x/b.png',
    );
    // Another sublocation's backdrop never leaks in.
    expect(latestBackdropPath(s, 'subloc:stub-y')).toBeUndefined();
  });
});
