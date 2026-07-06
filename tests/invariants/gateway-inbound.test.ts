// I10 boundary fixtures for the gateway (Guide B7): duplicate delivery is
// exactly-once, oversized text is capped at 8 KB before it can reach a prompt,
// malformed updates are rejected with zero side effects — all enforced by the
// HOST against a connector it does not trust (B10). Dedup survives restart
// because it is a database UNIQUE constraint, not connector memory.
import { describe, expect, it } from 'vitest';
import type {
  ConnectorHealth,
  GatewayConnector,
  InboundMessage,
  SendResult,
} from '@weltari/plugin-sdk';
import {
  createGatewayHost,
  INBOUND_TEXT_CAP,
} from '../../apps/server/src/gateway/host.js';
import { ok, type Result } from '../../apps/server/src/errors.js';
import { captureLogger } from '../helpers/capture-logger.js';
import { tempStorage } from '../helpers/temp-storage.js';

interface FakeConnector extends GatewayConnector {
  deliver(raw: unknown): void;
  readonly sent: { conversationId: string; text: string }[];
}

function fakeConnector(): FakeConnector {
  let listener: ((message: InboundMessage) => void) | null = null;
  let health: ConnectorHealth = 'stopped';
  const sent: { conversationId: string; text: string }[] = [];
  return {
    id: 'fake',
    sent,
    deliver(raw: unknown): void {
      // A lying connector is exactly what B10 assumes; the host must validate.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- wrong-shaped boundary fixture fed as unknown (Guide §0.12); the host's validateAt is the code under test
      listener?.(raw as InboundMessage);
    },
    onInbound(next: (message: InboundMessage) => void): void {
      listener = next;
    },
    async start(): Promise<void> {
      health = 'ok';
      return Promise.resolve();
    },
    async stop(): Promise<void> {
      health = 'stopped';
      return Promise.resolve();
    },
    async send(conversationId: string, text: string): Promise<SendResult> {
      sent.push({ conversationId, text });
      return Promise.resolve({ ok: true });
    },
    health(): ConnectorHealth {
      return health;
    },
  };
}

/** Drain the detached inbound pipeline (promise chains only — no timers). */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function setup(): {
  connector: FakeConnector;
  turns: string[];
  storage: ReturnType<typeof tempStorage>;
  start: () => Promise<void>;
} {
  const storage = tempStorage();
  const { logger } = captureLogger();
  const connector = fakeConnector();
  const turns: string[] = [];
  const host = createGatewayHost({
    storage,
    logger,
    connectors: [{ connector, boundary: 'telegram' }],
    runTurn: async (_conversation, text): Promise<Result<string>> => {
      turns.push(text);
      return Promise.resolve(ok(`echo: ${text.length.toString()} chars`));
    },
  });
  return { connector, turns, storage, start: async () => host.start() };
}

const VALID = {
  external_msg_id: '42:1001',
  conversation_id: '42',
  text: 'Hello from Telegram',
};

describe('gateway inbound fixtures (I10 / B7)', () => {
  it('duplicate delivery runs exactly one turn and one echo', async () => {
    const ctx = setup();
    await ctx.start();
    ctx.connector.deliver(VALID);
    ctx.connector.deliver(VALID); // messenger redelivery
    await flush();
    expect(ctx.turns).toHaveLength(1);
    expect(ctx.connector.sent).toHaveLength(1);
  });

  it('dedup survives restart — it is a UNIQUE constraint, not memory', async () => {
    const ctx = setup();
    await ctx.start();
    ctx.connector.deliver(VALID);
    await flush();

    // Same storage, fresh host + connector = the post-restart world.
    const { logger } = captureLogger();
    const secondConnector = fakeConnector();
    const secondTurns: string[] = [];
    const secondHost = createGatewayHost({
      storage: ctx.storage,
      logger,
      connectors: [{ connector: secondConnector, boundary: 'telegram' }],
      runTurn: async (_c, text): Promise<Result<string>> => {
        secondTurns.push(text);
        return Promise.resolve(ok('echo'));
      },
    });
    await secondHost.start();
    secondConnector.deliver(VALID); // replay after restart
    await flush();
    expect(secondTurns).toHaveLength(0);
    expect(secondConnector.sent).toHaveLength(0);
  });

  it('oversized text is capped at 8 KB before it can enter a prompt', async () => {
    const ctx = setup();
    await ctx.start();
    ctx.connector.deliver({
      external_msg_id: '42:1002',
      conversation_id: '42',
      text: 'x'.repeat(INBOUND_TEXT_CAP + 5000),
    });
    await flush();
    expect(ctx.turns).toHaveLength(1);
    expect(ctx.turns[0]?.length).toBe(INBOUND_TEXT_CAP);
  });

  it('malformed updates are rejected with zero side effects', async () => {
    const ctx = setup();
    await ctx.start();
    ctx.connector.deliver({ conversation_id: '42', text: 'no msg id' });
    ctx.connector.deliver({ external_msg_id: '42:1003', text: 'no chat' });
    ctx.connector.deliver('not even an object');
    ctx.connector.deliver({
      external_msg_id: '42:1004',
      conversation_id: '42',
      text: 'smuggled key',
      admin: true, // strictObject: our own format rejects unknown keys (B5)
    });
    await flush();
    expect(ctx.turns).toHaveLength(0);
    expect(ctx.connector.sent).toHaveLength(0);
  });
});
