// Weltari Chat, part one (M6 part 2, Rev 4 §8): the DM core. A conversation
// is a PROJECTION of chat.message_committed / chat.ended events on the ONE
// event stream (owner decision 2026-07-09) — replay after a restart rebuilds
// the transcript exactly. Chat never changes the world: the only durable
// outputs are conversation history and the character's own CACHE line; world
// change stays scene territory (the startscene() bridge hands over to it).
//
// Crash-only shape: the user line is durable at the command seam; the reply
// generates DETACHED and only its committed event is durable (Guide B6) — a
// kill mid-generation loses one reply and nothing else.
import { randomUUID } from 'node:crypto';
import type {
  ExitChatCommand,
  SendChatMessageCommand,
  WeltariEvent,
} from '@weltari/protocol';
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { Logger } from '../observability/logger.js';
import type { EventBus } from '../http/bus.js';
import { parseChatToolCall } from '../llm/tools.js';
import type { LlmClient } from '../llm/types.js';
import type { Storage } from '../storage/db.js';
import { cacheRecapText, capCacheLine, latestPerOrigin } from './cache.js';
import {
  assembleContext,
  type CharacterProfile,
  type TurnLine,
} from './context-assembler.js';
import type { EventSink } from './event-sink.js';

/** How many recent transcript lines a chat reply sees (short context — chat
 * turns are the cheapest call class; deep recall arrives with the query
 * tools in part 3). */
const CHAT_TRANSCRIPT_LINES = 24;

export type Presence =
  { state: 'available' } | { state: 'in_scene'; scene_id: string };

/**
 * The presence projection (Rev 4 §4: presence is engine-owned, structured
 * state for code): a character is `in_scene` while a scene it joined is
 * still open. No table — derived from character.joined / scene.ended events.
 */
export function presenceOf(storage: Storage, characterId: string): Presence {
  const openScenes = new Set<string>();
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (
      event.type === 'character.joined' &&
      event.payload.character_id === characterId
    ) {
      openScenes.add(event.payload.scene_id);
    } else if (event.type === 'scene.ended') {
      openScenes.delete(event.payload.scene_id);
    }
  }
  const latest = [...openScenes].at(-1);
  return latest === undefined
    ? { state: 'available' }
    : { state: 'in_scene', scene_id: latest };
}

/** Stable per user+character pair (Rev 4 §8 privacy: keyed by actor_id — a
 * singleton in V1, load-bearing in V2). */
export function conversationIdFor(
  actorId: string,
  characterId: string,
): string {
  return `chat:${actorId}:${characterId}`;
}

interface ConversationState {
  /** Messages of the OPEN range (after the last chat.ended), oldest first. */
  openMessages: WeltariEvent[];
  /** All messages ever (the prompt transcript source), oldest first. */
  allMessages: WeltariEvent[];
  /** Event id of the last message overall (0 = none). */
  lastMessageId: number;
  /** Envelope ts of the last message in the open range ('' = none). */
  lastActivityTs: string;
}

function conversationState(
  storage: Storage,
  conversationId: string,
): ConversationState {
  const allMessages: WeltariEvent[] = [];
  let lastEndedAt = 0;
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (
      event.type === 'chat.message_committed' &&
      event.payload.conversation_id === conversationId
    ) {
      allMessages.push(event);
    } else if (
      event.type === 'chat.ended' &&
      event.payload.conversation_id === conversationId
    ) {
      lastEndedAt = event.id;
    }
  }
  const openMessages = allMessages.filter((m) => m.id > lastEndedAt);
  const last = allMessages.at(-1);
  const lastOpen = openMessages.at(-1);
  return {
    openMessages,
    allMessages,
    lastMessageId: last?.id ?? 0,
    lastActivityTs: lastOpen?.ts ?? '',
  };
}

export interface ChatEngineOptions {
  storage: Storage;
  sink: EventSink;
  /** chat.ended + its reflect_chat job commit in ONE transaction — the bus
   * publish happens after, so the engine needs both seams. */
  eventBus: EventBus;
  llm: LlmClient;
  logger: Logger;
  /** DM-able characters (the fixture roster in V1). */
  profiles: readonly CharacterProfile[];
  /**
   * The idle horizon, injected (Guide A16: the engine never reads the
   * clock): returns the ISO instant `now − idle timeout` — a conversation
   * whose last activity is OLDER than it is idle and closes. Timestamps are
   * the event log's own Zulu ISO strings, so plain string comparison is
   * exact. Owner default: 30 min via WELTARI_CHAT_IDLE_MINUTES.
   */
  idleCutoffIso: () => string;
  /** Drain the ledger now — an enqueued reflect_chat starts on the spot. */
  kickRunner?: () => void;
}

export interface SendMessageResult {
  conversationId: string;
  messageId: string;
  replying: boolean;
  presence: 'available' | 'in_scene';
  /** Resolves when the detached reply commits or gives up (tests await it). */
  completion: Promise<void>;
}

export interface ChatEngine {
  sendMessage(command: SendChatMessageCommand): Result<SendMessageResult>;
  exitChat(
    command: ExitChatCommand,
  ): Result<{ conversationId: string; ended: boolean; jobKey?: string }>;
  /** End every conversation idle past the timeout (reason `idle`) — called
   * on a timer from main; tests call it directly with a fake clock. */
  sweepIdle(): number;
}

export function createChatEngine(options: ChatEngineOptions): ChatEngine {
  const { storage, sink, eventBus, llm, logger, profiles } = options;

  /** Reply generations in flight, per conversation — an idle sweep must not
   * close a conversation the character is still typing into, and a second
   * user message queues ONE follow-up instead of racing a parallel reply. */
  const inFlight = new Set<string>();
  const nudged = new Set<string>();

  function profileFor(characterId: string): CharacterProfile | undefined {
    return profiles.find((p) => p.character_id === characterId);
  }

  /** chat.ended + its ONE reflect_chat job, atomically (Brief §2.4). */
  function endRange(
    worldId: string,
    actorId: string,
    conversationId: string,
    characterId: string,
    reason: 'exit' | 'idle' | 'startscene',
    rangeEndId: number,
  ): { jobKey: string } {
    const jobKey = `reflect_chat:${conversationId}:${String(rangeEndId)}`;
    let ended: WeltariEvent | undefined;
    storage.transact(() => {
      ended = storage.eventLog.append({
        world_id: worldId,
        actor_id: actorId,
        type: 'chat.ended',
        payload: {
          conversation_id: conversationId,
          character_id: characterId,
          reason,
          range_end_id: rangeEndId,
        },
      });
      storage.ledger.enqueue({
        idempotency_key: jobKey,
        world_id: worldId,
        type: 'reflect_chat',
        payload: {
          conversation_id: conversationId,
          character_id: characterId,
          range_end_id: rangeEndId,
        },
      });
    });
    if (ended !== undefined) eventBus.publish(ended);
    options.kickRunner?.();
    return { jobKey };
  }

  /** The detached reply generation — one LLM call with chat-shaped context,
   * then ONE transaction committing the reply + its CACHE line (B6: streamed
   * text is never durable; a failure here loses only the reply). */
  async function generateReply(
    command: SendChatMessageCommand,
    conversationId: string,
    profile: CharacterProfile,
  ): Promise<void> {
    inFlight.add(conversationId);
    try {
      do {
        nudged.delete(conversationId);
        const state = conversationState(storage, conversationId);
        const transcript: TurnLine[] = state.allMessages
          .slice(-CHAT_TRANSCRIPT_LINES)
          .flatMap((event) =>
            event.type === 'chat.message_committed'
              ? [
                  {
                    speaker:
                      event.payload.sender === 'user' ? 'User' : profile.name,
                    text: event.payload.text,
                  },
                ]
              : [],
          );
        // The catch-up recap is re-read FRESH for every reply (owner
        // decision 2026-07-09): latest scene line + latest chat line.
        const recap = cacheRecapText(
          latestPerOrigin(storage, profile.character_id),
        );
        const context = assembleContext(profile, {
          scene_id: conversationId,
          heading: 'Conversation',
          world_clock_text: 'You are outside any scene, texting on your phone.',
          latest_turns: transcript,
          wiki: [],
          ...(recap === '' ? {} : { cache_recap: recap }),
        });
        const result = await llm.streamCall({
          kind: 'chat',
          characterId: profile.character_id,
          system: context.stablePrefix,
          prompt: `${context.dynamicTail}\n\n## Instruction\nReply as ${profile.name} to the last User message: a short, in-character text message (1-3 sentences, first person, no narration). This is a private chat outside any scene — you cannot change the world from here; if the User wants to DO something together, suggest meeting somewhere. After writing your reply, call the cache tool with a private 1-2 line recap of this exchange.`,
          onTextDelta: (): void => undefined, // chat replies do not stream (V1)
          toolset: 'chat',
        });
        if (!result.ok) {
          logger.error(
            { conversation_id: conversationId, code: result.error.code },
            'chat reply failed — nothing durable, the user can resend',
          );
          return;
        }
        const text = result.value.text.trim();
        if (text === '') {
          logger.warn(
            { conversation_id: conversationId },
            'chat reply came back empty — skipped',
          );
          return;
        }
        // Gate 1 over the chat tool calls; the character's CACHE line rides
        // the reply's transaction (mandatory per trigger, Rev 4 §11).
        let cacheLine: string | undefined;
        for (const raw of result.value.toolCalls) {
          const parsed = parseChatToolCall(raw, logger);
          if (!parsed.ok) {
            logger.warn(
              { conversation_id: conversationId, tool: raw.tool },
              'chat tool call rejected at gate 1',
            );
            continue;
          }
          cacheLine = capCacheLine(parsed.value.input.line);
        }
        if (cacheLine === undefined) {
          logger.warn(
            { conversation_id: conversationId },
            'chat reply carried no cache line (mandatory per Rev 4 §11) — reply committed without one',
          );
        }
        sink.appendMany([
          {
            world_id: command.world_id,
            actor_id: profile.character_id,
            type: 'chat.message_committed',
            payload: {
              conversation_id: conversationId,
              character_id: profile.character_id,
              sender: 'character',
              text,
              message_id: randomUUID(),
            },
          },
          ...(cacheLine === undefined
            ? []
            : [
                {
                  world_id: command.world_id,
                  actor_id: profile.character_id,
                  type: 'cache.appended' as const,
                  payload: {
                    character_id: profile.character_id,
                    origin: 'chat' as const,
                    context_id: conversationId,
                    line: cacheLine,
                  },
                },
              ]),
        ]);
      } while (nudged.has(conversationId));
    } finally {
      inFlight.delete(conversationId);
      nudged.delete(conversationId);
    }
  }

  return {
    sendMessage(command: SendChatMessageCommand): Result<SendMessageResult> {
      const profile = profileFor(command.character_id);
      if (profile === undefined) {
        return err(
          new OperationalError(
            'unknown_character',
            `no character ${command.character_id} in this world`,
          ),
        );
      }
      const conversationId = conversationIdFor(
        command.actor_id,
        command.character_id,
      );
      const presence = presenceOf(storage, command.character_id);

      // Idempotent per request_id: a duplicate send is a silent 202 no-op.
      const state = conversationState(storage, conversationId);
      const duplicate = state.allMessages.some(
        (m) =>
          m.type === 'chat.message_committed' &&
          m.payload.message_id === command.request_id,
      );
      if (duplicate) {
        return ok({
          conversationId,
          messageId: command.request_id,
          replying: false,
          presence: presence.state,
          completion: Promise.resolve(),
        });
      }

      sink.append({
        world_id: command.world_id,
        actor_id: command.actor_id,
        type: 'chat.message_committed',
        payload: {
          conversation_id: conversationId,
          character_id: command.character_id,
          sender: 'user',
          text: command.text,
          message_id: command.request_id,
        },
      });

      // The presence rule (Rev 4 §8): a character in a scene shows offline —
      // the message is stored, NO reply generates until the scene ends.
      if (presence.state === 'in_scene') {
        return ok({
          conversationId,
          messageId: command.request_id,
          replying: false,
          presence: presence.state,
          completion: Promise.resolve(),
        });
      }

      // A reply already generating covers this message via the nudge loop —
      // one follow-up regeneration with the fresh transcript, never a race.
      if (inFlight.has(conversationId)) {
        nudged.add(conversationId);
        return ok({
          conversationId,
          messageId: command.request_id,
          replying: true,
          presence: presence.state,
          completion: Promise.resolve(),
        });
      }

      const completion = generateReply(command, conversationId, profile);
      return ok({
        conversationId,
        messageId: command.request_id,
        replying: true,
        presence: presence.state,
        completion,
      });
    },

    exitChat(
      command: ExitChatCommand,
    ): Result<{ conversationId: string; ended: boolean; jobKey?: string }> {
      const profile = profileFor(command.character_id);
      if (profile === undefined) {
        return err(
          new OperationalError(
            'unknown_character',
            `no character ${command.character_id} in this world`,
          ),
        );
      }
      const conversationId = conversationIdFor(
        command.actor_id,
        command.character_id,
      );
      const state = conversationState(storage, conversationId);
      if (state.openMessages.length === 0) {
        // Nothing unreflected — a silent no-op (there is nothing to close).
        return ok({ conversationId, ended: false });
      }
      const { jobKey } = endRange(
        command.world_id,
        command.actor_id,
        conversationId,
        command.character_id,
        'exit',
        state.lastMessageId,
      );
      return ok({ conversationId, ended: true, jobKey });
    },

    sweepIdle(): number {
      // Discover conversations from the log (a projection like everything
      // else), then close the ones idle past the timeout.
      const conversations = new Map<
        string,
        { worldId: string; characterId: string }
      >();
      for (const event of storage.eventLog.readSince(0, 100000)) {
        if (event.type === 'chat.message_committed') {
          conversations.set(event.payload.conversation_id, {
            worldId: event.world_id,
            characterId: event.payload.character_id,
          });
        }
      }
      const cutoff = options.idleCutoffIso();
      let ended = 0;
      for (const [conversationId, info] of conversations) {
        if (inFlight.has(conversationId)) continue; // still typing
        const state = conversationState(storage, conversationId);
        if (state.openMessages.length === 0) continue;
        // Zulu ISO strings compare lexicographically — activity at or after
        // the cutoff keeps the conversation open.
        if (state.lastActivityTs >= cutoff) continue;
        endRange(
          info.worldId,
          'system:chat',
          conversationId,
          info.characterId,
          'idle',
          state.lastMessageId,
        );
        ended += 1;
        logger.info(
          {
            conversation_id: conversationId,
            last_activity: state.lastActivityTs,
          },
          'chat conversation idle-closed — reflect_chat enqueued',
        );
      }
      return ended;
    },
  };
}
