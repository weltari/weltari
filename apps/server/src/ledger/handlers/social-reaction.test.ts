// The social_reaction handler (M6 part 5, Rev 4 §12): ONE decision per
// picked recipient — like / one-line comment / stay_silent; the reactor's
// social CACHE line rides the same transaction (two-sided memory, reactor
// half). Natural key (post_id, character_id) + fused re-check.
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
import { createSocialReactionHandler } from './social-reaction.js';

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
const POST_ID = 'post-abc123';

function job(id = 1): LedgerJob {
  return {
    id,
    idempotency_key: `social_reaction:${POST_ID}:char:mara`,
    world_id: 'w1',
    type: 'social_reaction',
    payload: { post_id: POST_ID, character_id: 'char:mara' },
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

describe('social_reaction job handler', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(llm?: LlmClient): {
    storage: Storage;
    handler: ReturnType<typeof createSocialReactionHandler>;
    llmCalls: LlmCall[];
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-social-react-'));
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
    const handler = createSocialReactionHandler({
      storage,
      sink,
      llm: recording,
      profiles: [ELIAS, MARA],
      logger,
    });
    return { storage, handler, llmCalls };
  }

  function seedPost(target: Storage, body: string): void {
    target.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:elias',
      type: 'social.post_committed',
      payload: {
        post_id: POST_ID,
        occurrence_iso: '2000-01-02T00:00:00.000Z',
        game_time: '2000-01-02T08:00:00.000Z',
        character_id: 'char:elias',
        body,
        recipient_ids: ['char:mara'],
      },
    });
  }

  function reactions(target: Storage): number {
    return target.eventLog
      .readSince(0)
      .filter((e) => e.type === 'social.reaction_committed').length;
  }

  it('a comment decision commits the reaction + social CACHE atomically — re-run is a no-op', async () => {
    const ctx = setup();
    seedPost(ctx.storage, 'Roof beams up before the rain came back.');

    await ctx.handler(job());
    await ctx.handler(job(2)); // the post-kill lease retry

    expect(reactions(ctx.storage)).toBe(1);
    const events = ctx.storage.eventLog.readSince(0);
    const reaction = events.find((e) => e.type === 'social.reaction_committed');
    if (reaction?.type !== 'social.reaction_committed') {
      throw new Error('no reaction');
    }
    expect(reaction.payload.kind).toBe('comment');
    expect(reaction.payload.body).toBeDefined();
    expect(reaction.payload.reaction_id).toBe(`${POST_ID}:char:mara`);
    // Two-sided memory, reactor half — origin social, pointed at the post.
    const cache = events.find(
      (e) =>
        e.type === 'cache.appended' &&
        e.payload.character_id === 'char:mara' &&
        e.payload.origin === 'social' &&
        e.payload.context_id === POST_ID,
    );
    expect(cache).toBeDefined();
    // The decision call used the social toolset and the post rode the tail.
    expect(ctx.llmCalls[0]?.kind).toBe('social_react');
    expect(ctx.llmCalls[0]?.toolset).toBe('social_react');
    expect(ctx.llmCalls[0]?.prompt).toContain('Roof beams up');
  });

  it('a like commits without body (the scripted !like marker)', async () => {
    const ctx = setup();
    seedPost(ctx.storage, 'Quiet day on the river. !like');
    await ctx.handler(job());
    const reaction = ctx.storage.eventLog
      .readSince(0)
      .find((e) => e.type === 'social.reaction_committed');
    if (reaction?.type !== 'social.reaction_committed') {
      throw new Error('no reaction');
    }
    expect(reaction.payload.kind).toBe('like');
    expect(reaction.payload.body).toBeUndefined();
  });

  it('stay_silent scrolls past — nothing durable', async () => {
    const ctx = setup();
    seedPost(ctx.storage, 'Storm again. !staysilent');
    await ctx.handler(job());
    expect(reactions(ctx.storage)).toBe(0);
    expect(
      ctx.storage.eventLog
        .readSince(0)
        .filter((e) => e.type === 'cache.appended'),
    ).toHaveLength(0);
  });

  it('a comment without body is a gate rejection — nothing durable (B6)', async () => {
    const ctx = setup();
    seedPost(ctx.storage, 'Storm again. !badreact');
    await ctx.handler(job());
    expect(reactions(ctx.storage)).toBe(0);
  });

  it('an unknown recipient is a quiet no-op; a missing post is corrupt state', async () => {
    const ctx = setup();
    seedPost(ctx.storage, 'A post.');
    await ctx.handler({
      ...job(),
      payload: { post_id: POST_ID, character_id: 'char:ghost' },
    });
    expect(reactions(ctx.storage)).toBe(0);

    await expect(
      ctx.handler({
        ...job(2),
        payload: { post_id: 'post-missing', character_id: 'char:mara' },
      }),
    ).rejects.toThrow(/not in the log/);
  });
});
