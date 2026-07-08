// Invariant I8 extended to the materialize job (M4 part 2, Guide B6): the
// LLM's sublocation stub is never directly durable. Gate 1 rejects a stub
// that fails the schema; gate 2 rejects a shape-valid stub against game state
// (square occupied, world unknown). Every rejection writes ZERO rows — the
// only durable outcome is one sublocation.materialized per square, ever.
// Asserted through public seams (event-log reads) — never handler internals.
import { describe, expect, it } from 'vitest';
import { Bus } from '../../apps/server/src/http/bus.js';
import { createEventSink } from '../../apps/server/src/engine/event-sink.js';
import { buildNarratorProfile } from '../../apps/server/src/engine/fixture/rainy-inn.js';
import { createMaterializeHandler } from '../../apps/server/src/ledger/handlers/materialize.js';
import { createFakeLlmClient } from '../../apps/server/src/llm/fake-client.js';
import type {
  LlmCallResult,
  LlmClient,
} from '../../apps/server/src/llm/types.js';
import { ok, type Result } from '../../apps/server/src/errors.js';
import type { LedgerJob } from '../../apps/server/src/storage/repositories/ledger.js';
import type { Storage } from '../../apps/server/src/storage/db.js';
import { captureLogger } from '../helpers/capture-logger.js';
import { tempStorage } from '../helpers/temp-storage.js';

function textClient(text: string): LlmClient {
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

function materializeJob(square: { col: number; row: number }): LedgerJob {
  return {
    id: 1,
    idempotency_key: `materialize:w1:${String(square.col)}:${String(square.row)}`,
    world_id: 'w1',
    type: 'materialize',
    payload: { square },
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

function setup(llm: LlmClient): {
  storage: Storage;
  handler: ReturnType<typeof createMaterializeHandler>;
} {
  const { logger } = captureLogger();
  const storage = tempStorage();
  storage.eventLog.append({
    world_id: 'w1',
    actor_id: 'system:engine',
    type: 'scene.started',
    payload: { scene_id: 's-seed', title: 'Seed' },
  });
  const handler = createMaterializeHandler({
    storage,
    sink: createEventSink(storage, new Bus(logger)),
    llm,
    narrator: buildNarratorProfile(100),
    logger,
  });
  return { storage, handler };
}

describe('I8 — the materialize B6 double gate writes zero rows on rejection', () => {
  it('gate 1 (schema): prose instead of a JSON stub — operational throw, zero rows', async () => {
    const ctx = setup(textClient('A lovely meadow, but not JSON.'));
    const before = ctx.storage.eventLog.readSince(0).length;
    await expect(
      ctx.handler(materializeJob({ col: 5, row: 1 })),
    ).rejects.toMatchObject({ kind: 'operational' });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(before);
    ctx.storage.close();
  });

  it('gate 1 (schema): a stub smuggling extra keys is rejected, zero rows (B5)', async () => {
    const ctx = setup(
      textClient(
        '{"name":"Pond","description":"Nice.","actor_id":"user:evil"}',
      ),
    );
    const before = ctx.storage.eventLog.readSince(0).length;
    await expect(
      ctx.handler(materializeJob({ col: 5, row: 1 })),
    ).rejects.toMatchObject({ kind: 'operational' });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(before);
    ctx.storage.close();
  });

  it('gate 2 (state): a valid stub for an occupied square writes zero rows', async () => {
    // Shape-valid output — but subloc:common_room already occupies (3, 4).
    const ctx = setup(
      textClient('{"name":"Twin Inn","description":"A copy."}'),
    );
    const before = ctx.storage.eventLog.readSince(0).length;
    await ctx.handler(materializeJob({ col: 3, row: 4 }));
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(before);
    ctx.storage.close();
  });

  it('one square materializes exactly once across kill-shaped retries', async () => {
    const ctx = setup(createFakeLlmClient());
    const job = materializeJob({ col: 5, row: 1 });
    await ctx.handler(job);
    await ctx.handler(job); // post-kill lease retry
    await ctx.handler(job); // paranoid third pass
    const reveals = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'sublocation.materialized');
    expect(reveals).toHaveLength(1);
    ctx.storage.close();
  });
});
