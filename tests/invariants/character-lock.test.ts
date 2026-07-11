// The user-facing evolution lock (M7 part 2, Rev 4 §7/§11): character.lock_set
// is registry-gated at the command (unknown character = 409, zero rows) and
// LIVE at the reflection gate — a lock flipped between two reflections
// refuses the very next evolution whole (I8: zero character.evolved rows)
// while memory deltas keep committing; unlocking re-opens it.
import { describe, expect, it } from 'vitest';
import {
  createSetCharacterLockCommand,
  withLiveLock,
} from '../../apps/server/src/engine/characters.js';
import { createEventSink } from '../../apps/server/src/engine/event-sink.js';
import { buildEliasProfile } from '../../apps/server/src/engine/fixture/rainy-inn.js';
import { createReflectChatHandler } from '../../apps/server/src/ledger/handlers/reflect-chat.js';
import { createFakeLlmClient } from '../../apps/server/src/llm/fake-client.js';
import { Bus } from '../../apps/server/src/http/bus.js';
import type { LedgerJob } from '../../apps/server/src/storage/repositories/ledger.js';
import type { Storage } from '../../apps/server/src/storage/db.js';
import { captureLogger } from '../helpers/capture-logger.js';
import { tempStorage } from '../helpers/temp-storage.js';

const WORLD = 'w1';
const ELIAS = 'char:elias';
const CONVERSATION = 'chat:user:owner:char:elias';

function setup(): {
  storage: Storage;
  setLock: ReturnType<typeof createSetCharacterLockCommand>;
  handler: ReturnType<typeof createReflectChatHandler>;
} {
  const { logger } = captureLogger();
  const storage = tempStorage();
  const sink = createEventSink(storage, new Bus(logger));
  const setLock = createSetCharacterLockCommand({
    storage,
    sink,
    seedProfiles: [buildEliasProfile(100)],
  });
  const handler = createReflectChatHandler({
    storage,
    sink,
    llm: createFakeLlmClient(),
    profiles: [buildEliasProfile(100)],
    logger,
  });
  return { storage, setLock, handler };
}

/** One chat line whose text rides the reflection transcript — the fake's
 * !evolve marker scripts an evolve call in the reflection pass. */
function appendLine(storage: Storage, text: string): number {
  const event = storage.eventLog.append({
    world_id: WORLD,
    actor_id: 'user:owner',
    type: 'chat.message_committed',
    payload: {
      conversation_id: CONVERSATION,
      character_id: ELIAS,
      sender: 'user',
      text,
      message_id: `m-${String(storage.eventLog.lastId() + 1)}`,
    },
  });
  return event.id;
}

function reflectJob(rangeEndId: number): LedgerJob {
  return {
    id: 1,
    idempotency_key: `reflect_chat:${CONVERSATION}:${String(rangeEndId)}`,
    world_id: WORLD,
    type: 'reflect_chat',
    payload: {
      conversation_id: CONVERSATION,
      character_id: ELIAS,
      range_end_id: rangeEndId,
    },
    state: 'running',
    attempts: 1,
    max_attempts: 5,
    run_at: '2026-07-11T12:00:00.000Z',
    lease_until: '2026-07-11T12:01:00.000Z',
    worker_id: 'w',
    serial_group: `memory:${WORLD}:${ELIAS}`,
    last_error: null,
  };
}

describe('the lock command is registry-gated', () => {
  it('an unknown character 409s with zero rows', () => {
    const ctx = setup();
    const before = ctx.storage.eventLog.readSince(0, 100000).length;
    const refused = ctx.setLock({
      world_id: WORLD,
      actor_id: 'user:owner',
      character_id: 'char:ghost',
      locked: true,
    });
    expect(!refused.ok && refused.error.code === 'unknown_character').toBe(
      true,
    );
    expect(ctx.storage.eventLog.readSince(0, 100000)).toHaveLength(before);
  });

  it('a known character locks; the fold overlays the seed flag', () => {
    const ctx = setup();
    const locked = ctx.setLock({
      world_id: WORLD,
      actor_id: 'user:owner',
      character_id: ELIAS,
      locked: true,
    });
    expect(locked.ok).toBe(true);
    expect(
      withLiveLock(ctx.storage, WORLD, buildEliasProfile(100)).locked,
    ).toBe(true);
  });
});

describe('the lock is LIVE at the reflection gate (I8)', () => {
  it('a locked character refuses evolution whole; deltas still commit; unlock re-opens', async () => {
    const ctx = setup();
    // Lock, then a chat range whose reflection scripts an evolve (!evolve).
    const locked = ctx.setLock({
      world_id: WORLD,
      actor_id: 'user:owner',
      character_id: ELIAS,
      locked: true,
    });
    expect(locked.ok).toBe(true);
    const rangeEnd = appendLine(ctx.storage, 'You have changed. !evolve');
    await ctx.handler(reflectJob(rangeEnd));

    const events = ctx.storage.eventLog.readSince(0, 100000);
    expect(events.some((e) => e.type === 'character.evolved')).toBe(false);
    // The refusal is surgical: the reflection itself and its deltas commit.
    expect(events.some((e) => e.type === 'reflect_chat.committed')).toBe(true);
    expect(events.some((e) => e.type === 'memory.delta_committed')).toBe(true);

    // Unlock — the very next reflection may evolve again.
    const unlocked = ctx.setLock({
      world_id: WORLD,
      actor_id: 'user:owner',
      character_id: ELIAS,
      locked: false,
    });
    expect(unlocked.ok).toBe(true);
    const secondRange = appendLine(
      ctx.storage,
      'Truly changed this time. !evolve',
    );
    await ctx.handler(reflectJob(secondRange));
    expect(
      ctx.storage.eventLog
        .readSince(0, 100000)
        .some((e) => e.type === 'character.evolved'),
    ).toBe(true);
  });
});
