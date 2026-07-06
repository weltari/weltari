import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNarratorProfile } from '../../engine/fixture/rainy-inn.js';
import { createEventSink } from '../../engine/event-sink.js';
import { Bus } from '../../http/bus.js';
import { createFakeLlmClient } from '../../llm/fake-client.js';
import { createRootLogger } from '../../observability/logger.js';
import { openStorage, type Storage } from '../../storage/db.js';
import type { LedgerJob } from '../../storage/repositories/ledger.js';
import { createWorldAgentHandler } from './world-agent.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

function jobWith(payload: unknown): LedgerJob {
  return {
    id: 2,
    idempotency_key: 'world_agent:s1',
    world_id: 'w1',
    type: 'world_agent',
    payload,
    state: 'running',
    attempts: 1,
    max_attempts: 5,
    run_at: '2026-07-06T12:00:00.000Z',
    lease_until: '2026-07-06T12:01:00.000Z',
    worker_id: 'w',
    serial_group: 'world_agent:w1',
    last_error: null,
  };
}

describe('world agent job handler', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(): {
    storage: Storage;
    handler: ReturnType<typeof createWorldAgentHandler>;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-worldagent-'));
    const logger = quietLogger();
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const sink = createEventSink(storage, new Bus(logger));
    const handler = createWorldAgentHandler({
      storage,
      sink,
      llm: createFakeLlmClient(),
      narrator: buildNarratorProfile(100),
      logger,
    });
    return { storage, handler };
  }

  it('commits exactly one world_agent.committed, even when re-run', async () => {
    const ctx = setup();
    const job = jobWith({ scene_id: 's1' });

    await ctx.handler(job);
    await ctx.handler(job);

    const notes = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'world_agent.committed');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.actor_id).toBe('system:world_agent');
  });

  it('garbage payload is corrupt state (Guide C2)', async () => {
    const ctx = setup();
    await expect(ctx.handler(jobWith(42))).rejects.toMatchObject({
      kind: 'corrupt_state',
    });
  });
});
