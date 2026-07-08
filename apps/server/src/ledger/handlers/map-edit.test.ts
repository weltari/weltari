import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { err, ok, OperationalError, type Result } from '../../errors.js';
import { buildNarratorProfile } from '../../engine/fixture/rainy-inn.js';
import { createEventSink } from '../../engine/event-sink.js';
import { Bus } from '../../http/bus.js';
import { createFakeLlmClient } from '../../llm/fake-client.js';
import type { LlmCallResult, LlmClient } from '../../llm/types.js';
import { createRootLogger } from '../../observability/logger.js';
import { openStorage, type Storage } from '../../storage/db.js';
import type { LedgerJob } from '../../storage/repositories/ledger.js';
import { createMapEditHandler } from './map-edit.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

const NARRATOR = buildNarratorProfile(100);

/** An LlmClient scripted to return a fixed completion text (gate-1 subjects). */
function textClient(text: string): LlmClient {
  return {
    streamCall: async (): Promise<Result<LlmCallResult>> => {
      const result: LlmCallResult = {
        text,
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
        model: 'fake/scripted',
        durationMs: 0,
        toolCalls: [],
      };
      return Promise.resolve(ok(result));
    },
  };
}

// A triangle around the fixture common room (0.42, 0.55) — its centroid
// lands in explored square (3, 4).
const TRIANGLE = [
  { x: 0.4, y: 0.53 },
  { x: 0.45, y: 0.53 },
  { x: 0.42, y: 0.58 },
];

const PAYLOAD = {
  edit_id: 'e1',
  points: TRIANGLE,
  intent: 'a mill pond with a heron',
  requested_by: 'user:owner',
};

function jobWith(payload: unknown, worldId = 'w1'): LedgerJob {
  return {
    id: 1,
    idempotency_key: 'map_edit:w1:e1',
    world_id: worldId,
    type: 'map_edit',
    payload,
    state: 'running',
    attempts: 1,
    max_attempts: 5,
    run_at: '2026-07-08T12:00:00.000Z',
    lease_until: '2026-07-08T12:01:00.000Z',
    worker_id: 'w',
    serial_group: null,
    last_error: null,
  };
}

describe('map_edit job handler (Flow A, B6 double gate)', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(llm?: LlmClient): {
    storage: Storage;
    handler: ReturnType<typeof createMapEditHandler>;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-mapedit-handler-'));
    const logger = quietLogger();
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const sink = createEventSink(storage, new Bus(logger));
    // The world must exist (engine-state gate) — seed one durable event.
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'scene.started',
      payload: { scene_id: 's-seed', title: 'Seed' },
    });
    const handler = createMapEditHandler({
      storage,
      sink,
      llm: llm ?? createFakeLlmClient(),
      narrator: NARRATOR,
      logger,
    });
    return { storage, handler };
  }

  it('appends exactly one sublocation.created at the centroid, even re-run', async () => {
    const ctx = setup();
    const job = jobWith(PAYLOAD);

    await ctx.handler(job);
    await ctx.handler(job); // the post-kill lease retry

    const created = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'sublocation.created');
    expect(created).toHaveLength(1);
    const event = created[0];
    if (event?.type === 'sublocation.created') {
      expect(event.actor_id).toBe('user:owner'); // users create via lasso
      expect(event.payload.sublocation_id).toBe('subloc:edit-e1');
      expect(event.payload.edit_id).toBe('e1');
      expect(event.payload.footprint).toEqual(TRIANGLE);
      // Centroid of the triangle, inside the drawn shape.
      expect(event.payload.map_position.x).toBeCloseTo(0.4233, 3);
      expect(event.payload.map_position.y).toBeCloseTo(0.5467, 3);
      expect(event.payload.name.length).toBeGreaterThan(0);
    }
  });

  it('enqueues ONE painter job with the polygon mask, deduped across retries', async () => {
    const ctx = setup();
    const job = jobWith(PAYLOAD);
    await ctx.handler(job);
    await ctx.handler(job);

    const paint = ctx.storage.ledger.claimNext('test-worker');
    expect(paint?.type).toBe('painter');
    expect(paint?.idempotency_key).toBe('painter:map:w1:edit-e1');
    expect(paint?.serial_group).toBe('painter:map:w1');
    const payload = z
      .strictObject({
        image_id: z.string(),
        region: z.strictObject({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        }),
        mask: z.array(z.strictObject({ x: z.number(), y: z.number() })),
      })
      .safeParse(paint?.payload);
    expect(payload.success).toBe(true);
    if (payload.success) {
      expect(payload.data.mask).toHaveLength(3);
      expect(payload.data.region.width).toBeGreaterThanOrEqual(32);
    }
    expect(ctx.storage.ledger.claimNext('test-worker')).toBeNull();
  });

  it('a malformed form fails the schema gate — operational throw, zero rows (gate 1, B6)', async () => {
    const ctx = setup(textClient('A pond sounds lovely, but no JSON from me.'));
    const before = ctx.storage.eventLog.readSince(0).length;
    await expect(ctx.handler(jobWith(PAYLOAD))).rejects.toMatchObject({
      kind: 'operational',
      code: 'map_edit_bad_form',
    });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(before);
  });

  it('a shape-valid form with extra keys is rejected, zero rows (B5 strict)', async () => {
    const ctx = setup(
      textClient(
        '{"name":"Pond","description":"Nice.","map_position":{"x":0,"y":0}}',
      ),
    );
    const before = ctx.storage.eventLog.readSince(0).length;
    await expect(ctx.handler(jobWith(PAYLOAD))).rejects.toMatchObject({
      kind: 'operational',
    });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(before);
  });

  it('an unknown world fails the engine-state gate — zero rows (gate 2)', async () => {
    const ctx = setup();
    const before = ctx.storage.eventLog.readSince(0).length;
    await expect(
      ctx.handler(jobWith(PAYLOAD, 'w-ghost')),
    ).rejects.toMatchObject({ kind: 'operational', code: 'world_not_found' });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(before);
  });

  it('a fog centroid fails the engine-state gate — zero rows (gate 2)', async () => {
    const ctx = setup();
    const before = ctx.storage.eventLog.readSince(0).length;
    await expect(
      ctx.handler(
        jobWith({
          ...PAYLOAD,
          points: [
            { x: 0.01, y: 0.01 },
            { x: 0.05, y: 0.01 },
            { x: 0.03, y: 0.05 },
          ],
        }),
      ),
    ).rejects.toMatchObject({ kind: 'operational', code: 'unexplored_ground' });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(before);
  });

  it('garbage payload is corrupt state, not input (Guide C2)', async () => {
    const ctx = setup();
    await expect(
      ctx.handler(jobWith({ wrong: 'shape' })),
    ).rejects.toMatchObject({ kind: 'corrupt_state' });
  });

  it('LLM failure surfaces as operational — nothing durable (B6)', async () => {
    const failing: LlmClient = {
      streamCall: async () =>
        Promise.resolve(err(new OperationalError('llm_down', '503'))),
    };
    const ctx = setup(failing);
    const before = ctx.storage.eventLog.readSince(0).length;
    await expect(ctx.handler(jobWith(PAYLOAD))).rejects.toMatchObject({
      kind: 'operational',
    });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(before);
  });

  it('the created no-op path still enqueues the paint (heals a kill between event and enqueue)', async () => {
    const ctx = setup();
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'sublocation.created',
      payload: {
        sublocation_id: 'subloc:edit-e1',
        name: 'The Mill Pond',
        description: 'A quiet pond.',
        map_position: { x: 0.42, y: 0.55 },
        footprint: TRIANGLE,
        edit_id: 'e1',
      },
    });
    await ctx.handler(jobWith(PAYLOAD));
    const paint = ctx.storage.ledger.claimNext('test-worker');
    expect(paint?.idempotency_key).toBe('painter:map:w1:edit-e1');
    // …and no second sublocation.created appeared.
    expect(
      ctx.storage.eventLog
        .readSince(0)
        .filter((e) => e.type === 'sublocation.created'),
    ).toHaveLength(1);
  });

  it('overlapping executions of ONE job commit exactly one row (lease-expiry overlap, week-7 painter class)', async () => {
    const release: (() => void)[] = [];
    const slow: LlmClient = {
      streamCall: async (): Promise<Result<LlmCallResult>> => {
        await new Promise<void>((r) => release.push(r));
        return ok({
          text: '{"name":"The Mill Pond","description":"A quiet pond."}',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          model: 'fake/slow',
          durationMs: 0,
          toolCalls: [],
        });
      },
    };
    const ctx = setup(slow);
    const job = jobWith(PAYLOAD);
    const first = ctx.handler(job);
    const second = ctx.handler({ ...job }); // the reclaimed re-execution
    while (release.length < 2) await new Promise((r) => setTimeout(r, 5));
    for (const r of release) r();
    await Promise.all([first, second]);

    const created = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'sublocation.created');
    expect(created).toHaveLength(1); // the loser no-oped at the fused re-check
    const paint = ctx.storage.ledger.claimNext('test-worker');
    expect(paint?.idempotency_key).toBe('painter:map:w1:edit-e1');
    expect(ctx.storage.ledger.claimNext('test-worker')).toBeNull();
  });
});
