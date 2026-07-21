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
import type { EventSink } from '../engine/event-sink.js';
import { characterProfilesOf } from '../engine/characters.js';
import { GM_CHARACTER_ID } from '../engine/gm.js';
import { catchAndLog } from '../observability/catch-and-log.js';
import type { Logger } from '../observability/logger.js';
import type { Storage } from '../storage/db.js';

/** The one-time GM onboarding message (M7 part 2, Rev 4 §13 + criterion e):
 * fired once per (connector, messenger conversation) binding, ever —
 * hardcoded text, pushed to the messenger AND recorded as a durable GM line
 * in Weltari Chat (the messenger is a view; both sides must show it). */
export const GM_GATEWAY_WELCOME =
  'GM here — you are connected. This messenger is now a window into Weltari: characters who message you will reach you here, and whatever you send goes straight back into the conversation you are answering. Talk to me any time to adjust what gets pushed.';

export interface ChatGatewayBridgeOptions {
  storage: Storage;
  /** The binding record + the GM welcome line commit through here (M7
   * part 2) — durable BEFORE the push, so a crashed push never re-fires
   * the once-per-binding welcome. */
  sink: EventSink;
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
  const { storage, sink, logger, profiles, actorId, worldId } = options;

  // Week 19 (audit item 2, the 6a657d9 pattern): the bridge roster folds
  // LIVE — seeds ∪ character.created — so minted characters name and route
  // correctly without a restart.
  function liveRoster(): readonly CharacterProfile[] {
    return characterProfilesOf(storage, worldId, profiles);
  }

  function nameOf(characterId: string): string {
    return (
      liveRoster().find((p) => p.character_id === characterId)?.name ??
      'Someone'
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
    return latest ?? liveRoster()[0]?.character_id ?? '';
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

  /** True when this (connector, messenger conversation) pair has bound
   * before — the once-per-binding fold (idempotent across restarts and
   * redeliveries: the record is a durable event). */
  function bindingKnown(chatId: string): boolean {
    return storage.eventLog
      .readSince(0, 100000)
      .some(
        (event) =>
          event.type === 'gateway.binding_established' &&
          event.payload.connector_id === options.connectorId &&
          event.payload.conversation_id === chatId,
      );
  }

  /** The first-ever sight of a messenger conversation (criterion e): record
   * the binding + the GM welcome line in ONE transaction, then push the
   * welcome. No await between the fold check and the append — a racing
   * second inbound cannot double-bind. */
  function establishBindingIfNew(chatId: string): void {
    if (bindingKnown(chatId)) return;
    sink.appendMany([
      {
        world_id: worldId,
        actor_id: 'system:gateway',
        type: 'gateway.binding_established',
        payload: {
          connector_id: options.connectorId,
          conversation_id: chatId,
        },
      },
      {
        world_id: worldId,
        actor_id: GM_CHARACTER_ID,
        type: 'chat.message_committed',
        payload: {
          conversation_id: conversationIdFor(actorId, GM_CHARACTER_ID),
          character_id: GM_CHARACTER_ID,
          sender: 'character',
          text: GM_GATEWAY_WELCOME,
          message_id:
            `gm-gateway-welcome:${options.connectorId}:${chatId}`.slice(0, 100),
        },
      },
    ]);
    catchAndLog(
      options.push(chatId, GM_GATEWAY_WELCOME).then((sent) => {
        if (!sent.ok) {
          logger.warn(
            { connector_id: options.connectorId },
            'GM onboarding push failed — the binding is durable, the thread holds the welcome',
          );
        }
      }),
      logger,
      'gateway.push',
    );
    logger.info(
      { connector_id: options.connectorId },
      'gateway binding established — GM onboarding sent (once per binding)',
    );
  }

  return {
    async route(
      chatId: string,
      text: string,
      externalMsgId: string,
    ): Promise<Result<string>> {
      establishBindingIfNew(chatId);
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
