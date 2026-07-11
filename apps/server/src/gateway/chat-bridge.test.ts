// The chat↔messenger bridge (M6 part 4, Rev 4 §13, criterion c): pushes
// carry the SAME content as the thread; the return path lands in the SAME
// conversation_id and a webhook redelivery never twins it; the frozen-thread
// notice is hardcoded text.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { InboundMessage } from '@weltari/plugin-sdk';
import { Bus, type EventBus } from '../http/bus.js';
import { createFakeLlmClient } from '../llm/fake-client.js';
import { createRootLogger } from '../observability/logger.js';
import { openStorage, type Storage } from '../storage/db.js';
import { createChatEngine, conversationIdFor } from '../engine/chat.js';
import { createEventSink } from '../engine/event-sink.js';
import {
  buildEliasProfile,
  buildMaraProfile,
} from '../engine/fixture/rainy-inn.js';
import { createSceneLifecycle } from '../engine/scene-lifecycle.js';
import { createChatGatewayBridge } from './chat-bridge.js';
import { createGatewayHost } from './host.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sinkStream = new Writable({
    write(_c, _e, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sinkStream });
}

const ELIAS = buildEliasProfile(100);
const MARA = buildMaraProfile();

interface Ctx {
  storage: Storage;
  eventBus: EventBus;
  bridge: ReturnType<typeof createChatGatewayBridge>;
  pushes: { chatId: string; text: string }[];
}

function setup(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'weltari-bridge-'));
  const logger = quietLogger();
  const storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
  const eventBus: EventBus = new Bus(logger);
  const lifecycle = createSceneLifecycle({
    storage,
    eventBus,
    logger,
    knownCharacters: [{ character_id: ELIAS.character_id, name: ELIAS.name }],
  });
  const chatEngine = createChatEngine({
    storage,
    sink: createEventSink(storage, eventBus),
    eventBus,
    llm: createFakeLlmClient(),
    logger,
    profiles: [ELIAS, MARA],
    idleCutoffIso: (): string => '2000-01-01T00:00:00.000Z',
    openScene: (request) => lifecycle.openScene(request),
    endScene: (command) => lifecycle.endScene(command),
    bridgeRetryDelayMs: 1,
  });
  const pushes: { chatId: string; text: string }[] = [];
  const bridge = createChatGatewayBridge({
    storage,
    logger,
    profiles: [ELIAS, MARA],
    actorId: 'user:owner',
    worldId: 'w1',
    connectorId: 'telegram',
    sendChat: (command) => chatEngine.sendMessage(command),
    push: async (chatId, text) => {
      pushes.push({ chatId, text });
      return Promise.resolve({ ok: true });
    },
  });
  eventBus.subscribe((event) => {
    bridge.onDurableEvent(event);
  });
  return { storage, eventBus, bridge, pushes };
}

/** The user "connected the bot": one inbound row = the V1 subscription. */
function subscribe(ctx: Ctx, chatId = '424242'): void {
  ctx.storage.gateway.recordInbound({
    connector_id: 'telegram',
    external_msg_id: `${chatId}:0`,
    conversation_id: chatId,
    text: '/start',
  });
}

describe('gateway chat bridge (criterion c)', () => {
  it('an eager CRON DM pushes the SAME text as the thread; the freeze notice is hardcoded', () => {
    const ctx = setup();
    subscribe(ctx);
    const conversationId = conversationIdFor('user:owner', ELIAS.character_id);
    const sink = createEventSink(ctx.storage, ctx.eventBus);
    // The proactive fire's committed pair, exactly as the handler appends it.
    sink.appendMany([
      {
        world_id: 'w1',
        actor_id: ELIAS.character_id,
        type: 'chat.message_committed',
        payload: {
          conversation_id: conversationId,
          character_id: ELIAS.character_id,
          sender: 'character',
          text: 'The bell stayed silent again. Thought you should know.',
          message_id: 'outreach-push-1',
        },
      },
      {
        world_id: 'w1',
        actor_id: ELIAS.character_id,
        type: 'chat.outreach_recorded',
        payload: {
          conversation_id: conversationId,
          character_id: ELIAS.character_id,
          occurrence_iso: '2000-01-02T00:00:00.000Z',
          game_time: '2000-01-02T06:00:00.000Z',
          message_id: 'outreach-push-1',
          unanswered_count: 3,
        },
      },
      {
        world_id: 'w1',
        actor_id: ELIAS.character_id,
        type: 'chat.thread_frozen',
        payload: {
          conversation_id: conversationId,
          character_id: ELIAS.character_id,
          message_id: 'outreach-push-1',
          unanswered_count: 3,
        },
      },
    ]);
    expect(ctx.pushes).toHaveLength(2);
    expect(ctx.pushes[0]).toEqual({
      chatId: '424242',
      text: `${ELIAS.name}: The bell stayed silent again. Thought you should know.`,
    });
    expect(ctx.pushes[1]?.text).toBe(
      `${ELIAS.name} is waiting for you to reply.`,
    );
    ctx.storage.close();
  });

  it('no subscriber → no push (the thread still holds everything)', () => {
    const ctx = setup();
    const sink = createEventSink(ctx.storage, ctx.eventBus);
    sink.append({
      world_id: 'w1',
      actor_id: ELIAS.character_id,
      type: 'chat.thread_frozen',
      payload: {
        conversation_id: conversationIdFor('user:owner', ELIAS.character_id),
        character_id: ELIAS.character_id,
        message_id: 'outreach-x',
        unanswered_count: 3,
      },
    });
    expect(ctx.pushes).toHaveLength(0);
    ctx.storage.close();
  });

  it('the return path lands in the SAME conversation and a webhook redelivery never twins it', async () => {
    const ctx = setup();
    subscribe(ctx);
    // The host owns dedup (gateway_inbound UNIQUE): deliver the SAME
    // messenger message twice through a fake connector.
    const emitters: ((message: InboundMessage) => void)[] = [];
    const sends: string[] = [];
    const host = createGatewayHost({
      storage: ctx.storage,
      logger: quietLogger(),
      connectors: [
        {
          connector: {
            id: 'telegram',
            onInbound: (next): void => {
              emitters.push(next);
            },
            start: async (): Promise<void> => Promise.resolve(),
            stop: async (): Promise<void> => Promise.resolve(),
            send: async (_chat, text): Promise<{ ok: true }> => {
              sends.push(text);
              return Promise.resolve({ ok: true });
            },
            health: () => 'ok' as const,
          },
          boundary: 'telegram',
        },
      ],
      runTurn: async (chatId, text, externalMsgId) =>
        ctx.bridge.route(chatId, text, externalMsgId),
    });
    await host.start();
    const redelivered: InboundMessage = {
      external_msg_id: '424242:77',
      conversation_id: '424242',
      text: 'On my way — is the bell still cracked?',
    };
    emitters[0]?.(redelivered);
    emitters[0]?.(redelivered); // the webhook redelivery
    await new Promise((resolve) => setTimeout(resolve, 300));

    const conversationId = conversationIdFor('user:owner', ELIAS.character_id);
    const userLines = ctx.storage.eventLog
      .readSince(0)
      .filter(
        (e) =>
          e.type === 'chat.message_committed' &&
          e.payload.conversation_id === conversationId &&
          e.payload.sender === 'user',
      );
    // Exactly ONE user line despite two deliveries — and it sits in the
    // SAME conversation_id the Weltari Chat thread uses.
    expect(userLines).toHaveLength(1);
    if (userLines[0]?.type === 'chat.message_committed') {
      expect(userLines[0].payload.text).toBe(
        'On my way — is the bell still cracked?',
      );
    }
    // The reply echoed back to the messenger exactly once.
    expect(sends).toHaveLength(1);
    await host.stop();
    ctx.storage.close();
  });
});
