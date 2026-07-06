// The GatewayConnector conformance suite (FINAL risk register #2): pure
// framework-free checks so any community connector repo can run them under
// any test runner. Weltari's own tests drive them through vitest; a plugin
// author can call runGatewayConnectorConformance() in a plain script.
import type { ConnectorHealth, GatewayConnector } from './gateway-connector.js';

export interface ConformanceResult {
  check: string;
  ok: boolean;
  detail?: string;
}

const HEALTH_STATES: readonly ConnectorHealth[] = [
  'ok',
  'degraded',
  'paused',
  'stopped',
];

/**
 * Runs every check against a FRESH connector from the factory. Checks are
 * behavioral only — they never send real network traffic; a connector whose
 * start() needs credentials should be handed in stubbed/offline mode.
 */
export async function runGatewayConnectorConformance(
  factory: () => GatewayConnector,
): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  const record = (check: string, ok: boolean, detail?: string): void => {
    results.push(detail === undefined ? { check, ok } : { check, ok, detail });
  };

  {
    const connector = factory();
    record('id is a non-empty string', connector.id.length > 0);
    record(
      'health() is a known state before start',
      HEALTH_STATES.includes(connector.health()),
    );
  }

  {
    const connector = factory();
    try {
      connector.onInbound(() => undefined);
      await connector.start();
      record(
        'health() is a known state after start',
        HEALTH_STATES.includes(connector.health()),
      );
      await connector.start(); // idempotence
      record('start() is idempotent', true);
      await connector.stop();
      await connector.stop(); // idempotence
      record('stop() is idempotent', true);
      record(
        'health() reports stopped after stop',
        connector.health() === 'stopped',
      );
    } catch (thrown) {
      record(
        'start/stop lifecycle never throws',
        false,
        thrown instanceof Error ? thrown.message : String(thrown),
      );
    }
  }

  {
    const connector = factory();
    try {
      const result = await connector.send('conformance-conversation', 'ping');
      record(
        'send() while stopped returns { ok: false } instead of throwing',
        !result.ok,
      );
    } catch (thrown) {
      record(
        'send() while stopped returns { ok: false } instead of throwing',
        false,
        thrown instanceof Error ? thrown.message : String(thrown),
      );
    }
  }

  return results;
}
