import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../storage/db.js';
import { createMapClickCommand } from './map-click.js';

describe('map-click command seam (Flow B step 1: the radius check)', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(): {
    storage: Storage;
    mapClick: ReturnType<typeof createMapClickCommand>;
    kicked: () => number;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-mapclick-'));
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'scene.started',
      payload: { scene_id: 's-seed', title: 'Seed' },
    });
    let kicks = 0;
    const mapClick = createMapClickCommand({
      storage,
      kick: (): void => {
        kicks += 1;
      },
    });
    return { storage, mapClick, kicked: () => kicks };
  }

  function click(
    ctx: { mapClick: ReturnType<typeof createMapClickCommand> },
    point: { x: number; y: number },
    requestId = 'c1',
    worldId = 'w1',
  ): ReturnType<ReturnType<typeof createMapClickCommand>> {
    return ctx.mapClick({
      world_id: worldId,
      actor_id: 'user:owner',
      point,
      request_id: requestId,
    });
  }

  it('a click inside a known radius enters that sublocation — zero jobs, zero model calls', () => {
    const ctx = setup();
    // 0.01/0.00 off the common room anchor (0.42, 0.55) — well inside the
    // half-square radius.
    const result = click(ctx, { x: 0.43, y: 0.55 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.outcome).toBe('enter');
      if (result.value.outcome === 'enter') {
        expect(result.value.sublocationId).toBe('subloc:common_room');
        expect(result.value.name).toBe('The Common Room');
      }
    }
    expect(ctx.storage.ledger.listActive('w1')).toHaveLength(0);
    expect(ctx.kicked()).toBe(0);
  });

  it('a Flow-A footprint containing the click wins over a nearby radius', () => {
    const ctx = setup();
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'sublocation.created',
      payload: {
        sublocation_id: 'subloc:edit-e1',
        name: 'The Drawn Garden',
        description: 'A walled herb garden.',
        map_position: { x: 0.4, y: 0.52 },
        footprint: [
          { x: 0.39, y: 0.51 },
          { x: 0.41, y: 0.51 },
          { x: 0.41, y: 0.53 },
          { x: 0.39, y: 0.53 },
        ],
        edit_id: 'e1',
      },
    });
    // Inside the garden footprint AND within the common room's radius —
    // the footprint is the more specific claim.
    const result = click(ctx, { x: 0.4, y: 0.52 });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.outcome === 'enter') {
      expect(result.value.sublocationId).toBe('subloc:edit-e1');
    }
  });

  it('a click outside all radii on explored ground enqueues ONE classify job', () => {
    const ctx = setup();
    // Still in the common room's explored square (3,4), but its far corner —
    // 0.0875 from the anchor, past the 0.0625 radius.
    const result = click(ctx, { x: 0.495, y: 0.505 }, 'c9');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.outcome).toBe('classify');
      if (result.value.outcome === 'classify') {
        expect(result.value.jobKey).toBe('map_click:w1:c9');
      }
    }
    const jobs = ctx.storage.ledger.listActive('w1');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.type).toBe('map_click');
    expect(ctx.kicked()).toBe(1);
    // Duplicate request_id: silent no-op, still one job (I3).
    const again = click(ctx, { x: 0.495, y: 0.505 }, 'c9');
    expect(again.ok).toBe(true);
    expect(ctx.storage.ledger.listActive('w1')).toHaveLength(1);
  });

  it('a fog click is refused — Explore owns fog (409, zero jobs)', () => {
    const ctx = setup();
    const result = click(ctx, { x: 0.05, y: 0.05 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unexplored_ground');
    expect(ctx.storage.ledger.listActive('w1')).toHaveLength(0);
  });

  it('an unknown world is refused', () => {
    const ctx = setup();
    const result = click(ctx, { x: 0.43, y: 0.55 }, 'c1', 'w-ghost');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('world_not_found');
  });
});
