// The reflection memory outputs (M7 part 1, Rev 4 §11, criterion a): both
// reflection handlers commit 1-3 deltas (+ optional core update + optional
// evolution) ATOMICALLY with their existing events, B6 double-gated — caps,
// the locked flag, malformed shapes — and kill-retry converges to exactly
// one delta set per (character, scene/range).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../../engine/context-assembler.js';
import { createEventSink } from '../../engine/event-sink.js';
import { buildEliasProfile } from '../../engine/fixture/rainy-inn.js';
import { liveProfile, memoryStateOf } from '../../engine/memory.js';
import { Bus } from '../../http/bus.js';
import { createFakeLlmClient } from '../../llm/fake-client.js';
import { createRootLogger } from '../../observability/logger.js';
import { openStorage, type Storage } from '../../storage/db.js';
import type { LedgerJob } from '../../storage/repositories/ledger.js';
import { createReflectChatHandler } from './reflect-chat.js';
import { createReflectionHandler } from './reflection.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

const ELIAS = buildEliasProfile(100);

function jobWith(
  type: 'reflection' | 'reflect_chat',
  payload: unknown,
): LedgerJob {
  return {
    id: 1,
    idempotency_key: `${type}:test`,
    world_id: 'w1',
    type,
    payload,
    state: 'running',
    attempts: 1,
    max_attempts: 5,
    run_at: '2026-07-11T12:00:00.000Z',
    lease_until: '2026-07-11T12:01:00.000Z',
    worker_id: 'w',
    serial_group: 'memory:w1:char:elias',
    last_error: null,
  };
}

describe('reflection memory outputs (M7 part 1)', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(profile: CharacterProfile = ELIAS): {
    storage: Storage;
    reflection: ReturnType<typeof createReflectionHandler>;
    reflectChat: ReturnType<typeof createReflectChatHandler>;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-refmem-'));
    const logger = quietLogger();
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const sink = createEventSink(storage, new Bus(logger));
    const options = {
      storage,
      sink,
      llm: createFakeLlmClient(),
      profiles: [profile],
      logger,
    };
    return {
      storage,
      reflection: createReflectionHandler(options),
      reflectChat: createReflectChatHandler(options),
    };
  }

  /** Seed a committed scene turn whose text carries fake-client markers. */
  function seedTurn(s: Storage, text: string): void {
    s.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'turn.committed',
      payload: {
        scene_id: 's1',
        turn_id: 't1',
        steps: [{ call: 'narration', speaker: 'User', text }],
      },
    });
  }

  it('a scene reflection commits its delta set atomically and exactly once under retry (criteria a+d)', async () => {
    const ctx = setup();
    seedTurn(ctx.storage, 'A quiet evening at the inn.');
    const job = jobWith('reflection', {
      scene_id: 's1',
      character_id: ELIAS.character_id,
    });
    await ctx.reflection(job);
    await ctx.reflection(job); // the post-kill lease retry

    const deltas = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'memory.delta_committed');
    expect(deltas).toHaveLength(2); // the fake scripts two scene deltas
    for (const delta of deltas) {
      expect(delta.actor_id).toBe(ELIAS.character_id);
      expect(delta.payload).toMatchObject({
        character_id: ELIAS.character_id,
        origin: 'scene',
        context_id: 's1',
      });
    }
    // Replay rebuilds the same memory state (the fold is the projection).
    expect(memoryStateOf(ctx.storage, ELIAS.character_id).deltas).toHaveLength(
      2,
    );
    // The Search Index committed with the deltas (same transaction).
    expect(
      ctx.storage.memoryIndex.search(ELIAS.character_id, 'shrine bell', 3)
        .length,
    ).toBeGreaterThan(0);
  });

  it('a chat reflection commits chat-origin deltas with reflect_chat.committed (criterion a)', async () => {
    const ctx = setup();
    const line = ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'chat.message_committed',
      payload: {
        conversation_id: 'c1',
        character_id: ELIAS.character_id,
        sender: 'user',
        text: 'Storm again tonight?',
        message_id: 'm-1',
      },
    });
    const job = jobWith('reflect_chat', {
      conversation_id: 'c1',
      character_id: ELIAS.character_id,
      range_end_id: line.id,
    });
    await ctx.reflectChat(job);
    await ctx.reflectChat(job); // retry: nothing twins

    const deltas = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'memory.delta_committed');
    expect(deltas).toHaveLength(1); // the fake scripts one chat delta
    const delta = deltas[0];
    if (delta?.type === 'memory.delta_committed') {
      expect(delta.payload.origin).toBe('chat');
      expect(delta.payload.context_id).toBe('c1');
    }
  });

  it('!memcore commits a core update and the NEXT assembled prompt injects it (criterion b)', async () => {
    const ctx = setup();
    seedTurn(ctx.storage, 'Something fundamental happened. !memcore');
    await ctx.reflection(
      jobWith('reflection', {
        scene_id: 's1',
        character_id: ELIAS.character_id,
      }),
    );
    const cores = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'memory.core_updated');
    expect(cores).toHaveLength(1);
    const live = liveProfile(ctx.storage, ELIAS);
    expect(live.memory_core).toContain(
      'The shrine bell is silenced by a person, not the weather.',
    );
    // The seed survives ahead of the snapshot.
    expect(live.memory_core.slice(0, ELIAS.memory_core.length)).toEqual([
      ...ELIAS.memory_core,
    ]);
  });

  it('!evolve evolves an unlocked character; a locked character is refused whole (I8: zero evolution rows)', async () => {
    const unlockedCtx = setup();
    seedTurn(unlockedCtx.storage, 'This changed him. !evolve');
    await unlockedCtx.reflection(
      jobWith('reflection', {
        scene_id: 's1',
        character_id: ELIAS.character_id,
      }),
    );
    expect(
      unlockedCtx.storage.eventLog
        .readSince(0)
        .filter((e) => e.type === 'character.evolved'),
    ).toHaveLength(1);
    expect(liveProfile(unlockedCtx.storage, ELIAS).personality).toBe(
      'Warmer now, but still counts things.',
    );
    unlockedCtx.storage.close();
    storage = null;

    const lockedElias: CharacterProfile = { ...ELIAS, locked: true };
    const lockedCtx = setup(lockedElias);
    seedTurn(lockedCtx.storage, 'This changed him. !evolve');
    await lockedCtx.reflection(
      jobWith('reflection', {
        scene_id: 's1',
        character_id: ELIAS.character_id,
      }),
    );
    expect(
      lockedCtx.storage.eventLog
        .readSince(0)
        .filter((e) => e.type === 'character.evolved'),
    ).toHaveLength(0);
    // The deltas still committed — only evolution was refused.
    expect(
      lockedCtx.storage.eventLog
        .readSince(0)
        .filter((e) => e.type === 'memory.delta_committed'),
    ).toHaveLength(2);
    expect(liveProfile(lockedCtx.storage, lockedElias).personality).toBe(
      ELIAS.personality,
    );
  });

  it('the delta cap holds: !overcap produces five calls, exactly three commit (Rev 4 §11)', async () => {
    const ctx = setup();
    seedTurn(ctx.storage, 'Too much happened. !overcap');
    await ctx.reflection(
      jobWith('reflection', {
        scene_id: 's1',
        character_id: ELIAS.character_id,
      }),
    );
    expect(
      ctx.storage.eventLog
        .readSince(0)
        .filter((e) => e.type === 'memory.delta_committed'),
    ).toHaveLength(3);
  });

  it('a malformed delta and an empty evolve are dropped at the gates — valid siblings still commit (I8)', async () => {
    const ctx = setup();
    seedTurn(ctx.storage, 'Odd output night. !badmemory !evolveempty');
    await ctx.reflection(
      jobWith('reflection', {
        scene_id: 's1',
        character_id: ELIAS.character_id,
      }),
    );
    const events = ctx.storage.eventLog.readSince(0);
    expect(
      events.filter((e) => e.type === 'memory.delta_committed'),
    ).toHaveLength(2); // the two valid scripted deltas
    expect(events.filter((e) => e.type === 'character.evolved')).toHaveLength(
      0,
    );
  });

  it('memory text is sanitized for prefix hygiene: no raw angle brackets survive the gate', async () => {
    const ctx = setup();
    seedTurn(ctx.storage, '!memcore');
    await ctx.reflection(
      jobWith('reflection', {
        scene_id: 's1',
        character_id: ELIAS.character_id,
      }),
    );
    for (const event of ctx.storage.eventLog.readSince(0)) {
      if (
        event.type === 'memory.delta_committed' ||
        event.type === 'memory.core_updated'
      ) {
        const texts =
          event.type === 'memory.core_updated'
            ? event.payload.core
            : [event.payload.content];
        for (const text of texts) {
          expect(text).not.toContain('<');
          expect(text).not.toContain('>');
        }
      }
    }
  });
});
