import { describe, expect, it } from 'vitest';
import { runGatewayConnectorConformance } from './conformance.js';
import type {
  ConnectorHealth,
  GatewayConnector,
  InboundMessage,
  SendResult,
} from './gateway-connector.js';

/** Reference in-memory connector — the shape every bridge should mirror. */
function referenceConnector(): GatewayConnector {
  let health: ConnectorHealth = 'stopped';
  let listener: ((message: InboundMessage) => void) | null = null;
  return {
    id: 'reference',
    async start(): Promise<void> {
      health = 'ok';
      return Promise.resolve();
    },
    async stop(): Promise<void> {
      health = 'stopped';
      listener = null;
      return Promise.resolve();
    },
    async send(): Promise<SendResult> {
      if (health !== 'ok') {
        return Promise.resolve({ ok: false, error: 'stopped' });
      }
      return Promise.resolve({ ok: true });
    },
    onInbound(next: (message: InboundMessage) => void): void {
      listener = next;
    },
    health(): ConnectorHealth {
      void listener;
      return health;
    },
  };
}

/** A broken connector: throws on send while stopped. */
function throwingConnector(): GatewayConnector {
  const base = referenceConnector();
  return {
    ...base,
    id: 'throwing',
    async send(): Promise<SendResult> {
      return Promise.reject(new Error('boom'));
    },
  };
}

describe('gateway connector conformance suite', () => {
  it('the reference connector passes every check', async () => {
    const results = await runGatewayConnectorConformance(referenceConnector);
    expect(results.length).toBeGreaterThanOrEqual(6);
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });

  it('a connector that throws from send() fails that check with a detail', async () => {
    const results = await runGatewayConnectorConformance(throwingConnector);
    const sendCheck = results.find((r) =>
      r.check.startsWith('send() while stopped'),
    );
    expect(sendCheck?.ok).toBe(false);
    expect(sendCheck?.detail).toBe('boom');
  });
});
