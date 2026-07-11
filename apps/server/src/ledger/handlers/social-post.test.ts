// The social_post handler (M6 part 5, Rev 4 §12): eager generation at the
// cadence fire, idempotent per (world, occurrence_iso) with the fused
// lease-overlap re-check, acquaintance delivery, and the ATOMIC reaction
// fan-out — the standing natural-key triad (proactive-dm is the sibling).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ok, type Result } from '../../errors.js';
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
import { createSocialPostHandler } from './social-post.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

const ELIAS = buildEliasProfile(100);
const MARA = buildMaraProfile();
const OCCURRENCE = '2000-01-02T00:00:00.000Z';

function fire(occurrenceIso = OCCURRENCE, id = 1): LedgerJob {
  return {
    id,
    idempotency_key: `social_post:w1:${occurrenceIso}`,
    world_id: 'w1',
    type: 'social_post',
    payload: { occurrence_iso: occurrenceIso },
    state: 'running',
    attempts: 1,
    max_attempts: 5,
    run_at: occurrenceIso,
    lease_until: '2026-07-11T10:01:00.000Z',
    worker_id: 'w',
    serial_group: 'social_post:w1',
    last_error: null,
  };
}

describe('social_post job handler', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(
    llm?: LlmClient,
    reactionCap = 4,
  ): {
    storage: Storage;
    handler: ReturnType<typeof createSocialPostHandler>;
    llmCalls: LlmCall[];
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-social-post-'));
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
    const handler = createSocialPostHandler({
      storage,
      sink,
      llm: recording,
      profiles: [ELIAS, MARA],
      reactionCap,
      logger,
    });
    return { storage, handler, llmCalls };
  }

  function acquaint(target: Storage, group = 'g1'): void {
    target.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'chat.group_started',
      payload: {
        conversation_id: group,
        member_ids: ['char:elias', 'char:mara'],
        title: 'The riverside crowd',
      },
    });
  }

  function posts(target: Storage): number {
    return target.eventLog
      .readSince(0)
      .filter((e) => e.type === 'social.post_committed').length;
  }

  it('a fire commits the post + social CACHE and enqueues reaction jobs atomically — re-run is a no-op (kill-retry shape)', async () => {
    const ctx = setup();
    acquaint(ctx.storage);
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'world.time_advanced',
      payload: {
        from: '2000-01-01T06:00:00.000Z',
        to: '2000-01-02T08:00:00.000Z',
        code_enqueued: 0,
        llm_enqueued: 0,
        llm_skipped: 0,
      },
    });

    await ctx.handler(fire());
    await ctx.handler(fire(OCCURRENCE, 2)); // the post-kill lease retry

    expect(posts(ctx.storage)).toBe(1);
    const events = ctx.storage.eventLog.readSince(0);
    const post = events.find((e) => e.type === 'social.post_committed');
    if (post?.type !== 'social.post_committed') throw new Error('no post');
    expect(post.payload.occurrence_iso).toBe(OCCURRENCE);
    expect(post.payload.game_time).toBe('2000-01-02T08:00:00.000Z');
    expect(post.payload.body.length).toBeGreaterThan(0);
    // Delivery: the poster's acquaintance received it (whichever fixture
    // character the deterministic pick chose, the OTHER one is acquainted).
    expect(post.payload.recipient_ids).toHaveLength(1);
    // Two-sided memory, poster half: the CACHE line rides the transaction.
    const cache = events.find(
      (e) =>
        e.type === 'cache.appended' &&
        e.payload.origin === 'social' &&
        e.payload.context_id === post.payload.post_id,
    );
    expect(cache).toBeDefined();
    // The reaction fan-out is durable WITH the post — exactly one decision
    // job for the one acquainted recipient, on its own serial group.
    const job = ctx.storage.ledger.get(1);
    expect(job).not.toBeNull();
    expect(job?.type).toBe('social_reaction');
    expect(job?.idempotency_key).toBe(
      `social_reaction:${post.payload.post_id}:${post.payload.recipient_ids[0] ?? ''}`,
    );
    expect(job?.serial_group).toBe(
      `social:w1:${post.payload.recipient_ids[0] ?? ''}`,
    );
  });

  it('a poster with no acquaintances still posts — zero recipients, zero reaction jobs', async () => {
    const ctx = setup();
    await ctx.handler(fire());
    const post = ctx.storage.eventLog
      .readSince(0)
      .find((e) => e.type === 'social.post_committed');
    if (post?.type !== 'social.post_committed') throw new Error('no post');
    expect(post.payload.recipient_ids).toEqual([]);
    expect(ctx.storage.ledger.get(1)).toBeNull();
  });

  it('the reaction cap bounds the fan-out deterministically', async () => {
    const ctx = setup(undefined, 1);
    // Elias knows mara AND a third character via two groups.
    acquaint(ctx.storage, 'g1');
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'chat.group_started',
      payload: {
        conversation_id: 'g2',
        member_ids: ['char:elias', 'char:mara', 'char:aria'],
        title: 'Everyone',
      },
    });
    await ctx.handler(fire());
    const post = ctx.storage.eventLog
      .readSince(0)
      .find((e) => e.type === 'social.post_committed');
    if (post?.type !== 'social.post_committed') throw new Error('no post');
    expect(post.payload.recipient_ids.length).toBeGreaterThanOrEqual(1);
    // Cap 1: exactly one reaction job regardless of recipient count.
    expect(ctx.storage.ledger.get(1)?.type).toBe('social_reaction');
    expect(ctx.storage.ledger.get(2)).toBeNull();
  });

  it('stay_silent declines the fire — nothing durable', async () => {
    const declining: LlmClient = {
      async streamCall(call): Promise<Result<LlmCallResult>> {
        await Promise.resolve();
        call.onTextDelta('');
        return ok({
          text: 'Nothing worth posting tonight.',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          model: 'stub',
          durationMs: 0,
          toolCalls: [{ tool: 'stay_silent', input: {} }],
        });
      },
    };
    const ctx = setup(declining);
    await ctx.handler(fire());
    expect(posts(ctx.storage)).toBe(0);
    expect(ctx.storage.ledger.get(1)).toBeNull();
  });

  it('an empty generation stays quiet — nothing durable', async () => {
    const empty: LlmClient = {
      async streamCall(): Promise<Result<LlmCallResult>> {
        await Promise.resolve();
        return ok({
          text: '   ',
          usage: { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0 },
          model: 'stub',
          durationMs: 0,
          toolCalls: [],
        });
      },
    };
    const ctx = setup(empty);
    await ctx.handler(fire());
    expect(posts(ctx.storage)).toBe(0);
  });

  it('every pick busy (in an open scene) leaves the occurrence quiet', async () => {
    const ctx = setup();
    for (const characterId of ['char:elias', 'char:mara']) {
      ctx.storage.eventLog.append({
        world_id: 'w1',
        actor_id: 'system:scene',
        type: 'character.joined',
        payload: {
          scene_id: 's-open',
          character_id: characterId,
          name: characterId,
        },
      });
    }
    await ctx.handler(fire());
    expect(posts(ctx.storage)).toBe(0);
    expect(ctx.llmCalls).toHaveLength(0); // not even a generation
  });

  it('a malformed payload is corrupt state, never a retry loop', async () => {
    const ctx = setup();
    await expect(
      ctx.handler({ ...fire(), payload: { wrong: true } }),
    ).rejects.toThrow(/payload does not match/);
  });

  it('the social context speaks feed, not chat: kind social_post, the conduct skill in the prefix', async () => {
    const ctx = setup();
    await ctx.handler(fire());
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.llmCalls[0]?.kind).toBe('social_post');
    expect(ctx.llmCalls[0]?.system).toContain('The Feed:');
    expect(ctx.llmCalls[0]?.prompt).toContain('feed post');
  });
});
