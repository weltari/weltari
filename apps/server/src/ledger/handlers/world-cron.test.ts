// Lease-expiry overlap regression for the world-cron handlers (week-8: the
// week-7 painter bug class, docs/painter.md). The scheduling behaviour itself
// is covered in engine/world-clock.test.ts — this file only proves that two
// interleaved executions of ONE occurrence commit exactly one event.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ok, type Result } from '../../errors.js';
import { buildNarratorProfile } from '../../engine/fixture/rainy-inn.js';
import { createEventSink } from '../../engine/event-sink.js';
import { Bus } from '../../http/bus.js';
import type { LlmCallResult, LlmClient } from '../../llm/types.js';
import { createRootLogger } from '../../observability/logger.js';
import { openStorage, type Storage } from '../../storage/db.js';
import type { LedgerJob } from '../../storage/repositories/ledger.js';
import {
  createWorldCronCodeHandler,
  createWorldCronLlmHandler,
} from './world-cron.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

const PAYLOAD = {
  cron_type: 'market_day',
  scheduled_for: '2000-01-07T12:00:00.000Z',
};

function jobWith(type: 'world_cron.code' | 'world_cron.llm'): LedgerJob {
  return {
    id: 4,
    idempotency_key: 'wcron:market_day:2000-01-07T12:00:00.000Z',
    world_id: 'w1',
    type,
    payload: PAYLOAD,
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

describe('world-cron handlers under lease-expiry overlap', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function open(): {
    storage: Storage;
    logger: ReturnType<typeof quietLogger>;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-wcron-'));
    const logger = quietLogger();
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    return { storage, logger };
  }

  it('llm handler: overlapping executions of ONE occurrence commit exactly one event', async () => {
    const ctx = open();
    const release: (() => void)[] = [];
    const slow: LlmClient = {
      streamCall: async (): Promise<Result<LlmCallResult>> => {
        await new Promise<void>((r) => release.push(r));
        return ok({
          text: 'The market stalls close at dusk.',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          model: 'fake/slow',
          durationMs: 0,
          toolCalls: [],
        });
      },
    };
    const handler = createWorldCronLlmHandler({
      storage: ctx.storage,
      sink: createEventSink(ctx.storage, new Bus(ctx.logger)),
      llm: slow,
      narrator: buildNarratorProfile(100),
      logger: ctx.logger,
    });
    const job = jobWith('world_cron.llm');
    const first = handler(job);
    const second = handler({ ...job }); // the reclaimed re-execution
    while (release.length < 2) await new Promise((r) => setTimeout(r, 5));
    for (const r of release) r();
    await Promise.all([first, second]);

    const completed = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'world_cron.completed');
    expect(completed).toHaveLength(1); // the loser no-oped at the fused re-check
  });

  it('code handler: overlapping executions of ONE occurrence commit exactly one event', async () => {
    // The code handler's only await is its fault point — gate it there so two
    // executions interleave between the claim check and the append.
    const ctx = open();
    const release: (() => void)[] = [];
    const handler = createWorldCronCodeHandler({
      storage: ctx.storage,
      sink: createEventSink(ctx.storage, new Bus(ctx.logger)),
      logger: ctx.logger,
      faultPoint: async (): Promise<void> => {
        await new Promise<void>((r) => release.push(r));
      },
    });
    const job = jobWith('world_cron.code');
    const first = handler(job);
    const second = handler({ ...job }); // the reclaimed re-execution
    while (release.length < 2) await new Promise((r) => setTimeout(r, 5));
    for (const r of release) r();
    await Promise.all([first, second]);

    const completed = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'world_cron.completed');
    expect(completed).toHaveLength(1); // the loser no-oped at the fused re-check
  });
});
