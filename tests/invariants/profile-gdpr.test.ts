// Profiling is owned by the user (M7 part 2, Rev 4 §9 Job 2 guardrails):
// profiling_enabled OFF (the default) = ZERO profile writes at every layer
// (no job enqueued; a stale job re-checks and no-ops); hypotheses accumulate
// as structured rows in the DELETABLE side store with only counts in the
// log; view/export return them; delete removes them durably — no replay
// resurrects erased personal data.
import { describe, expect, it } from 'vitest';
import type { WeltariEvent } from '@weltari/protocol';
import { createChatEngine } from '../../apps/server/src/engine/chat.js';
import { createSetConfigFlagCommand } from '../../apps/server/src/engine/config-flags.js';
import { createEventSink } from '../../apps/server/src/engine/event-sink.js';
import { buildEliasProfile } from '../../apps/server/src/engine/fixture/rainy-inn.js';
import {
  createDeleteProfileCommand,
  profileView,
} from '../../apps/server/src/engine/profile-gdpr.js';
import { createSceneLifecycle } from '../../apps/server/src/engine/scene-lifecycle.js';
import { createProfileAnalysisHandler } from '../../apps/server/src/ledger/handlers/profile-analysis.js';
import { createFakeLlmClient } from '../../apps/server/src/llm/fake-client.js';
import { ok } from '../../apps/server/src/errors.js';
import { Bus } from '../../apps/server/src/http/bus.js';
import type { LedgerJob } from '../../apps/server/src/storage/repositories/ledger.js';
import type { Storage } from '../../apps/server/src/storage/db.js';
import { captureLogger } from '../helpers/capture-logger.js';
import { tempStorage } from '../helpers/temp-storage.js';

const WORLD = 'w1';
const OWNER = 'user:owner';

function analysisJob(contextId: string, origin: 'scene' | 'chat'): LedgerJob {
  return {
    id: 1,
    idempotency_key: `profile_analysis:${OWNER}:${contextId}`,
    world_id: WORLD,
    type: 'profile_analysis',
    payload: { user_actor_id: OWNER, origin, context_id: contextId },
    state: 'running',
    attempts: 1,
    max_attempts: 5,
    run_at: '2026-07-11T12:00:00.000Z',
    lease_until: '2026-07-11T12:01:00.000Z',
    worker_id: 'w',
    serial_group: `profile:${WORLD}`,
    last_error: null,
  };
}

function setup(): {
  storage: Storage;
  handler: ReturnType<typeof createProfileAnalysisHandler>;
  enableProfiling: () => void;
  chat: ReturnType<typeof createChatEngine>;
  lifecycle: ReturnType<typeof createSceneLifecycle>;
} {
  const { logger } = captureLogger();
  const storage = tempStorage();
  const eventBus = new Bus<WeltariEvent>(logger);
  const sink = createEventSink(storage, eventBus);
  const handler = createProfileAnalysisHandler({
    storage,
    eventBus,
    llm: createFakeLlmClient(),
    logger,
  });
  const setFlag = createSetConfigFlagCommand({ sink });
  const chat = createChatEngine({
    storage,
    sink,
    eventBus,
    llm: createFakeLlmClient(),
    logger,
    profiles: [buildEliasProfile(100)],
    idleCutoffIso: () => '1970-01-01T00:00:00.000Z',
    openScene: () => ok({ opened: true as const }),
    endScene: () => ok({ jobsEnqueued: 0 }),
  });
  const lifecycle = createSceneLifecycle({
    storage,
    eventBus,
    logger,
    knownCharacters: [],
  });
  return {
    storage,
    handler,
    enableProfiling: (): void => {
      const set = setFlag({
        world_id: WORLD,
        actor_id: OWNER,
        flag: 'profiling_enabled',
        value: true,
      });
      if (!set.ok) throw new Error('flag set failed');
    },
    chat,
    lifecycle,
  };
}

async function closeChatRange(
  ctx: ReturnType<typeof setup>,
): Promise<{ conversationId: string; rangeEndId: number }> {
  const sent = ctx.chat.sendMessage({
    world_id: WORLD,
    actor_id: OWNER,
    character_id: 'char:elias',
    text: 'Evening, Elias.',
    request_id: 'r-1',
  });
  if (!sent.ok) throw new Error(sent.error.code);
  await sent.value.completion;
  const exited = ctx.chat.exitChat({
    world_id: WORLD,
    actor_id: OWNER,
    character_id: 'char:elias',
  });
  if (!exited.ok || !exited.value.ended) throw new Error('exit failed');
  const last = storageLastMessageId(ctx.storage, sent.value.conversationId);
  return { conversationId: sent.value.conversationId, rangeEndId: last };
}

function storageLastMessageId(
  storage: Storage,
  conversationId: string,
): number {
  let last = 0;
  for (const e of storage.eventLog.readSince(0, 100000)) {
    if (
      e.type === 'chat.message_committed' &&
      e.payload.conversation_id === conversationId
    ) {
      last = e.id;
    }
  }
  return last;
}

describe('profiling_enabled off (the default) = zero profile writes', () => {
  it('an ended chat range enqueues NO analysis job', async () => {
    const ctx = setup();
    const { conversationId, rangeEndId } = await closeChatRange(ctx);
    expect(
      ctx.storage.ledger.countByKey(
        `profile_analysis:${OWNER}:${conversationId}:${String(rangeEndId)}`,
      ),
    ).toBe(0);
  });

  it('an ended scene enqueues NO analysis job', () => {
    const ctx = setup();
    ctx.storage.eventLog.append({
      world_id: WORLD,
      actor_id: OWNER,
      type: 'scene.started',
      payload: { scene_id: 's-p1', title: 'Quiet evening' },
    });
    const ended = ctx.lifecycle.endScene({
      world_id: WORLD,
      actor_id: OWNER,
      scene_id: 's-p1',
    });
    expect(ended.ok).toBe(true);
    expect(
      ctx.storage.ledger.countByKey(`profile_analysis:${OWNER}:s-p1`),
    ).toBe(0);
  });

  it('a stale job re-checks the fold and writes nothing', async () => {
    const ctx = setup();
    await closeChatRange(ctx); // material exists, flag stays off
    await ctx.handler(analysisJob('s-ghost', 'scene'));
    expect(ctx.storage.userProfile.count(OWNER)).toBe(0);
    expect(
      ctx.storage.eventLog
        .readSince(0, 100000)
        .some((e) => e.type === 'profile.updated'),
    ).toBe(false);
  });
});

describe('profiling on: hypotheses accumulate as structured data', () => {
  it('an ended chat range enqueues the job; the handler writes rows + profile.updated once', async () => {
    const ctx = setup();
    ctx.enableProfiling();
    const { conversationId, rangeEndId } = await closeChatRange(ctx);
    const contextId = `${conversationId}:${String(rangeEndId)}`;
    expect(
      ctx.storage.ledger.countByKey(`profile_analysis:${OWNER}:${contextId}`),
    ).toBe(1);

    await ctx.handler(analysisJob(contextId, 'chat'));
    expect(ctx.storage.userProfile.count(OWNER)).toBe(2);
    const updated = ctx.storage.eventLog
      .readSince(0, 100000)
      .filter((e) => e.type === 'profile.updated');
    expect(updated).toHaveLength(1);
    const first = updated[0];
    if (first?.type !== 'profile.updated') throw new Error('shape');
    expect(first.payload.hypothesis_count).toBe(2);
    expect(first.payload.user_actor_id).toBe(OWNER);

    // Idempotent per (actor, context): a lease-expiry retry adds nothing.
    await ctx.handler(analysisJob(contextId, 'chat'));
    expect(ctx.storage.userProfile.count(OWNER)).toBe(2);
    expect(
      ctx.storage.eventLog
        .readSince(0, 100000)
        .filter((e) => e.type === 'profile.updated'),
    ).toHaveLength(1);
  });

  it('view returns the rows; export is the same body', async () => {
    const ctx = setup();
    ctx.enableProfiling();
    const { conversationId, rangeEndId } = await closeChatRange(ctx);
    const contextId = `${conversationId}:${String(rangeEndId)}`;
    await ctx.handler(analysisJob(contextId, 'chat'));
    const view = profileView(ctx.storage, WORLD, OWNER);
    expect(view.profiling_enabled).toBe(true);
    expect(view.entries).toHaveLength(2);
    expect(view.entries[0]?.kind).toBe('hypothesis');
    expect(view.entries[0]?.context_id).toBe(contextId);
  });
});

describe('the GDPR erasure right', () => {
  it('delete removes rows durably and audits the fact; a second delete is a silent no-op', async () => {
    const ctx = setup();
    ctx.enableProfiling();
    const { conversationId, rangeEndId } = await closeChatRange(ctx);
    await ctx.handler(
      analysisJob(`${conversationId}:${String(rangeEndId)}`, 'chat'),
    );
    expect(ctx.storage.userProfile.count(OWNER)).toBe(2);

    const { logger } = captureLogger();
    const deleteProfile = createDeleteProfileCommand({
      storage: ctx.storage,
      eventBus: new Bus<WeltariEvent>(logger),
    });
    const first = deleteProfile({ world_id: WORLD, actor_id: OWNER });
    expect(first.ok && first.value.removed === 2).toBe(true);
    expect(ctx.storage.userProfile.count(OWNER)).toBe(0);
    expect(profileView(ctx.storage, WORLD, OWNER).entries).toHaveLength(0);
    const deleted = ctx.storage.eventLog
      .readSince(0, 100000)
      .filter((e) => e.type === 'profile.deleted');
    expect(deleted).toHaveLength(1);

    const second = deleteProfile({ world_id: WORLD, actor_id: OWNER });
    expect(second.ok && second.value.removed === 0).toBe(true);
    expect(
      ctx.storage.eventLog
        .readSince(0, 100000)
        .filter((e) => e.type === 'profile.deleted'),
    ).toHaveLength(1);
  });
});
