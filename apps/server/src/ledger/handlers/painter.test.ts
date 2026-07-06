import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createEventSink } from '../../engine/event-sink.js';
import { Bus } from '../../http/bus.js';
import { createRootLogger } from '../../observability/logger.js';
import { openStorage, type Storage } from '../../storage/db.js';
import type { LedgerJob } from '../../storage/repositories/ledger.js';
import { createPainterHandler } from './painter.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

function jobWith(payload: unknown, key = 'painter:map:w1:r1'): LedgerJob {
  return {
    id: 3,
    idempotency_key: key,
    world_id: 'w1',
    type: 'painter',
    payload,
    state: 'running',
    attempts: 1,
    max_attempts: 5,
    run_at: '2026-07-06T12:00:00.000Z',
    lease_until: '2026-07-06T12:01:00.000Z',
    worker_id: 'w',
    serial_group: 'painter:map:w1:96-96-64-64',
    last_error: null,
  };
}

const PAYLOAD = {
  image_id: 'map:w1',
  region: { x: 96, y: 96, width: 64, height: 64 },
};

describe('painter job handler', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(): {
    storage: Storage;
    imagesDir: string;
    handler: ReturnType<typeof createPainterHandler>;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-painter-handler-'));
    const logger = quietLogger();
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const imagesDir = join(dir, 'images');
    const handler = createPainterHandler({
      storage,
      sink: createEventSink(storage, new Bus(logger)),
      imagesDir,
      logger,
    });
    return { storage, imagesDir, handler };
  }

  it('commits exactly one painter.completed with a verifiable hash, even re-run', async () => {
    const ctx = setup();
    const job = jobWith(PAYLOAD);

    await ctx.handler(job);
    await ctx.handler(job); // the post-kill lease retry

    const completed = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'painter.completed');
    expect(completed).toHaveLength(1);
    const event = completed[0];
    if (event !== undefined) {
      expect(event.payload.job_key).toBe('painter:map:w1:r1');
      const bytes = readFileSync(join(ctx.imagesDir, event.payload.path));
      const hash = createHash('sha256').update(bytes).digest('hex');
      expect(hash).toBe(event.payload.sha256); // zero corrupted images
    }
  });

  it('chains composites: the second job paints onto the first job´s output', async () => {
    const ctx = setup();
    await ctx.handler(jobWith(PAYLOAD, 'painter:map:w1:r1'));
    await ctx.handler(
      jobWith(
        {
          image_id: 'map:w1',
          region: { x: 200, y: 200, width: 32, height: 32 },
        },
        'painter:map:w1:r2',
      ),
    );

    const completed = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'painter.completed');
    expect(completed).toHaveLength(2);
    const paths = completed.map((e) => e.payload.path);
    expect(new Set(paths).size).toBe(2); // composite-on-success: new file each time
  });

  it('garbage payload is corrupt state (Guide C2)', async () => {
    const ctx = setup();
    await expect(ctx.handler(jobWith({ nope: 1 }))).rejects.toMatchObject({
      kind: 'corrupt_state',
    });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(0);
  });
});
