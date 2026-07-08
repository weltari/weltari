import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { err, ok, OperationalError, type Result } from '../../errors.js';
import { buildEliasProfile } from '../../engine/fixture/rainy-inn.js';
import { createEventSink } from '../../engine/event-sink.js';
import { Bus } from '../../http/bus.js';
import { createFakeLlmClient } from '../../llm/fake-client.js';
import type { LlmCallResult, LlmClient } from '../../llm/types.js';
import { createRootLogger } from '../../observability/logger.js';
import { openStorage, type Storage } from '../../storage/db.js';
import type { LedgerJob } from '../../storage/repositories/ledger.js';
import { createReflectionHandler } from './reflection.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

const ELIAS = buildEliasProfile(100);

function jobWith(payload: unknown): LedgerJob {
  return {
    id: 1,
    idempotency_key: 'reflection:char:elias:s1',
    world_id: 'w1',
    type: 'reflection',
    payload,
    state: 'running',
    attempts: 1,
    max_attempts: 5,
    run_at: '2026-07-06T12:00:00.000Z',
    lease_until: '2026-07-06T12:01:00.000Z',
    worker_id: 'w',
    serial_group: null,
    last_error: null,
  };
}

describe('reflection job handler', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(llm?: LlmClient): {
    storage: Storage;
    handler: ReturnType<typeof createReflectionHandler>;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-reflection-'));
    const logger = quietLogger();
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const sink = createEventSink(storage, new Bus(logger));
    const handler = createReflectionHandler({
      storage,
      sink,
      llm: llm ?? createFakeLlmClient(),
      profiles: [ELIAS],
      logger,
    });
    return { storage, handler };
  }

  it('commits exactly one reflection.committed, even when re-run (kill-retry shape)', async () => {
    const ctx = setup();
    const job = jobWith({ scene_id: 's1', character_id: ELIAS.character_id });

    await ctx.handler(job);
    await ctx.handler(job); // the post-kill lease retry

    const reflections = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'reflection.committed');
    expect(reflections).toHaveLength(1);
    const first = reflections[0];
    if (first !== undefined) {
      expect(first.actor_id).toBe(ELIAS.character_id);
      expect(first.payload.scene_id).toBe('s1');
    }
  });

  it('overlapping executions of ONE job commit exactly one event (lease-expiry overlap, week-7 painter class)', async () => {
    // A slow generation can outlive its lease: the sweep reclaims the job and
    // a second execution runs while the first still awaits the provider. A
    // gated slow client interleaves two executions deliberately.
    const release: (() => void)[] = [];
    const slow: LlmClient = {
      streamCall: async (): Promise<Result<LlmCallResult>> => {
        await new Promise<void>((r) => release.push(r));
        return ok({
          text: 'A private thought.',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          model: 'fake/slow',
          durationMs: 0,
          toolCalls: [],
        });
      },
    };
    const ctx = setup(slow);
    const job = jobWith({ scene_id: 's1', character_id: ELIAS.character_id });
    const first = ctx.handler(job);
    const second = ctx.handler({ ...job }); // the reclaimed re-execution
    while (release.length < 2) await new Promise((r) => setTimeout(r, 5));
    for (const r of release) r();
    await Promise.all([first, second]);

    const reflections = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'reflection.committed');
    expect(reflections).toHaveLength(1); // the loser no-oped at the fused re-check
  });

  it('garbage payload is corrupt state, not input (Guide C2)', async () => {
    const ctx = setup();
    await expect(
      ctx.handler(jobWith({ wrong: 'shape' })),
    ).rejects.toMatchObject({ kind: 'corrupt_state' });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(0);
  });

  it('unknown character is a bug (parked, never retried)', async () => {
    const ctx = setup();
    await expect(
      ctx.handler(jobWith({ scene_id: 's1', character_id: 'char:ghost' })),
    ).rejects.toMatchObject({ kind: 'bug' });
  });

  it('LLM failure surfaces as operational — nothing durable (B6)', async () => {
    const failing: LlmClient = {
      streamCall: async () =>
        Promise.resolve(err(new OperationalError('llm_down', '503'))),
    };
    const ctx = setup(failing);
    await expect(
      ctx.handler(
        jobWith({ scene_id: 's1', character_id: ELIAS.character_id }),
      ),
    ).rejects.toMatchObject({ kind: 'operational' });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(0);
  });
});
