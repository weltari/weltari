// The gateway-onboarding GM message (M7 part 2, Rev 4 §13, criterion e):
// fires ONCE PER BINDING, ever — the first inbound from a (connector,
// messenger conversation) pair records gateway.binding_established + the GM
// welcome line in one transaction and pushes the welcome; every later
// inbound from that pair binds nothing. Durable-first: a crashed push never
// re-fires the welcome.
import { describe, expect, it } from 'vitest';
import type { WeltariEvent } from '@weltari/protocol';
import { createChatEngine } from '../../apps/server/src/engine/chat.js';
import { createEventSink } from '../../apps/server/src/engine/event-sink.js';
import {
  buildEliasProfile,
  buildMaraProfile,
} from '../../apps/server/src/engine/fixture/rainy-inn.js';
import { GM_CHARACTER_ID } from '../../apps/server/src/engine/gm.js';
import {
  createChatGatewayBridge,
  GM_GATEWAY_WELCOME,
} from '../../apps/server/src/gateway/chat-bridge.js';
import { createFakeLlmClient } from '../../apps/server/src/llm/fake-client.js';
import { ok } from '../../apps/server/src/errors.js';
import { Bus } from '../../apps/server/src/http/bus.js';
import type { Storage } from '../../apps/server/src/storage/db.js';
import { captureLogger } from '../helpers/capture-logger.js';
import { tempStorage } from '../helpers/temp-storage.js';

function setup(): {
  storage: Storage;
  bridge: ReturnType<typeof createChatGatewayBridge>;
  pushes: { chatId: string; text: string }[];
} {
  const { logger } = captureLogger();
  const storage = tempStorage();
  const eventBus = new Bus<WeltariEvent>(logger);
  const sink = createEventSink(storage, eventBus);
  const chatEngine = createChatEngine({
    storage,
    sink,
    eventBus,
    llm: createFakeLlmClient(),
    logger,
    profiles: [buildEliasProfile(100), buildMaraProfile()],
    idleCutoffIso: () => '2000-01-01T00:00:00.000Z',
    openScene: () => ok({ opened: true as const }),
    endScene: () => ok({ jobsEnqueued: 0 }),
  });
  const pushes: { chatId: string; text: string }[] = [];
  const bridge = createChatGatewayBridge({
    storage,
    sink,
    logger,
    profiles: [buildEliasProfile(100), buildMaraProfile()],
    actorId: 'user:owner',
    worldId: 'w1',
    connectorId: 'telegram',
    sendChat: (command) => chatEngine.sendMessage(command),
    push: async (chatId, text) => {
      pushes.push({ chatId, text });
      return Promise.resolve({ ok: true });
    },
  });
  return { storage, bridge, pushes };
}

function bindings(storage: Storage): number {
  return storage.eventLog
    .readSince(0, 100000)
    .filter((e) => e.type === 'gateway.binding_established').length;
}

function welcomeLines(storage: Storage): number {
  return storage.eventLog
    .readSince(0, 100000)
    .filter(
      (e) =>
        e.type === 'chat.message_committed' &&
        e.actor_id === GM_CHARACTER_ID &&
        e.payload.text === GM_GATEWAY_WELCOME,
    ).length;
}

describe('criterion e — the GM onboarding message fires once per binding', () => {
  it('the first inbound binds + welcomes; the second binds nothing', async () => {
    const ctx = setup();
    const first = await ctx.bridge.route('424242', 'hello', 'm-1');
    expect(first.ok).toBe(true);
    expect(bindings(ctx.storage)).toBe(1);
    expect(welcomeLines(ctx.storage)).toBe(1);
    expect(
      ctx.pushes.filter((p) => p.text === GM_GATEWAY_WELCOME),
    ).toHaveLength(1);

    const second = await ctx.bridge.route('424242', 'hello again', 'm-2');
    expect(second.ok).toBe(true);
    expect(bindings(ctx.storage)).toBe(1);
    expect(welcomeLines(ctx.storage)).toBe(1);
    expect(
      ctx.pushes.filter((p) => p.text === GM_GATEWAY_WELCOME),
    ).toHaveLength(1);
  });

  it('a different messenger conversation is its own binding', async () => {
    const ctx = setup();
    await ctx.bridge.route('424242', 'hello', 'm-1');
    await ctx.bridge.route('535353', 'hello from another chat', 'm-3');
    expect(bindings(ctx.storage)).toBe(2);
    // The welcome line is idempotent per binding (its message_id carries
    // the pair), so both bindings hold their own GM line.
    expect(welcomeLines(ctx.storage)).toBe(2);
  });
});
