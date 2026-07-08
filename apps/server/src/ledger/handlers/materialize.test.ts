import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { err, ok, OperationalError, type Result } from '../../errors.js';
import { buildNarratorProfile } from '../../engine/fixture/rainy-inn.js';
import { createEventSink } from '../../engine/event-sink.js';
import { Bus } from '../../http/bus.js';
import { createFakeLlmClient } from '../../llm/fake-client.js';
import type { LlmCallResult, LlmClient } from '../../llm/types.js';
import { createRootLogger } from '../../observability/logger.js';
import { openStorage, type Storage } from '../../storage/db.js';
import type { LedgerJob } from '../../storage/repositories/ledger.js';
import { createMaterializeHandler } from './materialize.js';

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

function jobWith(payload: unknown, worldId = 'w1'): LedgerJob {
  return {
    id: 1,
    idempotency_key: 'materialize:w1:5:1',
    world_id: worldId,
    type: 'materialize',
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

describe('materialize job handler (B6 double gate)', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(llm?: LlmClient): {
    storage: Storage;
    handler: ReturnType<typeof createMaterializeHandler>;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-materialize-'));
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
    const handler = createMaterializeHandler({
      storage,
      sink,
      llm: llm ?? createFakeLlmClient(),
      narrator: NARRATOR,
      logger,
    });
    return { storage, handler };
  }

  it('appends exactly one sublocation.materialized, even re-run (kill-retry shape)', async () => {
    const ctx = setup();
    const job = jobWith({ square: { col: 5, row: 1 } });

    await ctx.handler(job);
    await ctx.handler(job); // the post-kill lease retry

    const materialized = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'sublocation.materialized');
    expect(materialized).toHaveLength(1);
    const first = materialized[0];
    if (first?.type === 'sublocation.materialized') {
      expect(first.payload.sublocation_id).toBe('subloc:sq-5-1');
      expect(first.payload.square).toEqual({ col: 5, row: 1 });
      // Pin anchor = square center, world coordinates (UI Spec §1.8).
      expect(first.payload.map_position).toEqual({ x: 0.6875, y: 0.1875 });
      expect(first.payload.name.length).toBeGreaterThan(0);
      expect(first.payload.description.length).toBeGreaterThan(0);
    }
  });

  it('a fixture-occupied square is an idempotent no-op, zero rows (gate 2)', async () => {
    const ctx = setup();
    const before = ctx.storage.eventLog.readSince(0).length;
    // subloc:common_room (0.42, 0.55) sits in square (3, 4).
    await ctx.handler(jobWith({ square: { col: 3, row: 4 } }));
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(before);
  });

  it('a malformed stub fails the schema gate — operational throw, zero rows (gate 1, B6)', async () => {
    const ctx = setup(textClient('The pond is nice, I refuse to emit JSON.'));
    const before = ctx.storage.eventLog.readSince(0).length;
    await expect(
      ctx.handler(jobWith({ square: { col: 5, row: 1 } })),
    ).rejects.toMatchObject({
      kind: 'operational',
      code: 'materialize_bad_stub',
    });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(before);
  });

  it('a shape-valid stub with extra keys is rejected, zero rows (B5 strict)', async () => {
    const ctx = setup(
      textClient(
        '{"name":"Pond","description":"Nice.","backdrop_path":"sneaky.webp"}',
      ),
    );
    const before = ctx.storage.eventLog.readSince(0).length;
    await expect(
      ctx.handler(jobWith({ square: { col: 5, row: 1 } })),
    ).rejects.toMatchObject({ kind: 'operational' });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(before);
  });

  it('a fenced JSON stub still parses (models add fences despite instructions)', async () => {
    const ctx = setup(
      textClient('```json\n{"name":"Pond","description":"Nice."}\n```'),
    );
    await ctx.handler(jobWith({ square: { col: 5, row: 1 } }));
    const materialized = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'sublocation.materialized');
    expect(materialized).toHaveLength(1);
  });

  it('an unknown world fails the engine-state gate — zero rows (gate 2)', async () => {
    const ctx = setup();
    const before = ctx.storage.eventLog.readSince(0).length;
    await expect(
      ctx.handler(jobWith({ square: { col: 5, row: 1 } }, 'w-ghost')),
    ).rejects.toMatchObject({ kind: 'operational', code: 'world_not_found' });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(before);
  });

  it('garbage payload is corrupt state, not input (Guide C2)', async () => {
    const ctx = setup();
    await expect(
      ctx.handler(jobWith({ wrong: 'shape' })),
    ).rejects.toMatchObject({ kind: 'corrupt_state' });
  });

  it('a successful materialize eagerly enqueues ONE painter job for its square (M5)', async () => {
    const ctx = setup();
    const job = jobWith({ square: { col: 5, row: 1 } });
    await ctx.handler(job);
    await ctx.handler(job); // retry converges: still one paint job

    const paint = ctx.storage.ledger.claimNext('test-worker');
    expect(paint?.type).toBe('painter');
    expect(paint?.idempotency_key).toBe('painter:map:w1:sq-5-1');
    // Square (5,1) on the 512² base with the 8×8 grid → 64 px rect at (320,64).
    expect(paint?.payload).toEqual({
      image_id: 'map:w1',
      region: { x: 320, y: 64, width: 64, height: 64 },
    });
    // …and exactly one: nothing else is claimable.
    expect(ctx.storage.ledger.claimNext('test-worker')).toBeNull();
  });

  it('the occupied no-op path still enqueues the paint (heals a kill between event and enqueue)', async () => {
    const ctx = setup();
    // subloc:common_room (0.42, 0.55) sits in square (3, 4) — occupied.
    await ctx.handler(jobWith({ square: { col: 3, row: 4 } }));
    const paint = ctx.storage.ledger.claimNext('test-worker');
    expect(paint?.type).toBe('painter');
    expect(paint?.idempotency_key).toBe('painter:map:w1:sq-3-4');
  });

  it('LLM failure surfaces as operational — nothing durable (B6)', async () => {
    const failing: LlmClient = {
      streamCall: async () =>
        Promise.resolve(err(new OperationalError('llm_down', '503'))),
    };
    const ctx = setup(failing);
    const before = ctx.storage.eventLog.readSince(0).length;
    await expect(
      ctx.handler(jobWith({ square: { col: 5, row: 1 } })),
    ).rejects.toMatchObject({ kind: 'operational' });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(before);
  });
});
