// The memory_compaction job (M7 part 1, Rev 4 §11, criterion e): one
// cumulative record per range, exactly once under kill-retry; the read path
// prefers it; a repair re-run appends a SUPERSEDING record (the log is
// append-only — repair for free, no deletion anywhere); deltas never leave
// the log or the Search Index.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createEventSink } from '../../engine/event-sink.js';
import { buildEliasProfile } from '../../engine/fixture/rainy-inn.js';
import {
  archiveView,
  compactionDue,
  enqueueCompactionIfDue,
  memoryStateOf,
  MEMORY_COMPACT_KEEP,
  MEMORY_COMPACT_TRIGGER,
} from '../../engine/memory.js';
import { Bus } from '../../http/bus.js';
import { createFakeLlmClient } from '../../llm/fake-client.js';
import { createRootLogger } from '../../observability/logger.js';
import { openStorage, type Storage } from '../../storage/db.js';
import type { LedgerJob } from '../../storage/repositories/ledger.js';
import { createMemoryCompactionHandler } from './memory-compaction.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_c, _e, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

const ELIAS = buildEliasProfile(100);

function jobWith(payload: unknown): LedgerJob {
  return {
    id: 1,
    idempotency_key: 'memory_compaction:test',
    world_id: 'w1',
    type: 'memory_compaction',
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

describe('memory compaction (M7 part 1)', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(): {
    storage: Storage;
    handler: ReturnType<typeof createMemoryCompactionHandler>;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-compact-'));
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const logger = quietLogger();
    const handler = createMemoryCompactionHandler({
      storage,
      sink: createEventSink(storage, new Bus(logger)),
      llm: createFakeLlmClient(),
      profiles: [ELIAS],
      logger,
    });
    return { storage, handler };
  }

  function seedDeltas(s: Storage, count: number): number[] {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(
        s.eventLog.append({
          world_id: 'w1',
          actor_id: ELIAS.character_id,
          type: 'memory.delta_committed',
          payload: {
            character_id: ELIAS.character_id,
            origin: 'scene',
            context_id: `s${String(i)}`,
            content: `Storm-season note number ${String(i)} about the inn and its people.`,
          },
        }).id,
      );
    }
    return ids;
  }

  it('the trigger fires past the window, keys the range, and the pass commits exactly once under retry (criteria d+e)', async () => {
    const ctx = setup();
    const ids = seedDeltas(ctx.storage, MEMORY_COMPACT_TRIGGER + 1); // 17
    // The due-check names the range: everything but the newest KEEP.
    const due = compactionDue(ctx.storage, ELIAS.character_id);
    const expectedUpTo = ids.at(-(MEMORY_COMPACT_KEEP + 1));
    expect(due?.up_to_id).toBe(expectedUpTo);
    // The enqueue helper mints the job with the natural key.
    enqueueCompactionIfDue(ctx.storage, 'w1', ELIAS.character_id);
    enqueueCompactionIfDue(ctx.storage, 'w1', ELIAS.character_id); // dup = no-op (I3)
    const jobs = ctx.storage.ledger.listActive('w1');
    const compactionJobs = jobs.filter((j) => j.type === 'memory_compaction');
    expect(compactionJobs).toHaveLength(1);
    expect(compactionJobs[0]?.serial_group).toBe('memory:w1:char:elias');

    const job = jobWith({
      character_id: ELIAS.character_id,
      up_to_id: due?.up_to_id,
    });
    await ctx.handler(job);
    await ctx.handler(job); // the post-kill lease retry

    const records = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'memory.compacted');
    expect(records).toHaveLength(1);
    const record = records[0];
    if (record?.type === 'memory.compacted') {
      expect(record.payload.up_to_id).toBe(due?.up_to_id);
      // Cumulative: covers every delta at or below up_to_id.
      expect(record.payload.delta_count).toBe(
        MEMORY_COMPACT_TRIGGER + 1 - MEMORY_COMPACT_KEEP,
      );
    }
    // The read path prefers the record; newer deltas lay on top.
    const view = archiveView(ctx.storage, ELIAS.character_id);
    expect(view.summary).toContain('Storm season so far');
    expect(view.deltas).toHaveLength(MEMORY_COMPACT_KEEP);
    // Deltas never leave the log or the Search Index.
    expect(memoryStateOf(ctx.storage, ELIAS.character_id).deltas).toHaveLength(
      ids.length,
    );
    expect(
      ctx.storage.memoryIndex.search(
        ELIAS.character_id,
        'storm season note number',
        3,
      ).length,
    ).toBeGreaterThan(0);
    // Nothing further is due until the window outgrows the trigger again.
    expect(compactionDue(ctx.storage, ELIAS.character_id)).toBeUndefined();
  });

  it('a repair re-run appends a SUPERSEDING record — the fold takes the latest (repair for free)', async () => {
    const ctx = setup();
    seedDeltas(ctx.storage, MEMORY_COMPACT_TRIGGER);
    const due = compactionDue(ctx.storage, ELIAS.character_id);
    const base = { character_id: ELIAS.character_id, up_to_id: due?.up_to_id };
    await ctx.handler(jobWith(base));
    // The owner judged the pass bad — re-run the SAME range in repair mode.
    await ctx.handler(jobWith({ ...base, repair: true }));

    const records = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'memory.compacted');
    expect(records).toHaveLength(2); // both stay in the append-only log…
    // …and the fold serves the latest.
    const state = memoryStateOf(ctx.storage, ELIAS.character_id);
    expect(state.compaction?.up_to_id).toBe(due?.up_to_id);
  });

  it('a range with no deltas is a quiet no-op — zero rows (I8 ethos)', async () => {
    const ctx = setup();
    await ctx.handler(
      jobWith({ character_id: ELIAS.character_id, up_to_id: 5 }),
    );
    expect(
      ctx.storage.eventLog
        .readSince(0)
        .filter((e) => e.type === 'memory.compacted'),
    ).toHaveLength(0);
  });

  it('garbage payload is corrupt state, not input (Guide C2)', async () => {
    const ctx = setup();
    await expect(
      ctx.handler(jobWith({ wrong: 'shape' })),
    ).rejects.toMatchObject({ kind: 'corrupt_state' });
  });
});
