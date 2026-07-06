// The bundled Telegram connector — grammY is import-fenced here (A11).
// Long-polling only (Brief §7c NAT-first: outbound getUpdates, no webhook, no
// public endpoint). Thin by design: raw updates are validated with our own
// schema (B7 — never trust the library's compile-time types), mapped to the
// SDK's InboundMessage, and everything else (cap, dedup, turns) is the host's.
import { Bot } from 'grammy';
import { z } from 'zod';
import type {
  ConnectorHealth,
  GatewayConnector,
  InboundMessage,
  SendResult,
} from '@weltari/plugin-sdk';
import type { Logger } from '../../observability/logger.js';

// Third-party payload: plain z.object — unknown keys stripped, never trusted
// (B5; Telegram shipping a new field must not break ingestion).
const updateSchema = z.object({
  message: z
    .object({
      message_id: z.number().int(),
      chat: z.object({ id: z.number().int() }),
      text: z.string().optional(),
    })
    .optional(),
});

/**
 * Pure mapping seam (unit-tested without network): raw update -> InboundMessage
 * or null for anything that is not a plain text message. message_id is only
 * unique per chat, so the dedup key carries the chat prefix.
 */
export function mapUpdate(raw: unknown): InboundMessage | null {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return null;
  const message = parsed.data.message;
  if (message?.text === undefined || message.text.length === 0) return null;
  return {
    external_msg_id: `${String(message.chat.id)}:${String(message.message_id)}`,
    conversation_id: String(message.chat.id),
    text: message.text,
  };
}

export interface TelegramConnectorOptions {
  /** Secret — env-only via boundary/config/env.ts (B15), never committed. */
  token: string;
  logger: Logger;
}

export function createTelegramConnector(
  options: TelegramConnectorOptions,
): GatewayConnector {
  const { token, logger } = options;
  let bot: Bot | null = null;
  let health: ConnectorHealth = 'stopped';
  let listener: ((message: InboundMessage) => void) | null = null;

  return {
    id: 'telegram',
    onInbound(next: (message: InboundMessage) => void): void {
      listener = next;
    },
    async start(): Promise<void> {
      if (bot !== null) return; // idempotent
      const instance = new Bot(token);
      bot = instance;
      instance.on('message', (ctx) => {
        const raw: unknown = ctx.update;
        const mapped = mapUpdate(raw);
        if (mapped === null) return; // non-text updates are not ours
        listener?.(mapped);
      });
      instance.catch((error) => {
        // CATCH-OK: grammY surfaces per-update middleware errors here; the
        // poller keeps running — degraded, not dead (B8 posture).
        health = 'degraded';
        logger.warn({ err: error.error }, 'telegram middleware error');
      });
      await new Promise<void>((resolve, reject) => {
        // bot.start resolves only when polling STOPS — long-running by design.
        instance
          .start({
            onStart: () => {
              health = 'ok';
              resolve();
            },
          })
          .catch((thrown: unknown) => {
            health = 'degraded';
            logger.warn({ err: thrown }, 'telegram long-poll ended with error');
            reject(
              thrown instanceof Error ? thrown : new Error(String(thrown)),
            );
          });
      });
    },
    async stop(): Promise<void> {
      if (bot === null) return; // idempotent
      const instance = bot;
      bot = null;
      health = 'stopped';
      await instance.stop();
    },
    async send(conversationId: string, text: string): Promise<SendResult> {
      if (bot === null || health === 'stopped') {
        return { ok: false, error: 'stopped' };
      }
      try {
        await bot.api.sendMessage(Number(conversationId), text);
        return { ok: true };
      } catch (thrown) {
        // CATCH-OK: C2 — delivery failure is operational, returned as a value.
        logger.warn({ err: thrown }, 'telegram send failed');
        return { ok: false, error: 'send_failed' };
      }
    },
    health(): ConnectorHealth {
      return health;
    },
  };
}
