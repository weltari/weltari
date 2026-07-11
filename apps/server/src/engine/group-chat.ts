// Group chats (M6 part 4, Rev 4 §8): user-started ONLY — characters cannot
// fire group chats and CRON never posts into them. The Group-chat Narrator
// is a router: per user turn it decides who speaks next (or ends the round)
// and NEVER narrates — any text it produces is dropped un-surfaced; router
// decisions are dev-trail frames, not transcript. The ENGINE enforces the
// turn budget (owner ruling 2026-07-11: default 3, user-tunable): the
// router cannot ping-pong characters past it no matter what it returns.
// A range close (ENDSUBSESSION / user exit) appends chat.group_ended + ONE
// reflect_chat job per member in one transaction. Groups never change the
// world (the cardinal rule holds — members write only their own CACHE).
import { randomUUID } from 'node:crypto';
import type {
  ExitGroupChatCommand,
  SendGroupMessageCommand,
  StartGroupChatCommand,
  WeltariEvent,
} from '@weltari/protocol';
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { DevBus, EventBus } from '../http/bus.js';
import { parseChatToolCall, parseGroupRouterCall } from '../llm/tools.js';
import type { LlmClient } from '../llm/types.js';
import type { Logger } from '../observability/logger.js';
import type { Storage } from '../storage/db.js';
import { cacheRecapText, capCacheLine, latestPerOrigin } from './cache.js';
import { CHAT_CONDUCT_SKILL, presenceOf } from './chat.js';
import {
  assembleContext,
  type CharacterProfile,
  type TurnLine,
} from './context-assembler.js';
import type { EventSink } from './event-sink.js';
import { liveProfile } from './memory.js';

/** How many recent group lines a router/character call sees. */
const GROUP_TRANSCRIPT_LINES = 32;

/** Malformed router replies get this many shape-retries, then the round
 * yields to the user (routing is never critical — nothing rolls back). */
const ROUTER_SHAPE_RETRIES = 3;

export interface GroupChatEngineOptions {
  storage: Storage;
  sink: EventSink;
  eventBus: EventBus;
  llm: LlmClient;
  logger: Logger;
  profiles: readonly CharacterProfile[];
  /** Max character turns per user turn — engine-enforced (Rev 4 §8). */
  turnBudget: number;
  kickRunner?: () => void;
  devBus?: DevBus;
}

interface GroupState {
  exists: boolean;
  title: string;
  memberIds: string[];
  /** All group lines ever, oldest first. */
  messages: WeltariEvent[];
  /** Event id of the last message after the last group_ended (0 = none). */
  openTailId: number;
  lastMessageId: number;
}

function groupState(storage: Storage, conversationId: string): GroupState {
  let exists = false;
  let title = '';
  let memberIds: string[] = [];
  const messages: WeltariEvent[] = [];
  let lastEndedAt = 0;
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (
      event.type === 'chat.group_started' &&
      event.payload.conversation_id === conversationId
    ) {
      exists = true;
      title = event.payload.title;
      memberIds = [...event.payload.member_ids];
    } else if (
      event.type === 'chat.group_message_committed' &&
      event.payload.conversation_id === conversationId
    ) {
      messages.push(event);
    } else if (
      event.type === 'chat.group_ended' &&
      event.payload.conversation_id === conversationId
    ) {
      lastEndedAt = event.id;
    }
  }
  const open = messages.filter((m) => m.id > lastEndedAt);
  return {
    exists,
    title,
    memberIds,
    messages,
    openTailId: open.at(-1)?.id ?? 0,
    lastMessageId: messages.at(-1)?.id ?? 0,
  };
}

export interface GroupChatEngine {
  startGroup(
    command: StartGroupChatCommand,
  ): Result<{ conversationId: string }>;
  sendMessage(command: SendGroupMessageCommand): Result<{
    conversationId: string;
    messageId: string;
    routing: boolean;
    /** Resolves when the router round finishes (tests await it). */
    completion: Promise<void>;
  }>;
  exitGroup(
    command: ExitGroupChatCommand,
  ): Result<{ conversationId: string; ended: boolean; jobsEnqueued: number }>;
}

export function createGroupChatEngine(
  options: GroupChatEngineOptions,
): GroupChatEngine {
  const { storage, sink, eventBus, llm, logger, profiles, turnBudget } =
    options;

  /** Router rounds in flight, per conversation — a second user line during a
   * round just commits (the round reads the transcript fresh per step). */
  const inFlight = new Set<string>();

  function profileFor(characterId: string): CharacterProfile | undefined {
    return profiles.find((p) => p.character_id === characterId);
  }

  /** Deterministic member resolution (the name→id resolver pattern): real
   * routers reliably return "mara" for `char:mara` (week-12 real-backend
   * finding). Exact id wins; else the `char:` prefix; else a UNIQUE
   * case-insensitive match on id tail or profile name — ambiguity resolves
   * to nothing and the round yields (never a guess). */
  function resolveMember(
    routed: string,
    memberIds: readonly string[],
  ): string | undefined {
    if (memberIds.includes(routed)) return routed;
    const lower = routed.toLowerCase();
    const prefixed = `char:${lower}`;
    if (memberIds.includes(prefixed)) return prefixed;
    const matches = memberIds.filter((id) => {
      const name = profileFor(id)?.name.toLowerCase() ?? '';
      return id.toLowerCase().endsWith(`:${lower}`) || name.includes(lower);
    });
    return matches.length === 1 ? matches[0] : undefined;
  }

  function transcript(conversationId: string): TurnLine[] {
    const state = groupState(storage, conversationId);
    return state.messages.slice(-GROUP_TRANSCRIPT_LINES).flatMap((event) =>
      event.type === 'chat.group_message_committed'
        ? [
            {
              speaker:
                event.payload.sender === 'user'
                  ? 'User'
                  : (profileFor(event.payload.character_id ?? '')?.name ??
                    'Someone'),
              text: event.payload.text,
            },
          ]
        : [],
    );
  }

  /** chat.group_ended + ONE reflect_chat job per member, atomically. */
  function endRange(
    worldId: string,
    actorId: string,
    conversationId: string,
    reason: 'exit' | 'endsubsession',
  ): { ended: boolean; jobsEnqueued: number } {
    const state = groupState(storage, conversationId);
    if (!state.exists || state.openTailId === 0) {
      return { ended: false, jobsEnqueued: 0 };
    }
    let jobsEnqueued = 0;
    let persisted: WeltariEvent | undefined;
    storage.transact(() => {
      persisted = storage.eventLog.append({
        world_id: worldId,
        actor_id: actorId,
        type: 'chat.group_ended',
        payload: {
          conversation_id: conversationId,
          reason,
          range_end_id: state.openTailId,
          member_ids: state.memberIds,
        },
      });
      for (const memberId of state.memberIds) {
        const job = storage.ledger.enqueue({
          idempotency_key: `reflect_chat:${conversationId}:${memberId}:${String(state.openTailId)}`,
          world_id: worldId,
          type: 'reflect_chat',
          payload: {
            conversation_id: conversationId,
            character_id: memberId,
            range_end_id: state.openTailId,
          },
        });
        if (job !== null) jobsEnqueued += 1;
      }
    });
    if (persisted !== undefined) eventBus.publish(persisted);
    options.kickRunner?.();
    return { ended: true, jobsEnqueued };
  }

  /** One Group-chat Narrator decision: who speaks next, or end, or yield. */
  async function routeNext(
    conversationId: string,
    memberIds: string[],
    availability: string,
    turnsUsed: number,
  ): Promise<
    { kind: 'end' } | { kind: 'yield' } | { kind: 'member'; id: string }
  > {
    const lines = transcript(conversationId)
      .map((l) => `${l.speaker}: ${l.text}`)
      .join('\n');
    for (let attempt = 1; attempt <= ROUTER_SHAPE_RETRIES; attempt++) {
      const result = await llm.streamCall({
        kind: 'group_route',
        characterId: 'group_router',
        system:
          'You are the router of a group chat. You route turns and NOTHING else: you never write dialogue, never narrate, never speak. Decide who would naturally speak next, or end the round. Reply ONLY with a tool call.',
        prompt: `Members: ${memberIds.join(', ')} (use these EXACT ids in route calls)\nAvailability: ${availability}\nCharacter turns already routed this round: ${String(turnsUsed)}\n\n## Transcript\n${lines}\n\n## Instruction\nEither call route with the member who would naturally speak next (next_character_id = one of the exact ids above), or call endsubsession if the conversation reached a resting point.`,
        onTextDelta: (): void => undefined, // router text is DROPPED (no narration)
        toolset: 'group_router',
      });
      if (!result.ok) {
        logger.warn(
          { conversation_id: conversationId, code: result.error.code },
          'group router call failed — the round yields to the user',
        );
        return { kind: 'yield' };
      }
      for (const raw of result.value.toolCalls) {
        const parsed = parseGroupRouterCall(raw, logger);
        if (!parsed.ok) continue;
        options.devBus?.publish({
          type: 'dev.tool_call',
          turn_id: conversationId,
          tool: parsed.value.tool,
          input_json: JSON.stringify(
            parsed.value.tool === 'route' ? parsed.value.input : {},
          ),
        });
        if (parsed.value.tool === 'endsubsession') return { kind: 'end' };
        // Engine-state gate happens at the caller: the routed member must
        // exist in this group and be available.
        return { kind: 'member', id: parsed.value.input.next_character_id };
      }
      logger.warn(
        { conversation_id: conversationId, attempt },
        'group router returned no valid tool call — retrying the decision',
      );
    }
    return { kind: 'yield' };
  }

  /** One routed member reply: commits the group line + its CACHE entry. */
  async function generateMemberReply(
    worldId: string,
    conversationId: string,
    profile: CharacterProfile,
    memberNames: string,
  ): Promise<void> {
    const recap = cacheRecapText(
      latestPerOrigin(storage, profile.character_id),
    );
    const context = assembleContext(
      {
        ...liveProfile(storage, profile),
        skills: [...profile.skills, CHAT_CONDUCT_SKILL],
      },
      {
        scene_id: conversationId,
        heading: 'Group chat',
        world_clock_text:
          'You are outside any scene, texting in a group chat on your phone.',
        latest_turns: transcript(conversationId),
        wiki: [],
        ...(recap === '' ? {} : { cache_recap: recap }),
      },
    );
    const result = await llm.streamCall({
      kind: 'chat',
      characterId: profile.character_id,
      system: context.stablePrefix,
      prompt: `${context.dynamicTail}\n\n## Instruction\nReply as ${profile.name} in this GROUP chat with the User and ${memberNames}: a short, in-character text message (1-3 sentences, first person, no narration). React to whoever spoke last — the User or another member. This is a private group chat outside any scene; you cannot change the world from here, and meetings are arranged in your own direct chat with the User, never here. After writing your reply, call the cache tool with a private 1-2 line recap.`,
      onTextDelta: (): void => undefined, // group replies do not stream (V1)
      toolset: 'chat',
    });
    if (!result.ok) {
      logger.warn(
        { conversation_id: conversationId, code: result.error.code },
        'group member reply failed — the routed turn stays empty',
      );
      return;
    }
    const text = result.value.text.trim();
    let cacheLine: string | undefined;
    let declined = false;
    for (const raw of result.value.toolCalls) {
      const parsed = parseChatToolCall(raw, logger);
      if (!parsed.ok) continue;
      if (parsed.value.tool === 'cache') {
        cacheLine = capCacheLine(parsed.value.input.line);
      } else if (parsed.value.tool === 'stay_silent') {
        declined = true;
      } else {
        // startscene never fires from a group (Rev 4 §8: the bridge is a DM
        // surface; group scenes are V2). Nothing durable happens (B6).
        logger.warn(
          { conversation_id: conversationId },
          'group member tried startscene — ignored (V1: groups never open scenes)',
        );
      }
    }
    if (declined || text === '') return; // a routed member may stay silent
    sink.appendMany([
      {
        world_id: worldId,
        actor_id: profile.character_id,
        type: 'chat.group_message_committed',
        payload: {
          conversation_id: conversationId,
          sender: 'character',
          character_id: profile.character_id,
          text,
          message_id: randomUUID(),
        },
      },
      ...(cacheLine === undefined
        ? []
        : [
            {
              world_id: worldId,
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
  }

  /** The router round: up to `turnBudget` member turns, then yield — the
   * ENGINE cut, regardless of what the router wants (Rev 4 §8). */
  async function runRouterRound(
    command: SendGroupMessageCommand,
  ): Promise<void> {
    const conversationId = command.conversation_id;
    inFlight.add(conversationId);
    try {
      const state = groupState(storage, conversationId);
      for (let turn = 0; turn < turnBudget; turn++) {
        const availability = state.memberIds
          .map((id) => {
            const presence = presenceOf(storage, command.world_id, id);
            return `${id}: ${presence.state === 'available' ? 'available' : 'busy (in a scene)'}`;
          })
          .join('; ');
        const decision = await routeNext(
          conversationId,
          state.memberIds,
          availability,
          turn,
        );
        if (decision.kind === 'yield') return;
        if (decision.kind === 'end') {
          endRange(
            command.world_id,
            command.actor_id,
            conversationId,
            'endsubsession',
          );
          return;
        }
        const routedId =
          resolveMember(decision.id, state.memberIds) ?? decision.id;
        const profile = profileFor(routedId);
        if (
          profile === undefined ||
          !state.memberIds.includes(routedId) ||
          presenceOf(storage, command.world_id, routedId).state !== 'available'
        ) {
          logger.warn(
            { conversation_id: conversationId, routed: routedId },
            'group router routed an unknown/absent/busy member — the round yields',
          );
          return;
        }
        const memberNames = state.memberIds
          .filter((id) => id !== routedId)
          .map((id) => profileFor(id)?.name ?? id)
          .join(', ');
        await generateMemberReply(
          command.world_id,
          conversationId,
          profile,
          memberNames,
        );
      }
      logger.info(
        { conversation_id: conversationId, budget: turnBudget },
        'group turn budget reached — the engine yields to the user',
      );
    } finally {
      inFlight.delete(conversationId);
    }
  }

  return {
    startGroup(command: StartGroupChatCommand): Result<{
      conversationId: string;
    }> {
      const unique = new Set(command.member_ids);
      if (unique.size !== command.member_ids.length) {
        return err(
          new OperationalError(
            'duplicate_members',
            'member ids must be unique',
          ),
        );
      }
      const unknown = command.member_ids.filter(
        (id) => profileFor(id) === undefined,
      );
      if (unknown.length > 0) {
        return err(
          new OperationalError(
            'unknown_character',
            `no such character(s): ${unknown.join(', ')}`,
          ),
        );
      }
      const conversationId = `group:${command.actor_id}:${command.request_id}`;
      if (groupState(storage, conversationId).exists) {
        return ok({ conversationId }); // idempotent per request_id
      }
      sink.append({
        world_id: command.world_id,
        actor_id: command.actor_id,
        type: 'chat.group_started',
        payload: {
          conversation_id: conversationId,
          title: command.title,
          member_ids: command.member_ids,
        },
      });
      return ok({ conversationId });
    },

    sendMessage(command: SendGroupMessageCommand): Result<{
      conversationId: string;
      messageId: string;
      routing: boolean;
      completion: Promise<void>;
    }> {
      const state = groupState(storage, command.conversation_id);
      if (!state.exists) {
        return err(
          new OperationalError('unknown_group', 'no such group conversation'),
        );
      }
      const duplicate = state.messages.some(
        (m) =>
          m.type === 'chat.group_message_committed' &&
          m.payload.message_id === command.request_id,
      );
      if (duplicate) {
        return ok({
          conversationId: command.conversation_id,
          messageId: command.request_id,
          routing: false,
          completion: Promise.resolve(),
        });
      }
      sink.append({
        world_id: command.world_id,
        actor_id: command.actor_id,
        type: 'chat.group_message_committed',
        payload: {
          conversation_id: command.conversation_id,
          sender: 'user',
          text: command.text,
          message_id: command.request_id,
        },
      });
      if (inFlight.has(command.conversation_id)) {
        // A round is already routing — it reads the transcript fresh per
        // step, so this line is naturally visible to the next member.
        return ok({
          conversationId: command.conversation_id,
          messageId: command.request_id,
          routing: false,
          completion: Promise.resolve(),
        });
      }
      const completion = runRouterRound(command).catch((error: unknown) => {
        // CATCH-OK (C6): a failed round loses replies, never the user line.
        logger.error(
          { conversation_id: command.conversation_id, error },
          'group router round failed',
        );
      });
      return ok({
        conversationId: command.conversation_id,
        messageId: command.request_id,
        routing: true,
        completion,
      });
    },

    exitGroup(command: ExitGroupChatCommand): Result<{
      conversationId: string;
      ended: boolean;
      jobsEnqueued: number;
    }> {
      const state = groupState(storage, command.conversation_id);
      if (!state.exists) {
        return err(
          new OperationalError('unknown_group', 'no such group conversation'),
        );
      }
      const { ended, jobsEnqueued } = endRange(
        command.world_id,
        command.actor_id,
        command.conversation_id,
        'exit',
      );
      return ok({
        conversationId: command.conversation_id,
        ended,
        jobsEnqueued,
      });
    },
  };
}
