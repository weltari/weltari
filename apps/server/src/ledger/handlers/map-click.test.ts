import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { err, ok, OperationalError, type Result } from '../../errors.js';
import { buildNarratorProfile } from '../../engine/fixture/rainy-inn.js';
import { createEventSink } from '../../engine/event-sink.js';
import { knownSublocations } from '../../engine/sublocations.js';
import { Bus } from '../../http/bus.js';
import {
  createFakeLlmClient,
  createFakeVlmClient,
} from '../../llm/fake-client.js';
import type { LlmCallResult, LlmClient } from '../../llm/types.js';
import type { VlmCallResult, VlmClient } from '../../llm/vlm.js';
import { createRootLogger } from '../../observability/logger.js';
import { openStorage, type Storage } from '../../storage/db.js';
import type { LedgerJob } from '../../storage/repositories/ledger.js';
import { createMapClickHandler } from './map-click.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

const NARRATOR = buildNarratorProfile(100);

function vlmClient(text: string): VlmClient {
  return {
    describe: async (): Promise<Result<VlmCallResult>> =>
      Promise.resolve(
        ok({
          text,
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          model: 'fake/scripted-vlm',
          durationMs: 0,
        }),
      ),
  };
}

function llmClient(text: string): LlmClient {
  return {
    streamCall: async (): Promise<Result<LlmCallResult>> =>
      Promise.resolve(
        ok({
          text,
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          model: 'fake/scripted',
          durationMs: 0,
          toolCalls: [],
        }),
      ),
  };
}

// A far corner of the explored common-room square (3,4): outside the anchor's
// radius, so the command classified instead of entering.
const PAYLOAD = {
  click_id: 'c1',
  point: { x: 0.495, y: 0.505 },
  requested_by: 'user:owner',
};

function jobWith(payload: unknown, worldId = 'w1'): LedgerJob {
  return {
    id: 1,
    idempotency_key: 'map_click:w1:c1',
    world_id: worldId,
    type: 'map_click',
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

describe('map_click job handler (Flow B, double-gated twice)', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(overrides?: { llm?: LlmClient; vlm?: VlmClient }): {
    storage: Storage;
    handler: ReturnType<typeof createMapClickHandler>;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-mapclick-handler-'));
    const logger = quietLogger();
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const sink = createEventSink(storage, new Bus(logger));
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'scene.started',
      payload: { scene_id: 's-seed', title: 'Seed' },
    });
    const handler = createMapClickHandler({
      storage,
      sink,
      llm: overrides?.llm ?? createFakeLlmClient(),
      vlm: overrides?.vlm ?? createFakeVlmClient(),
      narrator: NARRATOR,
      imagesDir: join(dir, 'images'),
      logger,
    });
    return { storage, handler };
  }

  it('a persistent invention appends ONE map_click.resolved that IS the sublocation row', async () => {
    const ctx = setup(); // fake story invention is persistent
    const job = jobWith(PAYLOAD);
    await ctx.handler(job);
    await ctx.handler(job); // the post-kill lease retry

    const events = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'map_click.resolved');
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event?.type === 'map_click.resolved') {
      expect(event.actor_id).toBe('user:owner');
      expect(event.payload.outcome).toBe('created');
      expect(event.payload.sublocation_id).toBe('subloc:click-c1');
      expect(event.payload.point).toEqual(PAYLOAD.point);
    }
    // The registry projects it — the spawn is enterable and radius-carrying.
    const known = knownSublocations(ctx.storage, 'w1');
    expect(known.some((s) => s.sublocation_id === 'subloc:click-c1')).toBe(
      true,
    );
  });

  it('a transient invention resolves and vanishes — no sublocation, ever', async () => {
    const ctx = setup({
      llm: llmClient(
        '{"name":"A startled deer","description":"It bolts before you get close.","persistence":"transient"}',
      ),
    });
    await ctx.handler(jobWith(PAYLOAD));

    const events = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'map_click.resolved');
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event?.type === 'map_click.resolved') {
      expect(event.payload.outcome).toBe('transient');
      expect(event.payload.sublocation_id).toBeUndefined();
    }
    const known = knownSublocations(ctx.storage, 'w1');
    expect(known.some((s) => s.sublocation_id.startsWith('subloc:click'))).toBe(
      false,
    );
  });

  it('a garbage classification fails gate 1 — operational throw, zero rows', async () => {
    const ctx = setup({
      vlm: vlmClient('Lovely meadow! Definitely walkable. No JSON though.'),
    });
    const before = ctx.storage.eventLog.readSince(0).length;
    await expect(ctx.handler(jobWith(PAYLOAD))).rejects.toMatchObject({
      kind: 'operational',
      code: 'map_click_bad_classification',
    });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(before);
  });

  it('a classification claiming BOTH terrain and building is rejected (exactly one)', async () => {
    const ctx = setup({
      vlm: vlmClient(
        '{"terrain_type":"meadow","building_type":"barn","is_enterable":true,"suggested_setting":"x","style_tags":[]}',
      ),
    });
    await expect(ctx.handler(jobWith(PAYLOAD))).rejects.toMatchObject({
      code: 'map_click_bad_classification',
    });
  });

  it('a garbage story invention fails gate 1 — operational throw, zero rows', async () => {
    const ctx = setup({
      llm: llmClient('A deer! How magical. But I refuse to emit JSON.'),
    });
    const before = ctx.storage.eventLog.readSince(0).length;
    await expect(ctx.handler(jobWith(PAYLOAD))).rejects.toMatchObject({
      kind: 'operational',
      code: 'map_click_bad_invention',
    });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(before);
  });

  it('VLM provider failure surfaces as operational — nothing durable', async () => {
    const failing: VlmClient = {
      describe: async () =>
        Promise.resolve(err(new OperationalError('vlm_call_failed', '503'))),
    };
    const ctx = setup({ vlm: failing });
    const before = ctx.storage.eventLog.readSince(0).length;
    await expect(ctx.handler(jobWith(PAYLOAD))).rejects.toMatchObject({
      kind: 'operational',
    });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(before);
  });

  it('garbage payload is corrupt state, not input (Guide C2)', async () => {
    const ctx = setup();
    await expect(
      ctx.handler(jobWith({ wrong: 'shape' })),
    ).rejects.toMatchObject({ kind: 'corrupt_state' });
  });

  it('overlapping executions of ONE job commit exactly one event (lease-expiry overlap)', async () => {
    const release: (() => void)[] = [];
    const slow: LlmClient = {
      streamCall: async (): Promise<Result<LlmCallResult>> => {
        await new Promise<void>((r) => release.push(r));
        return ok({
          text: '{"name":"The Heron Shallows","description":"A gravel shallows.","persistence":"persistent"}',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          model: 'fake/slow',
          durationMs: 0,
          toolCalls: [],
        });
      },
    };
    const ctx = setup({ llm: slow });
    const job = jobWith(PAYLOAD);
    const first = ctx.handler(job);
    const second = ctx.handler({ ...job }); // the reclaimed re-execution
    while (release.length < 2) await new Promise((r) => setTimeout(r, 5));
    for (const r of release) r();
    await Promise.all([first, second]);

    const events = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'map_click.resolved');
    expect(events).toHaveLength(1); // the loser no-oped at the fused re-check
  });
});
