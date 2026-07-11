// Weltari Chat part one (M6 part 2, Rev 4 §8): the DM core. Everything
// asserts through public seams — events, ledger rows — never internals (E5).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ok, type Result } from '../errors.js';
import { Bus, type DevBus, type EventBus } from '../http/bus.js';
import { createFakeLlmClient } from '../llm/fake-client.js';
import type { LlmCall, LlmCallResult, LlmClient } from '../llm/types.js';
import { createRootLogger } from '../observability/logger.js';
import { openStorage, type Storage } from '../storage/db.js';
import { buildEliasProfile } from './fixture/rainy-inn.js';
import { createEventSink } from './event-sink.js';
import {
  createSceneLifecycle,
  type SceneLifecycle,
} from './scene-lifecycle.js';
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
  lifecycle: SceneLifecycle;
  llmCalls: LlmCall[];
  /** dev.tool_call frames the engine published (the C11 trail). */
  devFrames: { tool: string; input_json: string }[];
}

/** Stand-in for the runner: claim and commit every active job — the shape
 * the bridge's bounded wait needs (jobs drain, the blocked open unblocks). */
function drainAll(storage: Storage): void {
  for (;;) {
    const job = storage.ledger.claimNext('test-drain', 60);
    if (job === null) break;
    storage.ledger.markCommitted(job.id);
  }
}

function setup(
  options: {
    llm?: LlmClient;
    idleCutoffIso?: () => string;
    /** Wire kickRunner to an instant drain (the bridge transition tests). */
    drainOnKick?: boolean;
  } = {},
): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'weltari-chat-'));
  const logger = quietLogger();
  const storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
  const eventBus: EventBus = new Bus(logger);
  const devBus: DevBus = new Bus(logger);
  const devFrames: { tool: string; input_json: string }[] = [];
  devBus.subscribe((frame) => {
    if (frame.type === 'dev.tool_call') {
      devFrames.push({ tool: frame.tool, input_json: frame.input_json });
    }
  });
  const llmCalls: LlmCall[] = [];
  const base = options.llm ?? createFakeLlmClient();
  const recording: LlmClient = {
    async streamCall(call): Promise<Result<LlmCallResult>> {
      llmCalls.push(call);
      return base.streamCall(call);
    },
  };
  // The REAL scene lifecycle — bridge tests prove the whole handoff
  // (scene.started + character.joined + the presence flip), not a stub.
  const lifecycle = createSceneLifecycle({
    storage,
    eventBus,
    logger,
    knownCharacters: [{ character_id: ELIAS.character_id, name: ELIAS.name }],
  });
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
    openScene: (request) => lifecycle.openScene(request),
    endScene: (command) => lifecycle.endScene(command),
    bridgeRetryDelayMs: 1,
    devBus,
    ...(options.drainOnKick === true
      ? {
          kickRunner: (): void => {
            drainAll(storage);
          },
        }
      : {}),
  });
  return { storage, engine, lifecycle, llmCalls, devFrames };
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
    // The texting conduct skill rides the stable prefix (M6 part 3): the
    // negotiation + the firing rule are taught, not hoped for.
    expect(chatCalls[0]?.system).toContain('call the startscene tool yourself');
    ctx.storage.close();
  });

  it('the query escalation: a DM question runs wikiquery mid-call, the reply uses it, the dev trail shows it (M6 part 3)', async () => {
    const ctx = setup();
    // The registry knows a place the recap alone cannot answer.
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'sublocation.materialized',
      payload: {
        sublocation_id: 'subloc:cellar',
        name: 'The Flooded Cellar',
        description: 'The river seeps in every storm season.',
        square: { col: 3, row: 5 },
        map_position: { x: 0.38, y: 0.72 },
      },
    });
    await sendAndAwait(ctx, {
      ...SEND,
      text: 'What do you know about the cellar? !wikiquery cellar',
    });
    const reply = ctx.storage.eventLog
      .readSince(0)
      .find(
        (e) =>
          e.type === 'chat.message_committed' &&
          e.payload.sender === 'character',
      );
    // The reply VISIBLY uses the executor's result (criterion d shape)…
    if (reply?.type === 'chat.message_committed') {
      expect(reply.payload.text).toContain('The Flooded Cellar');
    }
    // …and the escalation left its dev.tool_call frame (C11).
    expect(ctx.devFrames.some((f) => f.tool === 'wikiquery')).toBe(true);
    ctx.storage.close();
  });

  it('the memory escalation: a DM question about a buried delta runs memoryquery mid-call and the reply visibly uses it (M7 part 1, criterion c)', async () => {
    const ctx = setup();
    // A delta buried in the archive — the instant CACHE recap cannot answer.
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: ELIAS.character_id,
      type: 'memory.delta_committed',
      payload: {
        character_id: ELIAS.character_id,
        origin: 'scene',
        context_id: 's-old',
        content:
          'The traveler lied about the ferry schedule — small lies, but a pattern.',
      },
    });
    await sendAndAwait(ctx, {
      ...SEND,
      text: 'Do you remember what the traveler said? !memoryquery traveler ferry lies',
    });
    const reply = ctx.storage.eventLog
      .readSince(0)
      .find(
        (e) =>
          e.type === 'chat.message_committed' &&
          e.payload.sender === 'character',
      );
    // The reply VISIBLY uses the recalled delta (criterion c shape)…
    if (reply?.type === 'chat.message_committed') {
      expect(reply.payload.text).toContain('lied about the ferry schedule');
    }
    // …and the escalation left its dev.tool_call frame (C11).
    expect(ctx.devFrames.some((f) => f.tool === 'memoryquery')).toBe(true);
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
    expect(presenceOf(ctx.storage, 'w1', ELIAS.character_id)).toEqual({
      state: 'available',
    });
    joinScene(ctx, 's1');
    expect(presenceOf(ctx.storage, 'w1', ELIAS.character_id)).toEqual({
      state: 'in_scene',
      scene_id: 's1',
    });
    endScene(ctx, 's1');
    expect(presenceOf(ctx.storage, 'w1', ELIAS.character_id)).toEqual({
      state: 'available',
    });
    ctx.storage.close();
  });

  it('presence is WORLD-scoped: a scene left open in another world never freezes this one (M6 part 3 fix)', () => {
    const ctx = setup();
    // The reproducer: the kill harness's cross-world probe leaves a w2 scene
    // open with the same character id, forever.
    ctx.storage.eventLog.append({
      world_id: 'w2',
      actor_id: 'system:engine',
      type: 'scene.started',
      payload: { scene_id: 'w2-probe-s1', title: 'Cross-world probe' },
    });
    ctx.storage.eventLog.append({
      world_id: 'w2',
      actor_id: 'system:engine',
      type: 'character.joined',
      payload: {
        scene_id: 'w2-probe-s1',
        character_id: ELIAS.character_id,
        name: ELIAS.name,
      },
    });
    expect(presenceOf(ctx.storage, 'w1', ELIAS.character_id)).toEqual({
      state: 'available',
    });
    expect(presenceOf(ctx.storage, 'w2', ELIAS.character_id)).toEqual({
      state: 'in_scene',
      scene_id: 'w2-probe-s1',
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

  it('startscene() at an existing place opens the scene AT it and closes the chat (criterion d)', async () => {
    const ctx = setup();
    await sendAndAwait(ctx, SEND);

    const bridged = await ctx.engine.startSceneFromChat({
      world_id: 'w1',
      actor_id: 'user:owner',
      character_id: 'char:elias',
      scene_id: 's-chat-1',
      title: 'Meeting at the inn',
      place: 'The Common Room', // resolves by NAME to subloc:common_room
    });
    expect(bridged.ok).toBe(true);
    if (bridged.ok) {
      expect(bridged.value.sublocationId).toBe('subloc:common_room');
    }

    const types = ctx.storage.eventLog.readSince(0).map((e) => e.type);
    // Scene open (started + joined + moved AT the resolved place), then the
    // chat range closes with reason startscene.
    expect(types).toContain('scene.started');
    expect(types).toContain('character.joined');
    expect(types).toContain('sublocation.changed');
    const ended = ctx.storage.eventLog
      .readSince(0)
      .find((e) => e.type === 'chat.ended');
    expect(ended).toBeDefined();
    if (ended?.type === 'chat.ended') {
      expect(ended.payload.reason).toBe('startscene');
    }
    // The reservation (Rev 4 §7): the character is now in_scene — offline in chat.
    expect(presenceOf(ctx.storage, 'w1', ELIAS.character_id).state).toBe(
      'in_scene',
    );
    // …and its reflect_chat job rode the same close.
    expect(
      ctx.storage.ledger.countByKey(
        `reflect_chat:chat:user:owner:char:elias:${String(ended?.type === 'chat.ended' ? ended.payload.range_end_id : 0)}`,
      ),
    ).toBe(1);
    ctx.storage.close();
  });

  it('startscene() at a free-text place rides scene.started as place_request (criterion d)', async () => {
    const ctx = setup();
    await sendAndAwait(ctx, SEND);

    const bridged = await ctx.engine.startSceneFromChat({
      world_id: 'w1',
      actor_id: 'user:owner',
      character_id: 'char:elias',
      scene_id: 's-chat-2',
      title: 'Meeting outside',
      place: 'the park',
      premise: 'They meet under dripping willows.',
    });
    expect(bridged.ok).toBe(true);
    if (bridged.ok) expect(bridged.value.sublocationId).toBeUndefined();

    const started = ctx.storage.eventLog
      .readSince(0)
      .find((e) => e.type === 'scene.started');
    expect(started).toBeDefined();
    if (started?.type === 'scene.started') {
      expect(started.payload.place_request).toBe('the park');
      expect(started.payload.premise).toBe('They meet under dripping willows.');
    }
    // Unresolved: the scene opens at the default start — no move committed;
    // the Narrator's first turn resolves via the standard create workflow.
    expect(
      ctx.storage.eventLog
        .readSince(0)
        .some((e) => e.type === 'sublocation.changed'),
    ).toBe(false);
    ctx.storage.close();
  });

  it('a character-initiated startscene (the fake’s !startscene) bridges after its reply commits', async () => {
    const ctx = setup();
    await sendAndAwait(ctx, {
      ...SEND,
      text: 'Enough texting. !startscene the-ferry-landing',
    });

    const types = ctx.storage.eventLog.readSince(0).map((e) => e.type);
    // Reply + CACHE committed first, then the bridge: scene open + chat end.
    expect(types).toContain('chat.message_committed');
    expect(types).toContain('cache.appended');
    expect(types).toContain('scene.started');
    const started = ctx.storage.eventLog
      .readSince(0)
      .find((e) => e.type === 'scene.started');
    if (started?.type === 'scene.started') {
      expect(started.payload.place_request).toBe('the ferry landing');
    }
    const ended = ctx.storage.eventLog
      .readSince(0)
      .find((e) => e.type === 'chat.ended');
    expect(ended).toBeDefined();
    if (ended?.type === 'chat.ended') {
      expect(ended.payload.reason).toBe('startscene');
    }
    ctx.storage.close();
  });

  it('a character-fired startscene stamps its game-time invitation on scene.started (0.13.0, Rev 4 §7)', async () => {
    const ctx = setup();
    await sendAndAwait(ctx, {
      ...SEND,
      text: 'See you there. !startscene the-shrine',
    });

    const started = ctx.storage.eventLog
      .readSince(0)
      .find((e) => e.type === 'scene.started');
    expect(started).toBeDefined();
    if (started?.type === 'scene.started') {
      expect(started.payload.invitation).toBeDefined();
      expect(started.payload.invitation?.character_id).toBe('char:elias');
      expect(started.payload.invitation?.place).toBe('the shrine');
      expect(started.payload.invitation?.wait_hours).toBe(6);
      // World epoch 06:00 + 6 fictional hours: the ENGINE stamped the
      // deadline against the world clock — the model chose only the hours.
      expect(started.payload.invitation?.expires_at_game).toBe(
        '2000-01-01T12:00:00.000Z',
      );
    }
    ctx.storage.close();
  });

  it('a malformed startscene regenerates with the hardcoded correction, then bridges (retry ceiling)', async () => {
    const ctx = setup();
    await sendAndAwait(ctx, {
      ...SEND,
      text: 'Meet me. !startscene-nowindow the-shrine',
    });

    const events = ctx.storage.eventLog.readSince(0);
    // Attempt 1 lacked wait_hours → the correction round supplied it:
    // exactly ONE committed reply and ONE scene; no red line.
    expect(events.filter((e) => e.type === 'scene.started')).toHaveLength(1);
    expect(events.some((e) => e.type === 'chat.notice')).toBe(false);
    expect(
      events.filter(
        (e) =>
          e.type === 'chat.message_committed' &&
          e.payload.sender === 'character',
      ),
    ).toHaveLength(1);
    const started = events.find((e) => e.type === 'scene.started');
    if (started?.type === 'scene.started') {
      expect(started.payload.invitation?.wait_hours).toBe(6);
    }
    ctx.storage.close();
  });

  it('a stubborn malformed startscene exhausts the ceiling: rollback + the red-line notice, chat continues', async () => {
    const ctx = setup();
    await sendAndAwait(ctx, {
      ...SEND,
      text: 'Meet me. !startscene-stubborn the-shrine',
    });

    const events = ctx.storage.eventLog.readSince(0);
    // Rollback (owner ruling 2026-07-11): the tool fire never happened — no
    // scene, chat still open — while the reply itself stays durable and the
    // hardcoded chat.notice names the failure.
    expect(events.some((e) => e.type === 'scene.started')).toBe(false);
    expect(events.some((e) => e.type === 'chat.ended')).toBe(false);
    const notice = events.find((e) => e.type === 'chat.notice');
    expect(notice).toBeDefined();
    if (notice?.type === 'chat.notice') {
      expect(notice.payload.code).toBe('startscene_rejected');
      expect(notice.payload.character_id).toBe('char:elias');
    }
    expect(
      events.filter(
        (e) =>
          e.type === 'chat.message_committed' &&
          e.payload.sender === 'character',
      ),
    ).toHaveLength(1);
    ctx.storage.close();
  });

  it('the bridge ends a still-open scene before opening the meeting (one active scene, M6 part 3)', async () => {
    const ctx = setup({ drainOnKick: true });
    await sendAndAwait(ctx, SEND);
    // The user wandered into a scene and left it open (the debug-session
    // bug shape: abandoning it would hold its cast in_scene forever).
    const old = ctx.lifecycle.openScene({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's-old',
      title: 'A scene left open',
      participants: [],
    });
    expect(old.ok).toBe(true);

    const bridged = await ctx.engine.startSceneFromChat({
      world_id: 'w1',
      actor_id: 'user:owner',
      character_id: 'char:elias',
      scene_id: 's-chat-3',
      title: 'Meeting at the inn',
      place: 'The Common Room',
    });
    expect(bridged.ok).toBe(true);

    const events = ctx.storage.eventLog.readSince(0);
    const oldEnded = events.find(
      (e) => e.type === 'scene.ended' && e.payload.scene_id === 's-old',
    );
    expect(oldEnded).toBeDefined();
    // The end came with its FULL fan-out (never a bare scene.ended).
    expect(ctx.storage.ledger.countByKey('world_agent:s-old')).toBe(1);
    // Exactly one scene remains open: the meeting.
    const endedIds = new Set(
      events
        .filter((e) => e.type === 'scene.ended')
        .map((e) => e.payload.scene_id),
    );
    const stillOpen = events
      .filter((e) => e.type === 'scene.started')
      .filter((e) => !endedIds.has(e.payload.scene_id));
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0]?.payload.scene_id).toBe('s-chat-3');
    ctx.storage.close();
  });

  it('the bridge gives up as a value when the end fan-out never drains — the chat stays open', async () => {
    // No drainOnKick: the ended scene’s reflection/World-Agent jobs stay
    // active, so the open keeps 409ing and the bounded wait must give up.
    const ctx = setup();
    await sendAndAwait(ctx, SEND);
    const old = ctx.lifecycle.openScene({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's-old',
      title: 'A scene left open',
      participants: [],
    });
    expect(old.ok).toBe(true);

    const bridged = await ctx.engine.startSceneFromChat({
      world_id: 'w1',
      actor_id: 'user:owner',
      character_id: 'char:elias',
      scene_id: 's-chat-4',
      title: 'Meeting at the inn',
      place: 'The Common Room',
    });
    expect(bridged.ok).toBe(false);
    if (!bridged.ok) {
      expect(bridged.error.code).toBe('blocked_on_pending_jobs');
    }
    // Nothing half-done: no meeting scene, and the chat range is still open
    // (the idle sweep or a retry heals from here — Rev 4 §8).
    const events = ctx.storage.eventLog.readSince(0);
    expect(
      events.some(
        (e) => e.type === 'scene.started' && e.payload.scene_id === 's-chat-4',
      ),
    ).toBe(false);
    expect(events.some((e) => e.type === 'chat.ended')).toBe(false);
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
