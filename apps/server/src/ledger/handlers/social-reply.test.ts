// The social_reply handler (M6 part 5): answer-only comment-thread answers —
// one per user reply (natural key in_reply_to), the answerer's social CACHE
// riding the same transaction, the whole thread in the prompt.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { Result } from '../../errors.js';
import {
  buildEliasProfile,
  buildMaraProfile,
} from '../../engine/fixture/rainy-inn.js';
import { createEventSink } from '../../engine/event-sink.js';
import { Bus } from '../../http/bus.js';
import { createFakeLlmClient } from '../../llm/fake-client.js';
import type { LlmCall, LlmCallResult, LlmClient } from '../../llm/types.js';
import { createRootLogger } from '../../observability/logger.js';
import { openStorage, type Storage } from '../../storage/db.js';
import type { LedgerJob } from '../../storage/repositories/ledger.js';
import { createSocialReplyHandler } from './social-reply.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

const POST_ID = 'post-abc123';
const COMMENT_ID = `${POST_ID}:char:mara`;

function job(id = 1, replyId = 'req-1'): LedgerJob {
  return {
    id,
    idempotency_key: `social_reply:${replyId}`,
    world_id: 'w1',
    type: 'social_reply',
    payload: {
      post_id: POST_ID,
      reaction_id: COMMENT_ID,
      reply_id: replyId,
      character_id: 'char:mara',
    },
    state: 'running',
    attempts: 1,
    max_attempts: 5,
    run_at: '2026-07-11T10:00:00.000Z',
    lease_until: '2026-07-11T10:01:00.000Z',
    worker_id: 'w',
    serial_group: 'social:w1:char:mara',
    last_error: null,
  };
}

describe('social_reply job handler', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(llm?: LlmClient): {
    storage: Storage;
    handler: ReturnType<typeof createSocialReplyHandler>;
    llmCalls: LlmCall[];
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-social-reply-'));
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
    const handler = createSocialReplyHandler({
      storage,
      sink,
      llm: recording,
      profiles: [buildEliasProfile(100), buildMaraProfile()],
      logger,
    });
    return { storage, handler, llmCalls };
  }

  function seedThread(target: Storage): void {
    target.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:elias',
      type: 'social.post_committed',
      payload: {
        post_id: POST_ID,
        occurrence_iso: '2000-01-02T00:00:00.000Z',
        game_time: '2000-01-02T08:00:00.000Z',
        character_id: 'char:elias',
        body: 'Roof beams up before the rain came back.',
        recipient_ids: ['char:mara'],
      },
    });
    target.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:mara',
      type: 'social.reaction_committed',
      payload: {
        post_id: POST_ID,
        reaction_id: COMMENT_ID,
        character_id: 'char:mara',
        kind: 'comment',
        body: 'Rain never asks the river first.',
      },
    });
    target.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'social.reply_posted',
      payload: {
        post_id: POST_ID,
        reaction_id: COMMENT_ID,
        reply_id: 'req-1',
        body: 'What did the eels say about it?',
      },
    });
  }

  function answers(target: Storage): number {
    return target.eventLog
      .readSince(0)
      .filter((e) => e.type === 'social.reply_answered').length;
  }

  it('answers exactly once with the CACHE riding the transaction — re-run is a no-op', async () => {
    const ctx = setup();
    seedThread(ctx.storage);

    await ctx.handler(job());
    await ctx.handler(job(2)); // the post-kill lease retry

    expect(answers(ctx.storage)).toBe(1);
    const events = ctx.storage.eventLog.readSince(0);
    const answer = events.find((e) => e.type === 'social.reply_answered');
    if (answer?.type !== 'social.reply_answered') throw new Error('no answer');
    expect(answer.payload.in_reply_to).toBe('req-1');
    expect(answer.payload.character_id).toBe('char:mara');
    expect(answer.payload.body.length).toBeGreaterThan(0);
    const cache = events.find(
      (e) =>
        e.type === 'cache.appended' &&
        e.payload.character_id === 'char:mara' &&
        e.payload.origin === 'social',
    );
    expect(cache).toBeDefined();
    // Answer-only: the toolset carries nothing but cache; the thread rode
    // the prompt (post + comment + the user's reply).
    expect(ctx.llmCalls[0]?.kind).toBe('social_reply');
    expect(ctx.llmCalls[0]?.toolset).toBe('social_reply');
    expect(ctx.llmCalls[0]?.prompt).toContain('Roof beams up');
    expect(ctx.llmCalls[0]?.prompt).toContain('Rain never asks');
    expect(ctx.llmCalls[0]?.prompt).toContain('What did the eels say');
  });

  it('a second user reply gets its own answer; the earlier exchange rides the prompt', async () => {
    const ctx = setup();
    seedThread(ctx.storage);
    await ctx.handler(job());
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'social.reply_posted',
      payload: {
        post_id: POST_ID,
        reaction_id: COMMENT_ID,
        reply_id: 'req-2',
        body: 'And when it holds through a real storm?',
      },
    });
    await ctx.handler(job(2, 'req-2'));
    expect(answers(ctx.storage)).toBe(2);
    expect(ctx.llmCalls[1]?.prompt).toContain('What did the eels say'); // history
    expect(ctx.llmCalls[1]?.prompt).toContain('when it holds through'); // the new reply
  });

  it('an empty generation is operational — the runner will retry, nothing durable', async () => {
    const empty: LlmClient = {
      async streamCall(): Promise<Result<LlmCallResult>> {
        await Promise.resolve();
        return {
          ok: true,
          value: {
            text: '',
            usage: { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0 },
            model: 'stub',
            durationMs: 0,
            toolCalls: [],
          },
        };
      },
    };
    const ctx = setup(empty);
    seedThread(ctx.storage);
    await expect(ctx.handler(job())).rejects.toThrow(/empty answer/);
    expect(answers(ctx.storage)).toBe(0);
  });

  it('a missing post/comment is corrupt state; an unknown character is a quiet no-op', async () => {
    const ctx = setup();
    await expect(ctx.handler(job())).rejects.toThrow(/not in the log/);

    seedThread(ctx.storage);
    await ctx.handler({
      ...job(2),
      payload: {
        post_id: POST_ID,
        reaction_id: COMMENT_ID,
        reply_id: 'req-1',
        character_id: 'char:ghost',
      },
    });
    expect(answers(ctx.storage)).toBe(0);
  });
});
