import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createEventSink } from '../../engine/event-sink.js';
import { Bus } from '../../http/bus.js';
import { createRootLogger } from '../../observability/logger.js';
import type { GeneratedTile, ImageSource } from '../../painter/image-source.js';
import { openStorage, type Storage } from '../../storage/db.js';
import type { LedgerJob } from '../../storage/repositories/ledger.js';
import { createPainterHandler, tilePromptFor } from './painter.js';

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
    serial_group: 'painter:map:w1',
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

  it('overlapping executions of ONE job commit exactly one event (lease-expiry race, week-7)', async () => {
    // Real generations can outlive their lease: the sweep reclaims the job
    // and a second execution runs while the first still awaits the provider.
    // A gated slow source interleaves two executions deliberately.
    const dir = mkdtempSync(join(tmpdir(), 'weltari-painter-handler-'));
    const logger = quietLogger();
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const imagesDir = join(dir, 'images');
    const release: (() => void)[] = [];
    const slowSource: ImageSource = {
      name: 'test-slow',
      async generateTile(): Promise<GeneratedTile> {
        await new Promise<void>((r) => release.push(r));
        const image = await sharp({
          create: {
            width: 32,
            height: 32,
            channels: 3,
            background: { r: 10, g: 200, b: 10 },
          },
        })
          .png()
          .toBuffer();
        return { image, coverage: 'region' };
      },
    };
    const handler = createPainterHandler({
      storage,
      sink: createEventSink(storage, new Bus(logger)),
      imagesDir,
      imageSource: slowSource,
      logger,
    });
    const job = jobWith(PAYLOAD);
    const first = handler(job);
    const second = handler({ ...job }); // the reclaimed re-execution
    // Both are now awaiting the "provider" — release them in order.
    while (release.length < 2) await new Promise((r) => setTimeout(r, 5));
    for (const r of release) r();
    await Promise.all([first, second]);

    const completed = storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'painter.completed');
    expect(completed).toHaveLength(1); // the loser no-oped at the last-instant re-check
  });

  it('a masked (Flow A) payload commits one event like any other paint', async () => {
    const ctx = setup();
    const job = jobWith(
      {
        image_id: 'map:w1',
        region: { x: 96, y: 96, width: 64, height: 64 },
        mask: [
          { x: 100, y: 100 },
          { x: 150, y: 100 },
          { x: 125, y: 150 },
        ],
      },
      'painter:map:w1:edit-e1',
    );
    await ctx.handler(job);
    await ctx.handler(job); // retry converges
    const completed = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'painter.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload.job_key).toBe('painter:map:w1:edit-e1');
  });

  it('tilePromptFor: an edit region´s prompt carries the created sublocation inside it', () => {
    const ctx = setup();
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'sublocation.created',
      payload: {
        sublocation_id: 'subloc:edit-e1',
        name: 'The Drawn Garden',
        description: 'A walled herb garden humming with bees.',
        map_position: { x: 0.25, y: 0.25 }, // px (128, 128)
        footprint: [
          { x: 0.2, y: 0.2 },
          { x: 0.3, y: 0.2 },
          { x: 0.25, y: 0.3 },
        ],
        edit_id: 'e1',
      },
    });
    // The un-aligned edit region around the centroid.
    const prompt = tilePromptFor(ctx.storage, 'w1', 'map:w1', {
      x: 94,
      y: 94,
      width: 68,
      height: 68,
    });
    expect(prompt).toContain('The Drawn Garden');
    expect(prompt).toContain('herb garden');
    // Square (2,2)'s neighbors: none of the fixture trio is adjacent.
    expect(prompt).not.toContain('The Common Room');
  });

  it('tilePromptFor: a materialized square´s prompt carries its stub + adjacent neighbors', () => {
    const ctx = setup();
    // The Common Room anchors at (0.42, 0.55) → square (3,4) → region x=192,y=256.
    const prompt = tilePromptFor(ctx.storage, 'w1', 'map:w1', {
      x: 192,
      y: 256,
      width: 64,
      height: 64,
    });
    expect(prompt).toContain('The Common Room');
    expect(prompt).toContain('hearth');
    expect(prompt).toContain('The Flooded Cellar'); // (3,5) is adjacent
    expect(prompt).not.toContain('The Old Shrine'); // (4,2) is two rows away
    expect(prompt).toContain('no labels');
  });

  it('tilePromptFor: unaligned regions and empty squares get the frontier prompt', () => {
    const ctx = setup();
    // 96 is not a multiple of the 64 px fog square — not a square paint.
    const unaligned = tilePromptFor(ctx.storage, 'w1', 'map:w1', {
      x: 96,
      y: 96,
      width: 64,
      height: 64,
    });
    expect(unaligned).toContain('Uncharted wilderness');
    // Aligned but nothing materialized there.
    const empty = tilePromptFor(ctx.storage, 'w1', 'map:w1', {
      x: 0,
      y: 0,
      width: 64,
      height: 64,
    });
    expect(empty).toContain('Uncharted wilderness');
  });

  it('tilePromptFor: a freshly materialized square is promptable immediately', () => {
    const ctx = setup();
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'sublocation.materialized',
      payload: {
        sublocation_id: 'subloc:sq-0-0',
        name: 'The Mill Pond',
        description: 'A still pond turning a moss-covered wheel.',
        square: { col: 0, row: 0 },
        map_position: { x: 0.0625, y: 0.0625 },
      },
    });
    const prompt = tilePromptFor(ctx.storage, 'w1', 'map:w1', {
      x: 0,
      y: 0,
      width: 64,
      height: 64,
    });
    expect(prompt).toContain('The Mill Pond');
    expect(prompt).toContain('moss-covered wheel');
  });
});
