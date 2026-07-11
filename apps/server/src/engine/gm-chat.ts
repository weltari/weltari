// The GM conversation engine (M7 part 2, Rev 4 §9): the GM rides Weltari
// Chat — its lines are ordinary chat.message_committed events on the ONE
// stream, so the transcript is a projection and the web thread renders like
// any DM — but the GM is NOT a character: no CACHE, no reflection, no
// presence (always available), and its tools are all PROPOSALS. A GM reply
// and the proposals it fired commit in ONE transaction: the card can never
// exist without the line that offered it, or the reverse.
//
// Job 0 (cold boot) is a MODE of this same conversation, not a machine: a
// world with no world.seeded event puts the GM in interview mode (the
// dynamic tail says so, and propose_world_seed is the form it fills); the
// approval that applies the seed flips the fold, and the next reply is in
// authoring mode. Durable interview state IS the conversation transcript.
import { randomUUID } from 'node:crypto';
import type { SendChatMessageCommand } from '@weltari/protocol';
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { Logger } from '../observability/logger.js';
import type { DevBus } from '../http/bus.js';
import { parseGmToolCall, type ValidatedGmToolCall } from '../llm/tools.js';
import type { LlmClient } from '../llm/types.js';
import type { NewEvent } from '../storage/repositories/event-log.js';
import type { Storage } from '../storage/db.js';
import {
  CHAT_TRANSCRIPT_LINES,
  conversationIdFor,
  conversationState,
} from './chat.js';
import { runWikiquery } from './chat-queries.js';
import { assembleContext, type TurnLine } from './context-assembler.js';
import type { EventSink } from './event-sink.js';
import { buildGmProfile, GM_CHARACTER_ID } from './gm.js';
import {
  worldSeeded,
  type ProposalEngine,
  type SubmitProposalRequest,
} from './proposals.js';

/** Gate-2 correction ceiling: a refused proposal (name collision, unknown
 * target) gets a hardcoded correction and the WHOLE reply regenerates —
 * far smaller than the critical-chain ceiling because nothing here is
 * story-critical; after it, the reply commits without the failed card. */
const PROPOSAL_RETRY_ATTEMPTS = 3;

export interface GmChatEngineOptions {
  storage: Storage;
  sink: EventSink;
  llm: LlmClient;
  logger: Logger;
  proposals: ProposalEngine;
  /** Whether a real model is configured (key present or fake selected) —
   * the interview's "keys" step is a status line, never stored state
   * (secrets live only in env, Guide rule 5). */
  modelConfigured: boolean;
  devBus?: DevBus;
}

export interface GmSendResult {
  conversationId: string;
  messageId: string;
  replying: boolean;
  /** The GM is always available (not a character — no presence). */
  presence: 'available';
  /** Resolves when the detached reply commits or gives up (tests await it). */
  completion: Promise<void>;
}

export interface GmChatEngine {
  sendMessage(command: SendChatMessageCommand): Result<GmSendResult>;
}

/** The proposal a gate-1-validated GM tool call asks for. */
function requestOf(
  call: ValidatedGmToolCall,
  worldId: string,
  approver: string,
): SubmitProposalRequest {
  const base = {
    world_id: worldId,
    proposer: GM_CHARACTER_ID,
    approvers: [approver],
    rationale: call.input.rationale,
  };
  switch (call.tool) {
    case 'propose_place':
      return {
        ...base,
        action: 'create_place',
        diff: {
          name: call.input.name,
          description: call.input.description,
          space: call.input.space,
          ...(call.input.wiki_entry === undefined
            ? {}
            : { wiki_entry: call.input.wiki_entry }),
        },
      };
    case 'propose_character':
      return {
        ...base,
        action: 'create_character',
        diff: {
          name: call.input.name,
          personality: call.input.personality,
          goals: call.input.goals,
          core: call.input.core ?? [],
          skills: call.input.skills ?? [],
        },
      };
    case 'propose_wiki_edit':
      return {
        ...base,
        action: 'edit_wiki',
        diff: {
          sublocation_id: call.input.sublocation_id,
          entry: call.input.entry,
        },
      };
    case 'propose_world_seed':
      return {
        ...base,
        action: 'seed_world',
        diff: {
          world_name: call.input.world_name,
          language: call.input.language,
          ...(call.input.chapter_seed === undefined
            ? {}
            : { chapter_seed: call.input.chapter_seed }),
          places: call.input.places,
          characters: call.input.characters.map((c) => ({
            name: c.name,
            personality: c.personality,
            goals: c.goals,
            core: c.core ?? [],
            skills: c.skills ?? [],
          })),
        },
      };
  }
}

export function createGmChatEngine(options: GmChatEngineOptions): GmChatEngine {
  const { storage, sink, llm, logger, proposals } = options;
  const inFlight = new Set<string>();
  const nudged = new Set<string>();

  /** The mode block of the dynamic tail — pure fold, re-read every reply. */
  function modeText(worldId: string): string {
    const model = options.modelConfigured
      ? 'A language model is configured — you are fully alive.'
      : 'NO language model is configured yet: tell the user to set OPENROUTER_API_KEY in the .env file and restart before world creation can produce good results (you are currently running on a scripted stand-in).';
    if (worldSeeded(storage, worldId)) {
      return `You are in AUTHORING mode: this world is seeded and live. ${model} Help the user grow it: places via propose_place, people via propose_character, record corrections via propose_wiki_edit (wikiquery first). Every change needs their approval card.`;
    }
    return `You are in COLD-BOOT INTERVIEW mode (this world is NOT seeded yet — nothing exists). ${model} Run the guided interview in this order, one thing at a time: (1) ask which language the user wants to play in, and speak it from then on; (2) confirm the model status above in one short sentence; (3) interview them about the world — its name, mood, the opening situation, the places that matter (a good start: 3-6 places, at least one public and one private), and 2-3 characters; (4) when — and only when — all of that is gathered, call propose_world_seed ONCE with the completed form. The user approves the whole world as one card.`;
  }

  async function generateReply(
    command: SendChatMessageCommand,
    conversationId: string,
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
                    speaker: event.payload.sender === 'user' ? 'User' : 'GM',
                    text: event.payload.text,
                  },
                ]
              : [],
          );
        const context = assembleContext(buildGmProfile(), {
          scene_id: conversationId,
          heading: 'Conversation',
          world_clock_text:
            'You are the GM of this Weltari world, talking with its owner.',
          latest_turns: transcript,
          wiki: [],
        });
        const basePrompt = `${context.dynamicTail}\n\n## Mode\n${modeText(command.world_id)}\n\n## Instruction\nReply as the GM to the last User message: plain, warm, one step at a time (2-5 sentences). Use your proposal tools for anything that should exist in the world — never claim a change happened without an approved card. Use wikiquery before proposing a wiki edit.`;
        let text = '';
        let submitted = 0;
        let correction = '';
        for (let attempt = 1; attempt <= PROPOSAL_RETRY_ATTEMPTS; attempt++) {
          const result = await llm.streamCall({
            kind: 'gm',
            characterId: GM_CHARACTER_ID,
            system: context.stablePrefix,
            prompt: `${basePrompt}${correction}`,
            onTextDelta: (): void => undefined, // GM replies do not stream (V1)
            toolset: 'gm',
            queries: {
              wikiquery: (input: unknown): string => {
                options.devBus?.publish({
                  type: 'dev.tool_call',
                  turn_id: conversationId,
                  tool: 'wikiquery',
                  input_json: JSON.stringify(input),
                });
                return runWikiquery(storage, command.world_id, logger, input);
              },
            },
          });
          if (!result.ok) {
            logger.error(
              { conversation_id: conversationId, code: result.error.code },
              'GM reply failed — nothing durable, the user can resend',
            );
            return;
          }
          text = result.value.text.trim();
          if (text === '') {
            logger.warn(
              { conversation_id: conversationId },
              'GM reply came back empty — skipped',
            );
            return;
          }
          // Gate 1 (shape) per call, then a DRY-RUN of gate 2 via the
          // proposal engine's prepare: the reply and its cards commit in one
          // transaction only when every card passes; a refusal regenerates
          // the whole reply with the reason (the correction loop).
          const events: NewEvent[] = [
            {
              world_id: command.world_id,
              actor_id: GM_CHARACTER_ID,
              type: 'chat.message_committed',
              payload: {
                conversation_id: conversationId,
                character_id: GM_CHARACTER_ID,
                sender: 'character',
                text,
                message_id: randomUUID(),
              },
            },
          ];
          let refusal: string | undefined;
          for (const raw of result.value.toolCalls) {
            const parsed = parseGmToolCall(raw, logger);
            if (!parsed.ok) {
              options.devBus?.publish({
                type: 'dev.tool_rejected',
                turn_id: conversationId,
                tool: raw.tool,
                gate: 'schema',
                reason: parsed.error.code,
              });
              logger.warn(
                { conversation_id: conversationId, tool: raw.tool, attempt },
                'GM tool call rejected at gate 1',
              );
              refusal = `Your ${raw.tool} call did not match the tool schema — every field must match exactly.`;
              continue;
            }
            const prepared = proposals.prepare(
              requestOf(parsed.value, command.world_id, command.actor_id),
            );
            if (!prepared.ok) {
              options.devBus?.publish({
                type: 'dev.tool_rejected',
                turn_id: conversationId,
                tool: raw.tool,
                gate: 'state',
                reason: prepared.error.code,
              });
              refusal = `Your ${parsed.value.tool} proposal was refused: ${prepared.error.message}.`;
              continue;
            }
            events.push({
              world_id: command.world_id,
              actor_id: GM_CHARACTER_ID,
              type: 'proposal.submitted',
              payload: prepared.value.payload,
            });
          }
          if (refusal === undefined) {
            sink.appendMany(events);
            submitted = events.length - 1;
            break;
          }
          if (attempt === PROPOSAL_RETRY_ATTEMPTS) {
            // Ceiling reached: the reply commits WITHOUT the failed cards —
            // nothing durable happened for them (I8); the GM stays honest
            // because its skills forbid claiming unapproved changes.
            sink.appendMany(events);
            submitted = events.length - 1;
            logger.warn(
              { conversation_id: conversationId },
              'GM proposal refused at the correction ceiling — reply committed without it',
            );
            break;
          }
          correction = `\n\n## Correction\n${refusal} Rewrite your reply; correct the proposal or leave it out.`;
        }
        logger.info(
          { conversation_id: conversationId, proposals: submitted },
          'GM reply committed',
        );
      } while (nudged.has(conversationId));
    } finally {
      inFlight.delete(conversationId);
      nudged.delete(conversationId);
    }
  }

  return {
    sendMessage(command: SendChatMessageCommand): Result<GmSendResult> {
      if (command.character_id !== GM_CHARACTER_ID) {
        return err(new OperationalError('unknown_character', 'not the GM'));
      }
      const conversationId = conversationIdFor(
        command.actor_id,
        GM_CHARACTER_ID,
      );
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
          presence: 'available',
          completion: Promise.resolve(),
        });
      }
      sink.append({
        world_id: command.world_id,
        actor_id: command.actor_id,
        type: 'chat.message_committed',
        payload: {
          conversation_id: conversationId,
          character_id: GM_CHARACTER_ID,
          sender: 'user',
          text: command.text,
          message_id: command.request_id,
        },
      });
      if (inFlight.has(conversationId)) {
        nudged.add(conversationId);
        return ok({
          conversationId,
          messageId: command.request_id,
          replying: true,
          presence: 'available',
          completion: Promise.resolve(),
        });
      }
      const completion = generateReply(command, conversationId);
      return ok({
        conversationId,
        messageId: command.request_id,
        replying: true,
        presence: 'available',
        completion,
      });
    },
  };
}

/** The fresh-world GM greeting (M7 part 2, Rev 4 §9): a hardcoded, durable
 * unread message — the onboarding entry point the splash links to. Appended
 * once by main.ts when a world boots empty without the fixture seed. */
export function gmGreetingEvent(worldId: string): NewEvent {
  return {
    world_id: worldId,
    actor_id: GM_CHARACTER_ID,
    type: 'chat.message_committed',
    payload: {
      conversation_id: conversationIdFor('user:owner', GM_CHARACTER_ID),
      character_id: GM_CHARACTER_ID,
      sender: 'character',
      text: 'Welcome to Weltari — I am your GM. This world is a blank page: when you are ready, tell me what language you want to play in, and we will dream the rest up together.',
      message_id: 'gm-greeting',
    },
  };
}
