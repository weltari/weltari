// The cache_prune job (M7 part 1, Rev 4 §11 retention): a WATERMARK the
// views respect, never a deletion — replay rebuilds the identical pruned
// view; idempotent by recomputation.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cachePruneDue,
  enqueueCachePruneIfDue,
  latestPerOrigin,
} from '../../engine/cache.js';
import { createEventSink } from '../../engine/event-sink.js';
import { Bus } from '../../http/bus.js';
import { createRootLogger } from '../../observability/logger.js';
import { openStorage, type Storage } from '../../storage/db.js';
import type { LedgerJob } from '../../storage/repositories/ledger.js';
import { createCachePruneHandler } from './cache-prune.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_c, _e, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

const CHAR = 'char:elias';

function jobWith(payload: unknown): LedgerJob {
  return {
    id: 1,
    idempotency_key: 'cache_prune:test',
    world_id: 'w1',
    type: 'cache_prune',
    payload,
    state: 'running',
    attempts: 1,
    max_attempts: 5,
    run_at: '2026-07-11T12:00:00.000Z',
    lease_until: '2026-07-11T12:01:00.000Z',
    worker_id: 'w',
    serial_group: 'memory:w1:char:elias',
    last_error: null,
  };
}

describe('cache retention (M7 part 1, Rev 4 §11)', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(): {
    storage: Storage;
    handler: ReturnType<typeof createCachePruneHandler>;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-cprune-'));
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const logger = quietLogger();
    const handler = createCachePruneHandler({
      storage,
      sink: createEventSink(storage, new Bus(logger)),
      logger,
    });
    return { storage, handler };
  }

  function seedEntries(
    s: Storage,
    count: number,
    origin: 'scene' | 'chat' = 'chat',
  ): number[] {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(
        s.eventLog.append({
          world_id: 'w1',
          actor_id: CHAR,
          type: 'cache.appended',
          payload: {
            character_id: CHAR,
            origin,
            context_id: `c${String(i)}`,
            line: `Recap number ${String(i)}.`,
          },
        }).id,
      );
    }
    return ids;
  }

  it('keeps the last N per character: the pass appends the watermark exactly once, retries no-op', async () => {
    const ctx = setup();
    const ids = seedEntries(ctx.storage, 8);
    // keep 5 of 8 → the watermark is the 3rd entry's id.
    const due = cachePruneDue(ctx.storage, CHAR, 5);
    expect(due?.watermark_id).toBe(ids[2]);
    enqueueCachePruneIfDue(ctx.storage, 'w1', CHAR, 5);
    const jobs = ctx.storage.ledger
      .listActive('w1')
      .filter((j) => j.type === 'cache_prune');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.serial_group).toBe('memory:w1:char:elias');

    const job = jobWith({ character_id: CHAR, keep: 5 });
    await ctx.handler(job);
    await ctx.handler(job); // retry: recomputation finds nothing over the limit

    const pruned = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'cache.pruned');
    expect(pruned).toHaveLength(1);
    const record = pruned[0];
    if (record?.type === 'cache.pruned') {
      expect(record.payload.watermark_id).toBe(ids[2]);
      expect(record.payload.kept).toBe(5);
    }
    // Under the limit again — nothing due.
    expect(cachePruneDue(ctx.storage, CHAR, 5)).toBeUndefined();
  });

  it('retention is a view rule: a lane whose only entry sank below the watermark disappears', async () => {
    const ctx = setup();
    seedEntries(ctx.storage, 1, 'scene'); // one ancient scene line
    seedEntries(ctx.storage, 7, 'chat'); // then chat outgrows the limit
    await ctx.handler(jobWith({ character_id: CHAR, keep: 5 }));

    const view = latestPerOrigin(ctx.storage, CHAR);
    expect(view.scene).toBeUndefined(); // pruned away — that is what pruning means
    expect(view.chat?.line).toBe('Recap number 6.'); // the newest survives
  });

  it('a fresh character or an under-limit one is a quiet no-op', async () => {
    const ctx = setup();
    seedEntries(ctx.storage, 3);
    await ctx.handler(jobWith({ character_id: CHAR, keep: 5 }));
    expect(
      ctx.storage.eventLog
        .readSince(0)
        .filter((e) => e.type === 'cache.pruned'),
    ).toHaveLength(0);
  });
});
