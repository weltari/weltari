import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../storage/db.js';
import { createExploreCommand } from './explore.js';
import { squareCenter } from './sublocations.js';

describe('explore command seam', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(): {
    storage: Storage;
    explore: ReturnType<typeof createExploreCommand>;
    kicked: () => number;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-explore-'));
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'scene.started',
      payload: { scene_id: 's-seed', title: 'Seed' },
    });
    let kicks = 0;
    const explore = createExploreCommand({
      storage,
      kick: (): void => {
        kicks += 1;
      },
    });
    return { storage, explore, kicked: () => kicks };
  }

  it('enqueues one materialize job per square and kicks the runner', () => {
    const ctx = setup();
    const result = ctx.explore({
      world_id: 'w1',
      actor_id: 'user:owner',
      square: { col: 5, row: 1 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.jobKey).toBe('materialize:w1:5:1');
    const jobs = ctx.storage.ledger.listActive('w1');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.type).toBe('materialize');
    expect(ctx.kicked()).toBe(1);
  });

  it('a duplicate square is a silent no-op that still 202s (I3)', () => {
    const ctx = setup();
    const square = { col: 5, row: 1 };
    const first = ctx.explore({
      world_id: 'w1',
      actor_id: 'user:owner',
      square,
    });
    const second = ctx.explore({
      world_id: 'w1',
      actor_id: 'user:owner',
      square,
    });
    expect(first.ok && second.ok).toBe(true);
    expect(ctx.storage.ledger.listActive('w1')).toHaveLength(1);
  });

  it('an occupied square is refused — 409, zero rows (engine-state gate)', () => {
    const ctx = setup();
    // subloc:common_room (0.42, 0.55) occupies square (3, 4).
    const result = ctx.explore({
      world_id: 'w1',
      actor_id: 'user:owner',
      square: { col: 3, row: 4 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('square_occupied');
    expect(ctx.storage.ledger.listActive('w1')).toHaveLength(0);
  });

  it('a materialized square is occupied too (one reveal per square, ever)', () => {
    const ctx = setup();
    ctx.storage.eventLog.append({
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
    const result = ctx.explore({
      world_id: 'w1',
      actor_id: 'user:owner',
      square: { col: 5, row: 1 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('square_occupied');
  });

  it('an unknown world is refused (worlds appear, never vanish)', () => {
    const ctx = setup();
    const result = ctx.explore({
      world_id: 'w-ghost',
      actor_id: 'user:owner',
      square: { col: 5, row: 1 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('world_not_found');
  });
});
