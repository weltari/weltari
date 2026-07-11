// The chat↔messenger bridge (M6 part 4, Rev 4 §13): the messenger is a VIEW
// of Weltari Chat, never a separate channel. Outbound: only CRON DMs are
// pushed — their content was eagerly generated and committed at fire time
// (chat.outreach_recorded), so the push carries the SAME text the thread
// shows; the frozen-thread hook pushes the hardcoded "waiting for you to
// reply" notice off chat.thread_frozen (owner ruling 2026-07-10: Weltari
// Chat itself shows nothing). Inbound: the host's dedup'd, capped text
// routes into the SAME conversation_id via the normal send seam (request_id
// = the messenger message id, so even a dedup miss cannot twin the line)
// and the character's reply is returned for the messenger echo.
//
// Subscription (V1): messaging the bot once IS subscribing — pushes go to
// the connector chat that last talked to us (the gateway_inbound projection).
// Pushes ride the LIVE event bus only (never the replay), so a restart can
// never re-push old fires.
import type { WeltariEvent } from '@weltari/protocol';
import { ok, type Result } from '../errors.js';
import type { CharacterProfile } from '../engine/context-assembler.js';
import type { ChatEngine } from '../engine/chat.js';
import { conversationIdFor } from '../engine/chat.js';
import { catchAndLog } from '../observability/catch-and-log.js';
import type { Logger } from '../observability/logger.js';
import type { Storage } from '../storage/db.js';

export interface ChatGatewayBridgeOptions {
  storage: Storage;
  logger: Logger;
  profiles: readonly CharacterProfile[];
  actorId: string;
  worldId: string;
  /** The connector this bridge pushes through ('telegram' in V1). */
  connectorId: string;
  sendChat: ChatEngine['sendMessage'];
  /** The connector's send seam (main binds the Telegram connector; tests a
   * recorder). Failures are values — a lost push loses nothing durable. */
  push: (chatId: string, text: string) => Promise<{ ok: boolean }>;
}

export interface ChatGatewayBridge {
  /** The host's route seam: inbound messenger text → Weltari Chat →
   * resolve with the reply text to echo back. */
  route(
    chatId: string,
    text: string,
    externalMsgId: string,
  ): Promise<Result<string>>;
  /** Live event-bus subscriber: pushes eager CRON DMs + the freeze notice. */
  onDurableEvent(event: WeltariEvent): void;
}

export function createChatGatewayBridge(
  options: ChatGatewayBridgeOptions,
): ChatGatewayBridge {
  const { storage, logger, profiles, actorId, worldId } = options;

  function nameOf(characterId: string): string {
    return (
      profiles.find((p) => p.character_id === characterId)?.name ?? 'Someone'
    );
  }

  /** The reply target: the character of the newest outreach (you answer the
   * text you received), else the first roster character. Deterministic. */
  function targetCharacterId(): string {
    let latest: string | undefined;
    for (const event of storage.eventLog.readSince(0, 100000)) {
      if (
        event.type === 'chat.outreach_recorded' &&
        event.world_id === worldId
      ) {
        latest = event.payload.character_id;
      }
    }
    return latest ?? profiles[0]?.character_id ?? '';
  }

  /** The delivered message's text, by (conversation, message id) — the push
   * must carry the SAME content the thread shows (criterion c). */
  function messageText(
    conversationId: string,
    messageId: string,
  ): string | null {
    for (const event of storage.eventLog.readSince(0, 100000)) {
      if (
        event.type === 'chat.message_committed' &&
        event.payload.conversation_id === conversationId &&
        event.payload.message_id === messageId
      ) {
        return event.payload.text;
      }
    }
    return null;
  }

  function latestCharacterLine(conversationId: string): string | null {
    let latest: string | null = null;
    for (const event of storage.eventLog.readSince(0, 100000)) {
      if (
        event.type === 'chat.message_committed' &&
        event.payload.conversation_id === conversationId &&
        event.payload.sender === 'character'
      ) {
        latest = event.payload.text;
      }
    }
    return latest;
  }

  function subscriberChatId(): string | null {
    return storage.gateway.latestConversationId(options.connectorId);
  }

  return {
    async route(
      _chatId: string,
      text: string,
      externalMsgId: string,
    ): Promise<Result<string>> {
      const characterId = targetCharacterId();
      const sent = options.sendChat({
        world_id: worldId,
        actor_id: actorId,
        character_id: characterId,
        text,
        // The messenger message id doubles as the chat idempotency token —
        // a redelivery that somehow passes the host's dedup still cannot
        // twin the line (belt and braces, criterion c).
        request_id: `tg:${externalMsgId}`.slice(0, 100),
      });
      if (!sent.ok) return sent;
      if (!sent.value.replying) {
        // The presence rule (Rev 4 §8): stored, read when the scene ends —
        // hardcoded text, never an LLM call.
        return ok(
          `${nameOf(characterId)} is in a scene right now — your message will be read when it ends.`,
        );
      }
      await sent.value.completion;
      const reply = latestCharacterLine(
        conversationIdFor(actorId, characterId),
      );
      return ok(reply ?? `${nameOf(characterId)} read your message.`);
    },

    onDurableEvent(event: WeltariEvent): void {
      if (
        event.type !== 'chat.outreach_recorded' &&
        event.type !== 'chat.thread_frozen'
      ) {
        return;
      }
      const chatId = subscriberChatId();
      if (chatId === null) return; // nobody connected the bot — nothing to push
      if (event.type === 'chat.outreach_recorded') {
        const text = messageText(
          event.payload.conversation_id,
          event.payload.message_id,
        );
        if (text === null) return;
        catchAndLog(
          options
            .push(chatId, `${nameOf(event.payload.character_id)}: ${text}`)
            .then((sent) => {
              if (!sent.ok) {
                logger.warn(
                  { conversation_id: event.payload.conversation_id },
                  'gateway push failed — the thread still holds the message',
                );
              }
            }),
          logger,
          'gateway.push',
        );
      } else {
        // The frozen-thread notice (owner rulings 2026-07-10/11): hardcoded
        // text, pushed ONLY to the messenger — Weltari Chat shows nothing.
        catchAndLog(
          options
            .push(
              chatId,
              `${nameOf(event.payload.character_id)} is waiting for you to reply.`,
            )
            .then((sent) => {
              if (!sent.ok) {
                logger.warn(
                  { conversation_id: event.payload.conversation_id },
                  'gateway freeze-notice push failed',
                );
              }
            }),
          logger,
          'gateway.push',
        );
      }
    },
  };
}
