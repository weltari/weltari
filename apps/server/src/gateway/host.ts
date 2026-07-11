// The connector host — B7 lives HERE, not in connectors: everything a
// connector delivers is boundary data (B10), so the host re-validates with
// its own Zod schema, caps text at 8 KB before it can enter a prompt, and
// deduplicates via the gateway_inbound UNIQUE insert. A connector cannot
// corrupt the engine by lying; it can only fail to deliver.
import type { GatewayConnector, ConnectorHealth } from '@weltari/plugin-sdk';
import { z } from 'zod';
import { validateAt, type Boundary } from '../boundary/validate.js';
import type { Result } from '../errors.js';
import type { Logger } from '../observability/logger.js';
import { catchAndLog } from '../observability/catch-and-log.js';
import type { Storage } from '../storage/db.js';

export const INBOUND_TEXT_CAP = 8192;

/** Own schema — never trust the connector's compile-time types (B7). */
const inboundSchema = z.strictObject({
  external_msg_id: z.string().min(1).max(200),
  conversation_id: z.string().min(1).max(200),
  text: z.string().min(1),
});

export interface RegisteredConnector {
  connector: GatewayConnector;
  /** Which trust boundary this connector's traffic enters through (B3). */
  boundary: Boundary;
}

export interface GatewayHostOptions {
  storage: Storage;
  logger: Logger;
  connectors: readonly RegisteredConnector[];
  /**
   * Engine seam: route dedup'd, capped inbound text and resolve with the
   * reply body to send back. M6 part 4: the external message id rides along
   * (the chat bridge reuses it as the send's idempotency token — a
   * redelivery that somehow passed the dedup still cannot twin the line).
   */
  runTurn: (
    conversationId: string,
    text: string,
    externalMsgId: string,
  ) => Promise<Result<string>>;
}

export interface GatewayHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Record<string, ConnectorHealth>;
}

export function createGatewayHost(options: GatewayHostOptions): GatewayHost {
  const { storage, logger, connectors, runTurn } = options;

  async function handleInbound(
    registered: RegisteredConnector,
    raw: unknown,
  ): Promise<void> {
    const { connector } = registered;
    const validated = validateAt(
      registered.boundary,
      'GatewayInboundMessage',
      inboundSchema,
      raw,
      logger,
    );
    if (!validated.ok) return; // rejected + logged by validateAt (B4)

    const message = validated.value;
    const text = message.text.slice(0, INBOUND_TEXT_CAP); // capped, never truncated mid-prompt-injection-check (B7)
    const first = storage.gateway.recordInbound({
      connector_id: connector.id,
      external_msg_id: message.external_msg_id,
      conversation_id: message.conversation_id,
      text,
    });
    if (!first) {
      logger.debug(
        {
          connector_id: connector.id,
          external_msg_id: message.external_msg_id,
        },
        'duplicate inbound dropped (B7)',
      );
      return;
    }

    const turn = await runTurn(
      message.conversation_id,
      text,
      message.external_msg_id,
    );
    if (!turn.ok) {
      logger.warn(
        { connector_id: connector.id, code: turn.error.code },
        'gateway turn failed — nothing echoed',
      );
      return;
    }
    const sent = await connector.send(message.conversation_id, turn.value);
    if (!sent.ok) {
      logger.warn(
        { connector_id: connector.id, error: sent.error },
        'gateway echo send failed',
      );
    }
  }

  return {
    async start(): Promise<void> {
      for (const registered of connectors) {
        registered.connector.onInbound((message) => {
          catchAndLog(
            handleInbound(registered, message),
            logger,
            `gateway.${registered.connector.id}`,
          );
        });
        await registered.connector.start();
        logger.info(
          { connector_id: registered.connector.id },
          'gateway connector started',
        );
      }
    },
    async stop(): Promise<void> {
      for (const registered of connectors) {
        await registered.connector.stop();
      }
    },
    health(): Record<string, ConnectorHealth> {
      const states: Record<string, ConnectorHealth> = {};
      for (const registered of connectors) {
        states[registered.connector.id] = registered.connector.health();
      }
      return states;
    },
  };
}
