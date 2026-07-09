// Weltari Chat part one (M6 part 2, Rev 4 §8): the DM core. Everything
// asserts through public seams — events, ledger rows — never internals (E5).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ok, type Result } from '../errors.js';
import { Bus, type EventBus } from '../http/bus.js';
import { createFakeLlmClient } from '../llm/fake-client.js';
import type { LlmCall, LlmCallResult, LlmClient } from '../llm/types.js';
import { createRootLogger } from '../observability/logger.js';
import { openStorage, type Storage } from '../storage/db.js';
import { buildEliasProfile } from './fixture/rainy-inn.js';
import { createEventSink } from './event-sink.js';
import { createChatEngine, presenceOf } from './chat.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sinkStream = new Writable({
    write(_c, _e, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sinkStream });
}

const ELIAS = buildEliasProfile(100);

interface Ctx {
  storage: Storage;
  engine: ReturnType<typeof createChatEngine>;
  llmCalls: LlmCall[];
}

function setup(
  options: { llm?: LlmClient; idleCutoffIso?: () => string } = {},
): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'weltari-chat-'));
  const logger = quietLogger();
  const storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
  const eventBus: EventBus = new Bus(logger);
  const llmCalls: LlmCall[] = [];
  const base = options.llm ?? createFakeLlmClient();
  const recording: LlmClient = {
    async streamCall(call): Promise<Result<LlmCallResult>> {
      llmCalls.push(call);
      return base.streamCall(call);
    },
  };
  const engine = createChatEngine({
    storage,
    sink: createEventSink(storage, eventBus),
    eventBus,
    llm: recording,
    logger,
    profiles: [ELIAS],
    // Default: an ancient cutoff — nothing ever counts as idle.
    idleCutoffIso:
      options.idleCutoffIso ?? ((): string => '2000-01-01T00:00:00.000Z'),
  });
  return { storage, engine, llmCalls };
}

const SEND = {
  world_id: 'w1',
  actor_id: 'user:owner',
  character_id: 'char:elias',
  text: 'Evening, Elias. Roads are mud again.',
  request_id: 'm-1',
};

async function sendAndAwait(ctx: Ctx, command: typeof SEND): Promise<void> {
  const sent = ctx.engine.sendMessage(command);
  expect(sent.ok).toBe(true);
  if (sent.ok) await sent.value.completion;
}

describe('DM a character outside any scene (criterion a)', () => {
  it('commits the user line, the in-character reply, and the chat CACHE line', async () => {
    const ctx = setup();
    await sendAndAwait(ctx, SEND);

    const events = ctx.storage.eventLog.readSince(0);
    expect(events.map((e) => e.type)).toEqual([
      'chat.message_committed', // the user line — durable at the seam
      'chat.message_committed', // the reply
      'cache.appended', // the mandatory recap, same transaction
    ]);
    const [userLine, reply, cache] = events;
    if (userLine?.type === 'chat.message_committed') {
      expect(userLine.payload).toMatchObject({
        conversation_id: 'chat:user:owner:char:elias',
        sender: 'user',
        message_id: 'm-1',
      });
      expect(userLine.actor_id).toBe('user:owner');
    }
    if (reply?.type === 'chat.message_committed') {
      expect(reply.payload.sender).toBe('character');
      expect(reply.payload.text).toContain('cracked bell'); // the fixture memory grounding
      expect(reply.actor_id).toBe(ELIAS.character_id);
    }
    if (cache?.type === 'cache.appended') {
      expect(cache.payload).toMatchObject({
        character_id: ELIAS.character_id,
        origin: 'chat',
        context_id: 'chat:user:owner:char:elias',
      });
    }
    ctx.storage.close();
  });

  it('the chat prompt carries the FRESH latest-per-origin recap and a byte-stable prefix', async () => {
    const ctx = setup();
    // A prior scene experience — the DM catch-up must inject it (Rev 4 §11).
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: ELIAS.character_id,
      type: 'cache.appended',
      payload: {
        character_id: ELIAS.character_id,
        origin: 'scene',
        context_id: 's9',
        line: 'Closed the inn late after the storm broke a shutter.',
      },
    });
    await sendAndAwait(ctx, SEND);
    await sendAndAwait(ctx, { ...SEND, request_id: 'm-2', text: 'Still up?' });

    const chatCalls = ctx.llmCalls.filter((c) => c.kind === 'chat');
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[0]?.prompt).toContain('## Conversation');
    expect(chatCalls[0]?.prompt).toContain(
      'Last scene experience: Closed the inn late after the storm broke a shutter.',
    );
    // The second turn's recap is FRESH: it now also carries the chat line
    // the first reply wrote (owner decision: re-read every call).
    expect(chatCalls[1]?.prompt).toContain('Last chat note:');
    // Same character, same stable prefix, byte-identical (cache contract).
    expect(chatCalls[1]?.system).toBe(chatCalls[0]?.system);
    ctx.storage.close();
  });

  it('a duplicate request_id is a silent no-op (idempotent send)', async () => {
    const ctx = setup();
    await sendAndAwait(ctx, SEND);
    await sendAndAwait(ctx, SEND); // the client retried

    const userLines = ctx.storage.eventLog
      .readSince(0)
      .filter(
        (e) =>
          e.type === 'chat.message_committed' && e.payload.sender === 'user',
      );
    expect(userLines).toHaveLength(1);
    ctx.storage.close();
  });

  it('unknown character is refused as a value (409 shape)', () => {
    const ctx = setup();
    const sent = ctx.engine.sendMessage({
      ...SEND,
      character_id: 'char:ghost',
    });
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.error.code).toBe('unknown_character');
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(0);
    ctx.storage.close();
  });
});

describe('the presence rule (criterion b: in_scene = offline in chat)', () => {
  function joinScene(ctx: Ctx, sceneId: string): void {
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'scene.started',
      payload: { scene_id: sceneId, title: 'The Rainy Inn' },
    });
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'character.joined',
      payload: {
        scene_id: sceneId,
        character_id: ELIAS.character_id,
        name: ELIAS.name,
      },
    });
  }

  function endScene(ctx: Ctx, sceneId: string): void {
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'scene.ended',
      payload: { scene_id: sceneId, participants: [ELIAS.character_id] },
    });
  }

  it('presenceOf projects in_scene from joined/ended events', () => {
    const ctx = setup();
    expect(presenceOf(ctx.storage, ELIAS.character_id)).toEqual({
      state: 'available',
    });
    joinScene(ctx, 's1');
    expect(presenceOf(ctx.storage, ELIAS.character_id)).toEqual({
      state: 'in_scene',
      scene_id: 's1',
    });
    endScene(ctx, 's1');
    expect(presenceOf(ctx.storage, ELIAS.character_id)).toEqual({
      state: 'available',
    });
    ctx.storage.close();
  });

  it('a DM to a character in a scene is stored but gets NO reply until the scene ends', async () => {
    const ctx = setup();
    joinScene(ctx, 's1');

    const sent = ctx.engine.sendMessage(SEND);
    expect(sent.ok).toBe(true);
    if (sent.ok) {
      expect(sent.value.replying).toBe(false);
      expect(sent.value.presence).toBe('in_scene');
      await sent.value.completion;
    }
    const messages = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'chat.message_committed');
    expect(messages).toHaveLength(1); // the stored user line, nothing else
    expect(ctx.llmCalls.filter((c) => c.kind === 'chat')).toHaveLength(0);

    // Scene over → the character is reachable again.
    endScene(ctx, 's1');
    await sendAndAwait(ctx, { ...SEND, request_id: 'm-2', text: 'Back yet?' });
    const after = ctx.storage.eventLog
      .readSince(0)
      .filter(
        (e) =>
          e.type === 'chat.message_committed' &&
          e.payload.sender === 'character',
      );
    expect(after).toHaveLength(1);
    ctx.storage.close();
  });
});

describe('conversation end (criterion c: exit + idle → ONE reflect_chat job)', () => {
  it('exit closes the range and enqueues exactly one reflect_chat, keyed by range end', async () => {
    const ctx = setup();
    await sendAndAwait(ctx, SEND);
    const lastMessageId = ctx.storage.eventLog.lastId() - 1; // reply id (cache is last)

    const exited = ctx.engine.exitChat({
      world_id: 'w1',
      actor_id: 'user:owner',
      character_id: 'char:elias',
    });
    expect(exited.ok).toBe(true);
    if (!exited.ok) return;
    expect(exited.value.ended).toBe(true);
    const jobKey = exited.value.jobKey ?? '';
    expect(jobKey).toBe(
      `reflect_chat:chat:user:owner:char:elias:${String(lastMessageId)}`,
    );
    expect(ctx.storage.ledger.countByKey(jobKey)).toBe(1);

    const ended = ctx.storage.eventLog
      .readSince(0)
      .find((e) => e.type === 'chat.ended');
    expect(ended).toBeDefined();
    if (ended?.type === 'chat.ended') {
      expect(ended.payload.reason).toBe('exit');
      expect(ended.payload.range_end_id).toBe(lastMessageId);
    }

    // A second exit has nothing to close — silent no-op, no second job.
    const again = ctx.engine.exitChat({
      world_id: 'w1',
      actor_id: 'user:owner',
      character_id: 'char:elias',
    });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.ended).toBe(false);
    expect(
      ctx.storage.eventLog.readSince(0).filter((e) => e.type === 'chat.ended'),
    ).toHaveLength(1);
    ctx.storage.close();
  });

  it('the idle sweep closes only conversations past the timeout (reason idle)', async () => {
    // The injected cutoff jumps from "everything is recent" to "everything
    // is idle" — the fake-clock shape of `now − 30 min` (Guide A16/E4).
    let cutoff = '2000-01-01T00:00:00.000Z';
    const ctx = setup({ idleCutoffIso: () => cutoff });
    await sendAndAwait(ctx, SEND);

    expect(ctx.engine.sweepIdle()).toBe(0); // fresh conversation stays open

    cutoff = '2999-01-01T00:00:00.000Z'; // every real timestamp is older now
    expect(ctx.engine.sweepIdle()).toBe(1);
    const ended = ctx.storage.eventLog
      .readSince(0)
      .find((e) => e.type === 'chat.ended');
    expect(ended).toBeDefined();
    if (ended?.type === 'chat.ended') {
      expect(ended.payload.reason).toBe('idle');
    }
    expect(
      ctx.storage.ledger.countByKey(
        `reflect_chat:chat:user:owner:char:elias:${String(ended?.type === 'chat.ended' ? ended.payload.range_end_id : 0)}`,
      ),
    ).toBe(1);

    expect(ctx.engine.sweepIdle()).toBe(0); // already closed — nothing left
    ctx.storage.close();
  });

  it('a second message while the reply generates queues ONE follow-up, never a race', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const gated: LlmClient = {
      async streamCall(call): Promise<Result<LlmCallResult>> {
        calls += 1;
        if (calls === 1) await gate; // the first reply hangs mid-generation
        return ok({
          text: `Reply ${String(calls)} — ${call.prompt.length > 0 ? 'ok' : ''}`,
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          model: 'fake/gated',
          durationMs: 0,
          toolCalls: [
            { tool: 'cache', input: { line: `Recap ${String(calls)}.` } },
          ],
        });
      },
    };
    const ctx = setup({ llm: gated });
    const first = ctx.engine.sendMessage(SEND);
    expect(first.ok).toBe(true);
    const second = ctx.engine.sendMessage({
      ...SEND,
      request_id: 'm-2',
      text: 'And another thing —',
    });
    expect(second.ok).toBe(true);
    release();
    if (first.ok) await first.value.completion;

    const replies = ctx.storage.eventLog
      .readSince(0)
      .filter(
        (e) =>
          e.type === 'chat.message_committed' &&
          e.payload.sender === 'character',
      );
    // One reply per generation pass: the hung first + the nudged follow-up.
    expect(replies).toHaveLength(2);
    ctx.storage.close();
  });
});
