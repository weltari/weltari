// The object_gc job (M7 part 3, Rev 4 §7): payload-less strays vanish after
// their creating scene ends; payload carriers and still-live scenes are
// exempt — and the append-only log stays intact (I1: the tombstone IS the
// deletion).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { Bus } from '../../http/bus.js';
import { createRootLogger } from '../../observability/logger.js';
import { openStorage, type Storage } from '../../storage/db.js';
import type { LedgerJob } from '../../storage/repositories/ledger.js';
import { createObjectGcHandler, OBJECT_GC_ACTOR_ID } from './object-gc.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_c, _e, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

function jobWith(payload: unknown): LedgerJob {
  return {
    id: 1,
    idempotency_key: 'object_gc:w1:s1',
    world_id: 'w1',
    type: 'object_gc',
    payload,
    state: 'running',
    attempts: 1,
    max_attempts: 5,
    run_at: '2026-07-16T12:00:00.000Z',
    lease_until: '2026-07-16T12:01:00.000Z',
    worker_id: 'w',
    serial_group: 'object_gc:w1',
    last_error: null,
  };
}

describe('object GC sweep (M7 part 3, Rev 4 §7)', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(): {
    storage: Storage;
    handler: ReturnType<typeof createObjectGcHandler>;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-objgc-'));
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const logger = quietLogger();
    const handler = createObjectGcHandler({
      storage,
      eventBus: new Bus(logger),
      logger,
    });
    return { storage, handler };
  }

  function endScene(s: Storage, sceneId: string): void {
    s.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'scene.ended',
      payload: { scene_id: sceneId, participants: ['char:elias'] },
    });
  }

  function createObject(
    s: Storage,
    objectId: string,
    name: string,
    extras: { payload?: string; sceneId?: string; proposalId?: string } = {},
  ): void {
    s.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:elias',
      type: 'object.created',
      payload: {
        object_id: objectId,
        name,
        holder_sublocation_id: 'subloc:common_room',
        ...(extras.payload === undefined
          ? {}
          : { object_payload: extras.payload }),
        ...(extras.proposalId === undefined
          ? { scene_id: extras.sceneId ?? 's1' }
          : { proposal_id: extras.proposalId }),
      },
    });
  }

  it('sweeps payload-less strays of ENDED scenes; carriers, live scenes and proposal rows are exempt (I1 intact)', async () => {
    const ctx = setup();
    // The stray: empty, created in s1, never touched again — s1 ends.
    createObject(ctx.storage, 'obj:stick', 'a dropped stick', {
      sceneId: 's1',
    });
    // Exempt: the payload rule (the letter survives).
    createObject(ctx.storage, 'obj:letter', 'a sealed letter', {
      payload: 'Meet me under the pier. — P',
      sceneId: 's1',
    });
    // Exempt: its creating scene is still open.
    createObject(ctx.storage, 'obj:mug', 'a chipped mug', { sceneId: 's2' });
    // Exempt: proposal-applied — no creating scene, never a candidate.
    createObject(ctx.storage, 'obj:lamp', 'a storm lamp', {
      proposalId: 'p-1',
    });
    endScene(ctx.storage, 's1');

    await ctx.handler(jobWith({ ended_scene_id: 's1' }));

    expect(ctx.storage.objects.byId('obj:stick')).toBeUndefined();
    expect(ctx.storage.objects.byId('obj:letter')).toBeDefined();
    expect(ctx.storage.objects.byId('obj:mug')).toBeDefined();
    expect(ctx.storage.objects.byId('obj:lamp')).toBeDefined();

    const events = ctx.storage.eventLog.readSince(0);
    const swept = events.filter((e) => e.type === 'object.swept');
    expect(swept).toHaveLength(1);
    expect(swept[0]?.actor_id).toBe(OBJECT_GC_ACTOR_ID);
    // I1: the creating event never leaves the log — the tombstone is the
    // deletion, the trail stays whole.
    expect(
      events.some(
        (e) =>
          e.type === 'object.created' && e.payload.object_id === 'obj:stick',
      ),
    ).toBe(true);
  });

  it('a stray touched again in a LATER scene is not a stray — the sweep leaves it', async () => {
    const ctx = setup();
    createObject(ctx.storage, 'obj:rope', 'a coil of rope', { sceneId: 's1' });
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:elias',
      type: 'object.moved',
      payload: {
        object_id: 'obj:rope',
        from_sublocation_id: 'subloc:common_room',
        to_sublocation_id: 'subloc:cellar',
        scene_id: 's2',
      },
    });
    endScene(ctx.storage, 's1');
    endScene(ctx.storage, 's2');

    await ctx.handler(jobWith({ ended_scene_id: 's2' }));
    expect(ctx.storage.objects.byId('obj:rope')).toBeDefined();
    expect(
      ctx.storage.eventLog
        .readSince(0)
        .filter((e) => e.type === 'object.swept'),
    ).toHaveLength(0);
  });

  it('re-running the sweep converges: zero duplicate tombstones', async () => {
    const ctx = setup();
    createObject(ctx.storage, 'obj:stick', 'a dropped stick', {
      sceneId: 's1',
    });
    endScene(ctx.storage, 's1');

    await ctx.handler(jobWith({ ended_scene_id: 's1' }));
    await ctx.handler(jobWith({ ended_scene_id: 's1' }));

    expect(
      ctx.storage.eventLog
        .readSince(0)
        .filter((e) => e.type === 'object.swept'),
    ).toHaveLength(1);
  });
});
