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
  EndSceneCommand,
  ExitChatCommand,
  SendChatMessageCommand,
  StartSceneFromChatCommand,
  WeltariEvent,
} from '@weltari/protocol';
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { Logger } from '../observability/logger.js';
import type { DevBus, EventBus } from '../http/bus.js';
import { parseChatToolCall, type StartSceneToolInput } from '../llm/tools.js';
import type { LlmClient } from '../llm/types.js';
import type { Storage } from '../storage/db.js';
import { cacheRecapText, capCacheLine, latestPerOrigin } from './cache.js';
import {
  runMemoryquery,
  runSessionquery,
  runWikiquery,
} from './chat-queries.js';
import { flagOf } from './config-flags.js';
import { GM_CHARACTER_ID } from './gm.js';
import { archiveRecapText, liveProfile } from './memory.js';
import {
  assembleContext,
  type CharacterProfile,
  type TurnLine,
} from './context-assembler.js';
import type { EventSink } from './event-sink.js';
import type { OpenSceneRequest } from './scene-lifecycle.js';
import { slugifyName } from './scene-tools.js';
import { knownSublocations } from './sublocations.js';

/** How many recent transcript lines a chat reply sees (short context — chat
 * turns are the cheapest call class; deep recall arrives with the query
 * tools in part 3). Exported (M7 part 2): the GM conversation reads the
 * same window. */
export const CHAT_TRANSCRIPT_LINES = 24;

/**
 * The texting conduct skill (M6 part 3, owner ruling 2026-07-09: startscene
 * is conversational and character-led, never a button). Appended to every
 * character's skills for CHAT calls only — a stable constant, so the chat
 * stable prefix stays byte-identical across calls (I5). It teaches the
 * negotiation (gather the place before firing), the firing rule (the
 * character calls startscene ITSELF), and the V1 product limits the
 * character must decline in-character (Rev 4 §7 skills carry product
 * self-knowledge; §8 no inter-agent comms in V1).
 */
export const CHAT_CONDUCT_SKILL =
  'Texting: you are texting the User from inside your own life. You cannot change the world from chat — when the User wants to DO something together, or you want to show or give them something, propose meeting in person. Before proposing, make sure a PLACE is agreed: a place you know, or a short description the User gives (like "the park"). If the place or purpose is missing, ask for what is missing naturally, one question at a time; if the User already said it, do not re-ask. Once you both agree on where to meet, call the startscene tool yourself in that same reply — the User has no way to open the meeting; only you do. Include wait_hours: how many in-world hours you would realistically wait at the place before giving up — your own choice, fitting your character and the plan. You cannot text or meet other characters without the User present, cannot message anyone on the User’s behalf, and cannot leave this chat yourself — decline such requests in character, with a plausible reason.';

export type Presence =
  { state: 'available' } | { state: 'in_scene'; scene_id: string };

/**
 * The presence projection (Rev 4 §4: presence is engine-owned, structured
 * state for code): a character is `in_scene` while a scene it joined is
 * still open. No table — derived from character.joined / scene.ended events.
 * WORLD-SCOPED (M6 part 3 fix): the same character id in another world is
 * that world's character — a scene left open elsewhere (the harness's
 * cross-world probe was the reproducer) must never freeze this world's DMs.
 */
export function presenceOf(
  storage: Storage,
  worldId: string,
  characterId: string,
): Presence {
  const openScenes = new Set<string>();
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.world_id !== worldId) continue;
    if (
      event.type === 'character.joined' &&
      event.payload.character_id === characterId
    ) {
      openScenes.add(event.payload.scene_id);
    } else if (
      // The agentic scene (0.21.0, Rev 4 §6): character_leave releases THIS
      // character's reservation while the scene stays open for everyone else.
      event.type === 'character.left' &&
      event.payload.character_id === characterId
    ) {
      openScenes.delete(event.payload.scene_id);
    } else if (event.type === 'scene.ended' || event.type === 'scene.expired') {
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

export interface ConversationState {
  /** Messages of the OPEN range (after the last chat.ended), oldest first. */
  openMessages: WeltariEvent[];
  /** All messages ever (the prompt transcript source), oldest first. */
  allMessages: WeltariEvent[];
  /** Event id of the last message overall (0 = none). */
  lastMessageId: number;
  /** Envelope ts of the last message in the open range ('' = none). */
  lastActivityTs: string;
}

/** Exported (M7 part 2) — the GM conversation engine reads the same fold. */
export function conversationState(
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
  /** The scene-lifecycle seam the startscene() bridge opens through (Rev 4
   * §8: THE way back into scenes) — 409s (blocked_on_pending_jobs) surface
   * to the caller; a character's proposal logs and the chat continues. */
  openScene: (request: OpenSceneRequest) => Result<{ opened: true }>;
  /** The one-active-scene transition seam (same rule the web's map jumps
   * follow): a scene still open when the bridge fires is ENDED first —
   * abandoning it open would hold its characters `in_scene` forever and the
   * presence rule would silence their DMs for good. */
  endScene: (command: EndSceneCommand) => Result<{ jobsEnqueued: number }>;
  /** Pacing for the bridge's bounded wait while the ended scene's
   * reflection/World-Agent fan-out blocks the open (test seam; default 500). */
  bridgeRetryDelayMs?: number;
  /** Drain the ledger now — an enqueued reflect_chat starts on the spot. */
  kickRunner?: () => void;
  /** The dev-mode trail (C11): mid-call queries leave dev.tool_call frames
   * exactly like the narrator's query_sublocations does. */
  devBus?: DevBus;
}

/** How long the bridge may wait out the scene-end fan-out — attempts × delay
 * mirrors the web funnel's bound (commands.ts OPEN_RETRY_ATTEMPTS). */
const BRIDGE_RETRY_ATTEMPTS = 20;

/** The critical-tool retry ceiling (owner ruling 2026-07-11): a malformed
 * startscene call gets a hardcoded correction and the reply regenerates —
 * up to this many total attempts, then the whole tool fire rolls back (the
 * chat continues as if it never happened) and a chat.notice red line tells
 * the user why. */
const STARTSCENE_RETRY_ATTEMPTS = 10;

/** Scenes started and never ended in this world — the bridge's transition
 * targets. A pure fold like every other projection here. */
function openSceneIds(storage: Storage, worldId: string): string[] {
  const open = new Set<string>();
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.world_id !== worldId) continue;
    if (event.type === 'scene.started') open.add(event.payload.scene_id);
    else if (event.type === 'scene.ended' || event.type === 'scene.expired')
      open.delete(event.payload.scene_id);
  }
  return [...open];
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
  /** The command side of the startscene() bridge (Rev 4 §8) — the dev-mode
   * testing shortcut since M6 part 3 (the character-led path is the feature,
   * owner ruling 2026-07-09). Async: the bridge may wait out the previous
   * scene's end fan-out. */
  startSceneFromChat(
    command: StartSceneFromChatCommand,
  ): Promise<Result<{ sceneId: string; sublocationId?: string }>>;
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
        // The character's memory mailbox (M7 part 1, Rev 4 §11).
        serial_group: `memory:${worldId}:${characterId}`,
      });
      // GM Job 2 (M7 part 2, Rev 4 §9): the profile-analysis pass over the
      // closed range — consent-gated here AND re-checked in the handler. The
      // profile subject is the conversation's OWNER (from the stable id
      // shape `chat:<actor>:<character>`), never the closer: an idle sweep
      // runs as system:chat but the range is still the user's.
      const subject = conversationId.slice(
        'chat:'.length,
        conversationId.length - (characterId.length + 1),
      );
      if (
        subject.startsWith('user:') &&
        flagOf(storage, worldId, 'profiling_enabled')
      ) {
        storage.ledger.enqueue({
          idempotency_key: `profile_analysis:${subject}:${conversationId}:${String(rangeEndId)}`,
          world_id: worldId,
          type: 'profile_analysis',
          payload: {
            user_actor_id: subject,
            origin: 'chat',
            context_id: `${conversationId}:${String(rangeEndId)}`,
          },
          serial_group: `profile:${worldId}`,
        });
      }
    });
    if (ended !== undefined) eventBus.publish(ended);
    options.kickRunner?.();
    return { jobKey };
  }

  /**
   * The startscene() bridge core (Rev 4 §8): resolve the place against the
   * known-sublocations registry (id or name match → open AT it; no match →
   * the free text rides scene.started as place_request for the Narrator's
   * standard create workflow), open the scene WITH the character (presence
   * flips to in_scene via character.joined — the reservation), then close
   * the chat range (reason startscene). Scene open and chat close are two
   * transactions ON PURPOSE: a kill between them leaves the conversation
   * open and the idle sweep heals it — never a closed chat with no scene.
   *
   * One active scene (M6 part 3, the debug-session carry-over): a scene
   * still open when the bridge fires is ended FIRST — full fan-out — then
   * the open retries (bounded) while that fan-out blocks it. Both bridge
   * callers (the dev-mode button command and the character's own startscene
   * tool) get the transition from this one site.
   */
  async function runStartSceneBridge(
    worldId: string,
    actorId: string,
    profile: CharacterProfile,
    sceneId: string,
    title: string,
    place: string,
    premise: string | undefined,
    /** Present only on the CHARACTER-fired path (0.13.0, Rev 4 §7): the
     * character's own game-time window. The dev-mode button never sets it —
     * a user firing the scene IS showing up, so nothing can expire. */
    waitHours?: number,
  ): Promise<Result<{ sceneId: string; sublocationId?: string }>> {
    const slug = slugifyName(place);
    const match = knownSublocations(storage, worldId).find(
      (s) => s.sublocation_id === place || slugifyName(s.name) === slug,
    );
    for (const stillOpen of openSceneIds(storage, worldId)) {
      // A refused end (already ended by a racing caller) changes nothing:
      // the open below is the gate; the log is truth either way.
      const endedScene = options.endScene({
        world_id: worldId,
        actor_id: actorId,
        scene_id: stillOpen,
      });
      if (endedScene.ok) options.kickRunner?.();
    }
    const request: OpenSceneRequest = {
      world_id: worldId,
      actor_id: actorId,
      scene_id: sceneId,
      title,
      participants: [profile.character_id],
      ...(match === undefined
        ? { place_request: place }
        : { sublocation_id: match.sublocation_id }),
      ...(premise === undefined ? {} : { premise }),
      ...(waitHours === undefined
        ? {}
        : {
            invitation: {
              character_id: profile.character_id,
              place,
              wait_hours: waitHours,
            },
          }),
    };
    const delayMs = options.bridgeRetryDelayMs ?? 500;
    let opened = options.openScene(request);
    for (
      let attempt = 1;
      !opened.ok &&
      opened.error.code === 'blocked_on_pending_jobs' &&
      attempt < BRIDGE_RETRY_ATTEMPTS;
      attempt++
    ) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
      opened = options.openScene(request);
    }
    if (!opened.ok) return opened;
    const conversationId = conversationIdFor(actorId, profile.character_id);
    const state = conversationState(storage, conversationId);
    if (state.openMessages.length > 0) {
      endRange(
        worldId,
        actorId,
        conversationId,
        profile.character_id,
        'startscene',
        state.lastMessageId,
      );
    }
    return ok({
      sceneId,
      ...(match === undefined ? {} : { sublocationId: match.sublocation_id }),
    });
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
        // The archive pointer (owner ruling 2026-07-11): the condensed
        // summary of older memories + what stands behind it, so the model
        // can judge whether a memoryquery deep dive is worthwhile.
        const archiveRecap = archiveRecapText(storage, profile.character_id);
        // The conduct skill rides the STABLE prefix (a constant appended to
        // constant profile skills — byte-identical across calls, I5). The
        // profile is the LIVE fold (M7 part 1): seed + latest durable core,
        // evolved personality/goals — it changes only when a reflection-class
        // job commits a memory event, never within a call.
        const context = assembleContext(
          {
            ...liveProfile(storage, profile),
            skills: [...profile.skills, CHAT_CONDUCT_SKILL],
          },
          {
            scene_id: conversationId,
            heading: 'Conversation',
            world_clock_text:
              'You are outside any scene, texting on your phone.',
            latest_turns: transcript,
            wiki: [],
            ...(recap === '' ? {} : { cache_recap: recap }),
            ...(archiveRecap === '' ? {} : { archive_recap: archiveRecap }),
          },
        );
        // The query escalation (M6 part 3, Rev 4 §11): wikiquery +
        // sessionquery run mid-call through the proven queries seam — the
        // instant recap stays the hot path; specifics escalate on demand.
        // Each execution leaves a dev.tool_call frame (C11).
        const queryOf = (
          tool: 'wikiquery' | 'sessionquery' | 'memoryquery',
          run: (input: unknown) => string,
        ): ((input: unknown) => string) => {
          return (input: unknown): string => {
            options.devBus?.publish({
              type: 'dev.tool_call',
              turn_id: conversationId,
              tool,
              input_json: JSON.stringify(input),
            });
            return run(input);
          };
        };
        const basePrompt = `${context.dynamicTail}\n\n## Instruction\nReply as ${profile.name} to the last User message: a short, in-character text message (1-3 sentences, first person, no narration). This is a private chat outside any scene — you cannot change the world from here. Follow your Texting skill: if meeting in person is on the table, gather what is missing (the place above all), and once the place is agreed call the startscene tool yourself in this reply. When the User asks about a place or something specific that happened, use wikiquery/sessionquery to check before answering; when they touch something from your own past that your core memory does not hold, search your long-term memories with memoryquery first. After writing your reply, call the cache tool with a private 1-2 line recap of this exchange.`;
        // The critical-tool correction loop (owner ruling 2026-07-11): a
        // malformed startscene gets a hardcoded correction appended and the
        // WHOLE reply regenerates — nothing was committed yet, so a retry
        // replaces, never duplicates. After the ceiling the fire rolls back:
        // the last reply commits WITHOUT the tool + a chat.notice red line.
        let text = '';
        let cacheLine: string | undefined;
        let startScene: StartSceneToolInput | undefined;
        let startSceneRejected = false;
        let correction = '';
        for (let attempt = 1; attempt <= STARTSCENE_RETRY_ATTEMPTS; attempt++) {
          const result = await llm.streamCall({
            kind: 'chat',
            characterId: profile.character_id,
            system: context.stablePrefix,
            prompt: `${basePrompt}${correction}`,
            onTextDelta: (): void => undefined, // chat replies do not stream (V1)
            toolset: 'chat',
            queries: {
              wikiquery: queryOf('wikiquery', (input) =>
                runWikiquery(storage, command.world_id, logger, input),
              ),
              sessionquery: queryOf('sessionquery', (input) =>
                runSessionquery(
                  storage,
                  command.world_id,
                  profile.character_id,
                  logger,
                  input,
                ),
              ),
              // The memory deep dive (M7 part 1, Rev 4 §11): bound to THIS
              // character — participation-gated by construction.
              memoryquery: queryOf('memoryquery', (input) =>
                runMemoryquery(storage, profile.character_id, logger, input),
              ),
            },
          });
          if (!result.ok) {
            logger.error(
              { conversation_id: conversationId, code: result.error.code },
              'chat reply failed — nothing durable, the user can resend',
            );
            return;
          }
          text = result.value.text.trim();
          if (text === '') {
            logger.warn(
              { conversation_id: conversationId },
              'chat reply came back empty — skipped',
            );
            return;
          }
          // Gate 1 over the chat tool calls; the character's CACHE line
          // rides the reply's transaction (mandatory per trigger, Rev 4 §11).
          cacheLine = undefined;
          startScene = undefined;
          startSceneRejected = false;
          for (const raw of result.value.toolCalls) {
            const parsed = parseChatToolCall(raw, logger);
            if (!parsed.ok) {
              if (raw.tool === 'startscene') startSceneRejected = true;
              logger.warn(
                {
                  conversation_id: conversationId,
                  tool: raw.tool,
                  attempt,
                },
                'chat tool call rejected at gate 1',
              );
              continue;
            }
            if (parsed.value.tool === 'cache') {
              cacheLine = capCacheLine(parsed.value.input.line);
            } else if (parsed.value.tool === 'startscene') {
              startScene = parsed.value.input;
            }
            // stay_silent in a REPLY is a no-op: the user just texted — the
            // decline tool belongs to proactive fires (owner ruling
            // 2026-07-11); an empty reply already skips commit.
          }
          if (!startSceneRejected) break;
          correction = `\n\n## Correction\nYour startscene call was rejected: every field must match the tool schema, and wait_hours is REQUIRED — how many in-world hours you will wait at the place before giving up (a plain number, e.g. 6; your own choice). Rewrite your reply with a corrected startscene call, or reply without one if you no longer want to open the meeting.`;
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
          // The rollback red line (owner ruling 2026-07-11): the ceiling is
          // exhausted, the tool fire never happened — hardcoded text, durable
          // like any transcript line, rendered red by the client.
          ...(startSceneRejected
            ? [
                {
                  world_id: command.world_id,
                  actor_id: profile.character_id,
                  type: 'chat.notice' as const,
                  payload: {
                    conversation_id: conversationId,
                    character_id: profile.character_id,
                    code: 'startscene_rejected',
                    text: `${profile.name} tried to open the meeting, but the invitation was rejected ${String(STARTSCENE_RETRY_ATTEMPTS)} times (missing or invalid meeting details) — no scene was opened. The chat continues.`,
                  },
                },
              ]
            : []),
        ]);
        // The character proposed meeting in person (Rev 4 §8): run the
        // bridge AFTER the reply committed — the proposal line is durable
        // either way. A blocked scene open logs and the chat continues (the
        // user can retry via the button); on success the conversation ended,
        // so the nudge loop stops here.
        if (startScene !== undefined) {
          const bridged = await runStartSceneBridge(
            command.world_id,
            command.actor_id,
            profile,
            `s-chat-${randomUUID().slice(0, 8)}`,
            `Meeting: ${startScene.place}`.slice(0, 200),
            startScene.place,
            startScene.premise,
            startScene.wait_hours,
          );
          if (bridged.ok) return;
          logger.warn(
            { conversation_id: conversationId, code: bridged.error.code },
            'character startscene() could not open a scene — chat continues',
          );
        }
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
      const presence = presenceOf(
        storage,
        command.world_id,
        command.character_id,
      );

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

    async startSceneFromChat(
      command: StartSceneFromChatCommand,
    ): Promise<Result<{ sceneId: string; sublocationId?: string }>> {
      const profile = profileFor(command.character_id);
      if (profile === undefined) {
        return err(
          new OperationalError(
            'unknown_character',
            `no character ${command.character_id} in this world`,
          ),
        );
      }
      return runStartSceneBridge(
        command.world_id,
        command.actor_id,
        profile,
        command.scene_id,
        command.title,
        command.place,
        command.premise,
      );
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
        // The GM conversation never idles closed (M7 part 2, Rev 4 §9): the
        // GM is not a character — no reflection exists for it, and its
        // thread is the standing settings/authoring channel.
        if (info.characterId === GM_CHARACTER_ID) continue;
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
