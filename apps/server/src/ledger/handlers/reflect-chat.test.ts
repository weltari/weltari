// The reflect_chat handler (M6 part 2, Rev 4 §8): idempotent per
// (conversation, range_end_id) with the fused lease-overlap re-check —
// the same triad every natural-key handler carries (docs/ledger.md).
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
import type { LlmCall, LlmCallResult, LlmClient } from '../../llm/types.js';
import { createRootLogger } from '../../observability/logger.js';
import { openStorage, type Storage } from '../../storage/db.js';
import type { LedgerJob } from '../../storage/repositories/ledger.js';
import { createReflectChatHandler } from './reflect-chat.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

const ELIAS = buildEliasProfile(100);
const CONVERSATION = 'chat:user:owner:char:elias';

function jobWith(payload: unknown): LedgerJob {
  return {
    id: 1,
    idempotency_key: `reflect_chat:${CONVERSATION}:2`,
    world_id: 'w1',
    type: 'reflect_chat',
    payload,
    state: 'running',
    attempts: 1,
    max_attempts: 5,
    run_at: '2026-07-09T12:00:00.000Z',
    lease_until: '2026-07-09T12:01:00.000Z',
    worker_id: 'w',
    serial_group: null,
    last_error: null,
  };
}

describe('reflect_chat job handler', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(llm?: LlmClient): {
    storage: Storage;
    handler: ReturnType<typeof createReflectChatHandler>;
    llmCalls: LlmCall[];
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-reflect-chat-'));
    const logger = quietLogger();
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const sink = createEventSink(storage, new Bus(logger));
    const llmCalls: LlmCall[] = [];
    const base = llm ?? createFakeLlmClient();
    const recording: LlmClient = {
      async streamCall(call): Promise<Result<LlmCallResult>> {
        llmCalls.push(call);
        return base.streamCall(call);
      },
    };
    const handler = createReflectChatHandler({
      storage,
      sink: sink,
      llm: recording,
      profiles: [ELIAS],
      logger,
    });
    return { storage, handler, llmCalls };
  }

  function seedConversation(target: Storage): number {
    target.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'chat.message_committed',
      payload: {
        conversation_id: CONVERSATION,
        character_id: ELIAS.character_id,
        sender: 'user',
        text: 'Evening. Ferry running tomorrow?',
        message_id: 'm-1',
      },
    });
    const reply = target.eventLog.append({
      world_id: 'w1',
      actor_id: ELIAS.character_id,
      type: 'chat.message_committed',
      payload: {
        conversation_id: CONVERSATION,
        character_id: ELIAS.character_id,
        sender: 'character',
        text: 'If the river drops. Come by early.',
        message_id: 'm-2',
      },
    });
    return reply.id;
  }

  it('commits exactly one reflect_chat.committed, even when re-run (kill-retry shape)', async () => {
    const ctx = setup();
    const rangeEnd = seedConversation(ctx.storage);
    const job = jobWith({
      conversation_id: CONVERSATION,
      character_id: ELIAS.character_id,
      range_end_id: rangeEnd,
    });

    await ctx.handler(job);
    await ctx.handler(job); // the post-kill lease retry

    const reflected = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'reflect_chat.committed');
    expect(reflected).toHaveLength(1);
    const first = reflected[0];
    if (first?.type === 'reflect_chat.committed') {
      expect(first.actor_id).toBe(ELIAS.character_id);
      expect(first.payload.range_end_id).toBe(rangeEnd);
      expect(first.payload.summary.length).toBeGreaterThan(0);
    }
    // The prompt read the RANGE transcript (conversation heading + lines).
    const call = ctx.llmCalls[0];
    expect(call?.kind).toBe('reflect_chat');
    expect(call?.prompt).toContain('## Conversation');
    expect(call?.prompt).toContain('Ferry running tomorrow?');
  });

  it('overlapping executions of ONE job commit exactly one event (fused re-check)', async () => {
    const release: (() => void)[] = [];
    const slow: LlmClient = {
      streamCall: async (): Promise<Result<LlmCallResult>> => {
        await new Promise<void>((r) => release.push(r));
        return ok({
          text: 'A private chat thought.',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          model: 'fake/slow',
          durationMs: 0,
          toolCalls: [],
        });
      },
    };
    const ctx = setup(slow);
    const rangeEnd = seedConversation(ctx.storage);
    const job = jobWith({
      conversation_id: CONVERSATION,
      character_id: ELIAS.character_id,
      range_end_id: rangeEnd,
    });
    const first = ctx.handler(job);
    const second = ctx.handler({ ...job }); // the reclaimed re-execution
    while (release.length < 2) await new Promise((r) => setTimeout(r, 5));
    for (const r of release) r();
    await Promise.all([first, second]);

    expect(
      ctx.storage.eventLog
        .readSince(0)
        .filter((e) => e.type === 'reflect_chat.committed'),
    ).toHaveLength(1);
  });

  it('garbage payload is corrupt state; unknown character is a bug (C2/C7)', async () => {
    const ctx = setup();
    await expect(
      ctx.handler(jobWith({ wrong: 'shape' })),
    ).rejects.toMatchObject({ kind: 'corrupt_state' });
    await expect(
      ctx.handler(
        jobWith({
          conversation_id: CONVERSATION,
          character_id: 'char:ghost',
          range_end_id: 2,
        }),
      ),
    ).rejects.toMatchObject({ kind: 'bug' });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(0);
  });

  it('LLM failure surfaces as operational — nothing durable (B6)', async () => {
    const failing: LlmClient = {
      streamCall: async () =>
        Promise.resolve(err(new OperationalError('llm_down', '503'))),
    };
    const ctx = setup(failing);
    const rangeEnd = seedConversation(ctx.storage);
    await expect(
      ctx.handler(
        jobWith({
          conversation_id: CONVERSATION,
          character_id: ELIAS.character_id,
          range_end_id: rangeEnd,
        }),
      ),
    ).rejects.toMatchObject({ kind: 'operational' });
    expect(
      ctx.storage.eventLog
        .readSince(0)
        .some((e) => e.type === 'reflect_chat.committed'),
    ).toBe(false);
  });
});
