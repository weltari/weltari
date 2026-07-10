// The proactive_dm handler (M6 part 3, Rev 4 §8): eager generation at fire
// time, idempotent per (world, occurrence_iso) with the fused lease-overlap
// re-check, the presence/quiet/backoff eligibility, the 3-unanswered freeze
// appended ATOMICALLY with the tripping outreach — the standing natural-key
// triad (docs/ledger.md; reflect_chat is the sibling).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ok, type Result } from '../../errors.js';
import { buildEliasProfile } from '../../engine/fixture/rainy-inn.js';
import { createEventSink } from '../../engine/event-sink.js';
import { Bus } from '../../http/bus.js';
import { createFakeLlmClient } from '../../llm/fake-client.js';
import type { LlmCall, LlmCallResult, LlmClient } from '../../llm/types.js';
import { createRootLogger } from '../../observability/logger.js';
import { openStorage, type Storage } from '../../storage/db.js';
import type { LedgerJob } from '../../storage/repositories/ledger.js';
import { createProactiveDmHandler } from './proactive-dm.js';

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
const OCCURRENCE = '2026-07-10T10:00:00.000Z';

function jobWith(payload: unknown, id = 1): LedgerJob {
  return {
    id,
    idempotency_key: `proactive_dm:w1:${OCCURRENCE}`,
    world_id: 'w1',
    type: 'proactive_dm',
    payload,
    state: 'running',
    attempts: 1,
    max_attempts: 5,
    run_at: OCCURRENCE,
    lease_until: '2026-07-10T10:01:00.000Z',
    worker_id: 'w',
    serial_group: null,
    last_error: null,
  };
}

function fire(occurrenceIso: string): LedgerJob {
  return jobWith({ occurrence_iso: occurrenceIso, cadence_minutes: 60 });
}

describe('proactive_dm job handler', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(llm?: LlmClient): {
    storage: Storage;
    handler: ReturnType<typeof createProactiveDmHandler>;
    llmCalls: LlmCall[];
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-proactive-'));
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
    const handler = createProactiveDmHandler({
      storage,
      sink,
      llm: recording,
      profiles: [ELIAS],
      actorId: 'user:owner',
      logger,
    });
    return { storage, handler, llmCalls };
  }

  function outreaches(target: Storage): number {
    return target.eventLog
      .readSince(0)
      .filter((e) => e.type === 'chat.outreach_recorded').length;
  }

  it('a fire commits the DM + CACHE + outreach atomically, stamped with both clocks — re-run is a no-op (kill-retry shape)', async () => {
    const ctx = setup();
    // The fictional clock moved before the fire: the stamp must carry it.
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'world.time_advanced',
      payload: {
        from: '2000-01-01T06:00:00.000Z',
        to: '2000-01-03T18:00:00.000Z',
        code_enqueued: 0,
        llm_enqueued: 0,
        llm_skipped: 0,
      },
    });

    await ctx.handler(fire(OCCURRENCE));
    await ctx.handler(fire(OCCURRENCE)); // the post-kill lease retry

    const events = ctx.storage.eventLog.readSince(0);
    const messages = events.filter(
      (e) =>
        e.type === 'chat.message_committed' && e.payload.sender === 'character',
    );
    expect(messages).toHaveLength(1);
    expect(events.filter((e) => e.type === 'cache.appended')).toHaveLength(1);
    const recorded = events.filter((e) => e.type === 'chat.outreach_recorded');
    expect(recorded).toHaveLength(1);
    const record = recorded[0];
    if (record?.type === 'chat.outreach_recorded') {
      expect(record.payload).toMatchObject({
        conversation_id: CONVERSATION,
        character_id: ELIAS.character_id,
        occurrence_iso: OCCURRENCE,
        game_time: '2000-01-03T18:00:00.000Z', // the V2 bridge stamp
        unanswered_count: 1,
      });
      // Atomicity: the outreach names a really-committed message.
      expect(
        messages.some(
          (m) =>
            m.type === 'chat.message_committed' &&
            m.payload.message_id === record.payload.message_id,
        ),
      ).toBe(true);
    }
    // No freeze at count 1; the chat call was chat-shaped.
    expect(events.some((e) => e.type === 'chat.thread_frozen')).toBe(false);
    expect(ctx.llmCalls[0]?.kind).toBe('chat');
    expect(ctx.llmCalls[0]?.prompt).toContain('reaching out');
  });

  it('overlapping executions of ONE fire commit exactly one outreach (fused re-check)', async () => {
    const release: (() => void)[] = [];
    const slow: LlmClient = {
      streamCall: async (): Promise<Result<LlmCallResult>> => {
        await new Promise<void>((r) => release.push(r));
        return ok({
          text: 'Still thinking about that bell.',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          model: 'fake/slow',
          durationMs: 0,
          toolCalls: [{ tool: 'cache', input: { line: 'Texted them again.' } }],
        });
      },
    };
    const ctx = setup(slow);
    const first = ctx.handler(fire(OCCURRENCE));
    const second = ctx.handler(fire(OCCURRENCE)); // the reclaimed re-execution
    while (release.length < 2) await new Promise((r) => setTimeout(r, 5));
    for (const r of release) r();
    await Promise.all([first, second]);

    expect(outreaches(ctx.storage)).toBe(1);
  });

  it('the third unanswered fire freezes the thread ATOMICALLY; frozen fires no-op; a user reply + closed range resumes', async () => {
    const ctx = setup();
    // Backoff-spaced occurrences: 10:00, +2h (×2), then +4h (×4).
    await ctx.handler(fire('2026-07-10T10:00:00.000Z'));
    await ctx.handler(fire('2026-07-10T12:00:00.000Z'));
    await ctx.handler(fire('2026-07-10T16:00:00.000Z'));
    const events = ctx.storage.eventLog.readSince(0);
    expect(outreaches(ctx.storage)).toBe(3);
    const frozen = events.filter((e) => e.type === 'chat.thread_frozen');
    expect(frozen).toHaveLength(1);
    if (frozen[0]?.type === 'chat.thread_frozen') {
      expect(frozen[0].payload.unanswered_count).toBe(3);
      // Atomic with the tripping outreach: adjacent event ids.
      const third = events.findLast((e) => e.type === 'chat.outreach_recorded');
      expect(frozen[0].id).toBe((third?.id ?? 0) + 1);
    }

    // Frozen: even a far-future fire stays silent.
    await ctx.handler(fire('2099-01-01T00:00:00.000Z'));
    expect(outreaches(ctx.storage)).toBe(3);

    // The user replies (reset by construction) and the range closes (quiet).
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'chat.message_committed',
      payload: {
        conversation_id: CONVERSATION,
        character_id: ELIAS.character_id,
        sender: 'user',
        text: 'Sorry — busy week. What bell?',
        message_id: 'm-reply',
      },
    });
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:chat',
      type: 'chat.ended',
      payload: {
        conversation_id: CONVERSATION,
        character_id: ELIAS.character_id,
        reason: 'idle',
        range_end_id: ctx.storage.eventLog.lastId(),
      },
    });
    await ctx.handler(fire('2099-06-01T00:00:00.000Z'));
    expect(outreaches(ctx.storage)).toBe(4);
    const latest = ctx.storage.eventLog
      .readSince(0)
      .findLast((e) => e.type === 'chat.outreach_recorded');
    if (latest?.type === 'chat.outreach_recorded') {
      expect(latest.payload.unanswered_count).toBe(1); // the counter reset
    }
  });

  it('a fire into an OPEN conversation or an in_scene character stays quiet', async () => {
    const ctx = setup();
    // Open conversation: the user said something, no range close yet.
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'chat.message_committed',
      payload: {
        conversation_id: CONVERSATION,
        character_id: ELIAS.character_id,
        sender: 'user',
        text: 'Evening.',
        message_id: 'm-1',
      },
    });
    await ctx.handler(fire(OCCURRENCE));
    expect(outreaches(ctx.storage)).toBe(0);

    // Quiet again — but the character is in a scene (the presence rule).
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:chat',
      type: 'chat.ended',
      payload: {
        conversation_id: CONVERSATION,
        character_id: ELIAS.character_id,
        reason: 'idle',
        range_end_id: ctx.storage.eventLog.lastId(),
      },
    });
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'scene.started',
      payload: { scene_id: 's1', title: 'The Rainy Inn' },
    });
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'character.joined',
      payload: {
        scene_id: 's1',
        character_id: ELIAS.character_id,
        name: ELIAS.name,
      },
    });
    await ctx.handler(fire('2026-07-10T11:00:00.000Z'));
    expect(outreaches(ctx.storage)).toBe(0);
    expect(ctx.llmCalls).toHaveLength(0); // eligibility never reached the LLM
  });

  it('garbage payload is corrupt state (C2); LLM failure is operational — nothing durable (B6)', async () => {
    const ctx = setup();
    await expect(
      ctx.handler(jobWith({ wrong: 'shape' })),
    ).rejects.toMatchObject({ kind: 'corrupt_state' });
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(0);
  });
});
