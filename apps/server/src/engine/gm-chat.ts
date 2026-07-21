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
//
// The UX contract (0.20.0, owner ruling 2026-07-11): the GM works like a
// coding agent's tool loop. Its transcript fold interleaves chat lines with
// its proposal TOOL CALLS and their RESULTS (submitted → pending; resolved →
// approved/rejected; discussed → talk it over) in event-log order, and a
// resolution triggers ONE durable follow-up turn — a consent card can sit
// for hours, so the tool result is never delivered by holding the LLM call
// open: proposal.resolved/discussed enqueues a follow-up generation whose
// context carries the outcome, committed under the deterministic message id
// gm-followup-/gm-discuss-<proposal_id> (the natural key — an eager trigger
// plus the boot sweep converge to exactly one, the invitation pattern).
import { randomUUID } from 'node:crypto';
import type {
  DiscussProposalCommand,
  SendChatMessageCommand,
} from '@weltari/protocol';
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { Logger } from '../observability/logger.js';
import type { DevBus, StreamBus } from '../http/bus.js';
import {
  GM_TOOL_SCHEMA_HINTS,
  parseGmToolCall,
  type ValidatedGmToolCall,
} from '../llm/tools.js';
import type { LlmClient } from '../llm/types.js';
import type { NewEvent } from '../storage/repositories/event-log.js';
import type { Storage } from '../storage/db.js';
import {
  CHAT_TRANSCRIPT_LINES,
  conversationIdFor,
  conversationState,
} from './chat.js';
import { createSentenceSplitter } from './sentences.js';
import { runWikiquery } from './chat-queries.js';
import { assembleContext, type TurnLine } from './context-assembler.js';
import type { EventSink } from './event-sink.js';
import type { FaultPointHook } from './fault-points.js';
import { buildGmProfile, GM_CHARACTER_ID } from './gm.js';
import {
  worldSeeded,
  type ProposalEngine,
  type ProposalPayload,
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
  /** GM prose streams display-only into the GM thread (0.20.0, the UX
   * contract): `call: 'gm'` frames with turn_id = conversation id — never
   * durable, the committed message is the transcript (B6). */
  streamBus: StreamBus;
  /** Whether a real model is configured (key present or fake selected) —
   * the interview's "keys" step is a status line, never stored state
   * (secrets live only in env, Guide rule 5). */
  modelConfigured: boolean;
  faultPoint?: FaultPointHook;
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

/** One tool-loop outcome to feed back to the GM (the durable tool-result
 * turn): the approver's verdict, or the chat-about-this signal. */
export interface ProposalOutcomeNote {
  world_id: string;
  /** The approver — their GM conversation carries the follow-up turn. */
  actor_id: string;
  proposal_id: string;
  outcome: 'approved' | 'rejected' | 'discuss';
}

export interface GmChatEngine {
  sendMessage(command: SendChatMessageCommand): Result<GmSendResult>;
  /**
   * The chat-about-this signal (0.20.0): appends proposal.discussed — a
   * DURABLE signal, not an input prefill — and enqueues the GM's
   * acknowledgement turn. NOT a resolution: the card stays pending and
   * resolvable later. Refused for unknown/resolved/already-discussed
   * proposals and non-approvers (zero rows on refusal, I8).
   */
  discussProposal(
    command: DiscussProposalCommand,
  ): Result<{ proposalId: string; completion: Promise<void> }>;
  /**
   * The durable tool-result turn: enqueue exactly ONE GM follow-up
   * generation for a proposal outcome. Natural key = the deterministic
   * message id, so a duplicate note (retry, eager + sweep overlap)
   * converges to one committed follow-up.
   */
  noteProposalOutcome(note: ProposalOutcomeNote): { completion: Promise<void> };
  /**
   * The boot sweep (invitation pattern): every resolution/discuss signal in
   * the log that still lacks its follow-up message gets one — the eager
   * trigger dies with the process; the sweep is why a kill inside the
   * commit window converges.
   */
  sweepFollowups(worldId: string): Promise<void>;
}

/** The deterministic follow-up message id — the natural key that makes the
 * durable tool-result turn single per resolution (and per discuss). */
export function followupMessageIdFor(
  proposalId: string,
  outcome: ProposalOutcomeNote['outcome'],
): string {
  return outcome === 'discuss'
    ? `gm-discuss-${proposalId}`
    : `gm-followup-${proposalId}`;
}

/** One-line tool-call rendering of a proposal payload for the GM transcript
 * fold — what the GM "sees" it asked for. */
function proposalLineOf(payload: ProposalPayload): string {
  const subject = ((): string => {
    switch (payload.action) {
      case 'create_place':
      case 'create_character':
      case 'create_object':
        return `"${payload.diff.name}"`;
      case 'edit_wiki':
        return payload.diff.sublocation_id;
      case 'seed_world':
        return `"${payload.diff.world_name}"`;
    }
  })();
  return `[tool call ${payload.proposal_id}] ${payload.action} ${subject} — the consent card is on the user's screen, awaiting their decision.`;
}

/**
 * The GM transcript fold (the UX contract): chat lines AND the proposal
 * tool calls with their results, interleaved in event-log order — the GM
 * reads its own tool loop the way a coding agent does. Everything here is
 * dynamic-tail material only (I5: the stable prefix never changes).
 */
export function gmTranscriptOf(
  storage: Storage,
  worldId: string,
  conversationId: string,
): TurnLine[] {
  const lines: TurnLine[] = [];
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (
      event.type === 'chat.message_committed' &&
      event.payload.conversation_id === conversationId
    ) {
      lines.push({
        speaker: event.payload.sender === 'user' ? 'User' : 'GM',
        text: event.payload.text,
      });
    } else if (event.world_id !== worldId) {
      continue;
    } else if (event.type === 'proposal.submitted') {
      lines.push({ speaker: 'Tool', text: proposalLineOf(event.payload) });
    } else if (event.type === 'proposal.resolved') {
      lines.push({
        speaker: 'Tool',
        text:
          event.payload.resolution === 'approved'
            ? `[tool result ${event.payload.proposal_id}] approved — the user consented; the change is applied and durable.`
            : `[tool result ${event.payload.proposal_id}] rejected — the user declined; nothing was changed.`,
      });
    } else if (event.type === 'proposal.discussed') {
      lines.push({
        speaker: 'Tool',
        text: `[tool result ${event.payload.proposal_id}] the user wants to talk this over before deciding — the card stays pending.`,
      });
    }
  }
  return lines.slice(-CHAT_TRANSCRIPT_LINES);
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
    case 'propose_object':
      return {
        ...base,
        action: 'create_object',
        diff: {
          name: call.input.name,
          holder_sublocation_id: call.input.holder_sublocation_id,
          ...(call.input.object_payload === undefined
            ? {}
            : { object_payload: call.input.object_payload }),
        },
      };
  }
}

/** What one loop pass needs to know — world + approver (V1: the owner). */
interface GmTurnContext {
  world_id: string;
  actor_id: string;
}

export function createGmChatEngine(options: GmChatEngineOptions): GmChatEngine {
  const { storage, sink, llm, logger, proposals } = options;
  const nudged = new Set<string>();
  /** Follow-up jobs waiting for the conversation's serialized loop. */
  const followupQueue = new Map<string, ProposalOutcomeNote[]>();
  /** The one running loop per conversation — its promise covers every job
   * it drains before exiting (replies and follow-ups never overlap). */
  const running = new Map<string, Promise<void>>();

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

  /** The follow-up turn's instruction — the outcome as the tool call's
   * result, told to the GM the way a coding agent reads a tool answer. */
  function followupInstruction(note: ProposalOutcomeNote): string {
    switch (note.outcome) {
      case 'approved':
        return `The user just CONSENTED to your proposal ${note.proposal_id} (see the tool result in the transcript) — the change is applied and durable. React briefly (1-3 sentences): acknowledge what now exists and offer the natural next step. Do not re-propose it.`;
      case 'rejected':
        return `The user REJECTED your proposal ${note.proposal_id} (see the tool result in the transcript) — nothing was changed. React briefly (1-3 sentences): accept the refusal gracefully and ask what they would prefer instead. Do not immediately re-propose the same thing.`;
      case 'discuss':
        return `The user clicked "Chat about this" on your proposal ${note.proposal_id} (see the tool result in the transcript) — they want to talk before deciding. STOP proposing: acknowledge in one or two sentences and invite their thoughts. The card stays pending; do not re-propose anything now.`;
    }
  }

  /** The hardcoded fallback when a follow-up generation comes back empty —
   * the natural key must settle either way, or the sweep would retry the
   * same empty call forever. Engine text, not model output (B6-safe). */
  function followupFallback(note: ProposalOutcomeNote): string {
    switch (note.outcome) {
      case 'approved':
        return 'Done — it is part of the world now. Where shall we take it next?';
      case 'rejected':
        return 'Understood — I have set that aside. Tell me what you would prefer.';
      case 'discuss':
        return 'Of course — the card can wait. Tell me what is on your mind.';
    }
  }

  /**
   * ONE generation pass — a reply to the user (note undefined) or the
   * durable tool-result follow-up (note set: deterministic message id,
   * fault window + fused re-check before the commit).
   */
  async function generateOnce(
    ctx: GmTurnContext,
    conversationId: string,
    note: ProposalOutcomeNote | undefined,
  ): Promise<void> {
    const messageId =
      note === undefined
        ? randomUUID()
        : followupMessageIdFor(note.proposal_id, note.outcome);
    if (note !== undefined) {
      // The natural key, checked eagerly: a retried note (eager trigger +
      // boot sweep overlap, a nudged loop already drained it) is a no-op.
      const already = conversationState(
        storage,
        conversationId,
      ).allMessages.some(
        (m) =>
          m.type === 'chat.message_committed' &&
          m.payload.message_id === messageId,
      );
      if (already) return;
    }
    const transcript: TurnLine[] = gmTranscriptOf(
      storage,
      ctx.world_id,
      conversationId,
    );
    const context = assembleContext(buildGmProfile(), {
      scene_id: conversationId,
      heading: 'Conversation',
      world_clock_text:
        'You are the GM of this Weltari world, talking with its owner.',
      latest_turns: transcript,
      wiki: [],
    });
    const instruction =
      note === undefined
        ? 'Reply as the GM to the last User message: plain, warm, one step at a time (2-5 sentences). Use your proposal tools for anything that should exist in the world — never claim a change happened without an approved card. Use wikiquery before proposing a wiki edit.'
        : followupInstruction(note);
    const basePrompt = `${context.dynamicTail}\n\n## Mode\n${modeText(ctx.world_id)}\n\n## Instruction\n${instruction}`;
    let submitted = 0;
    let correction = '';
    for (let attempt = 1; attempt <= PROPOSAL_RETRY_ATTEMPTS; attempt++) {
      // The GM streams its prose (0.20.0): sentence frames on the
      // display-only bus, index restarting at 0 per attempt — a
      // correction-loop retry restarts the stream and the client
      // replaces its buffer on index 0 (the durable message still
      // commits whole, B6).
      let sentenceIndex = 0;
      const splitter = createSentenceSplitter((sentence) => {
        options.streamBus.publish({
          turn_id: conversationId,
          call: 'gm',
          speaker: 'GM',
          text: sentence,
          index: sentenceIndex,
        });
        sentenceIndex += 1;
      });
      const result = await llm.streamCall({
        kind: 'gm',
        characterId: GM_CHARACTER_ID,
        system: context.stablePrefix,
        prompt: `${basePrompt}${correction}`,
        onTextDelta: (delta): void => {
          splitter.push(delta);
        },
        toolset: 'gm',
        queries: {
          wikiquery: (input: unknown): string => {
            options.devBus?.publish({
              type: 'dev.tool_call',
              turn_id: conversationId,
              tool: 'wikiquery',
              input_json: JSON.stringify(input),
            });
            return runWikiquery(storage, ctx.world_id, logger, input);
          },
        },
      });
      splitter.flush();
      if (!result.ok) {
        logger.error(
          { conversation_id: conversationId, code: result.error.code },
          'GM reply failed — nothing durable, the user can resend',
        );
        return;
      }
      let text = result.value.text.trim();
      if (text === '' && result.value.toolCalls.length === 0) {
        if (note === undefined) {
          logger.warn(
            { conversation_id: conversationId },
            'GM reply came back empty — skipped',
          );
          return;
        }
        // A follow-up must settle its natural key even on an empty
        // generation — the hardcoded ack carries the outcome.
        text = followupFallback(note);
      }
      if (text === '') {
        // A tool-call-only reply (DeepSeek does this, week-15 real run):
        // the card IS the message — a hardcoded line carries it.
        text = 'Here is my proposal — look it over; your call.';
      }
      // Gate 1 (shape) per call, then a DRY-RUN of gate 2 via the
      // proposal engine's prepare: the reply and its cards commit in one
      // transaction only when every card passes; a refusal regenerates
      // the whole reply with the reason (the correction loop).
      const events: NewEvent[] = [
        {
          world_id: ctx.world_id,
          actor_id: GM_CHARACTER_ID,
          type: 'chat.message_committed',
          payload: {
            conversation_id: conversationId,
            character_id: GM_CHARACTER_ID,
            sender: 'character',
            text,
            message_id: messageId,
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
          const hints: Record<string, string | undefined> =
            GM_TOOL_SCHEMA_HINTS;
          const hint = hints[raw.tool];
          refusal = `Your ${raw.tool} call did not match the tool schema.${hint === undefined ? '' : ` ${hint}`} Make ONE corrected call with every required field.`;
          continue;
        }
        const prepared = proposals.prepare(
          requestOf(parsed.value, ctx.world_id, ctx.actor_id),
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
          world_id: ctx.world_id,
          actor_id: GM_CHARACTER_ID,
          type: 'proposal.submitted',
          payload: prepared.value.payload,
        });
      }
      if (refusal === undefined) {
        if (!(await commitTurn(conversationId, note, messageId, events))) {
          return;
        }
        submitted = events.length - 1;
        break;
      }
      if (attempt === PROPOSAL_RETRY_ATTEMPTS) {
        // Ceiling reached: the reply commits WITHOUT the failed cards —
        // nothing durable happened for them (I8); the GM stays honest
        // because its skills forbid claiming unapproved changes.
        if (!(await commitTurn(conversationId, note, messageId, events))) {
          return;
        }
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
      {
        conversation_id: conversationId,
        proposals: submitted,
        followup: note?.proposal_id,
      },
      note === undefined ? 'GM reply committed' : 'GM follow-up committed',
    );
  }

  /**
   * The one commit seam for both turn kinds. A follow-up turn passes its
   * kill window (I4) right before the append, then the fused re-check —
   * NO awaits from the re-read to the append: an overlapped duplicate
   * (eager trigger racing the boot sweep) loses cleanly on the natural key.
   * Returns false when the re-check refused (nothing was written).
   */
  async function commitTurn(
    conversationId: string,
    note: ProposalOutcomeNote | undefined,
    messageId: string,
    events: NewEvent[],
  ): Promise<boolean> {
    if (note !== undefined) {
      await options.faultPoint?.('mid_gm_followup');
      const already = conversationState(
        storage,
        conversationId,
      ).allMessages.some(
        (m) =>
          m.type === 'chat.message_committed' &&
          m.payload.message_id === messageId,
      );
      if (already) {
        logger.info(
          { conversation_id: conversationId, message_id: messageId },
          'GM follow-up already committed — converged on the natural key',
        );
        return false;
      }
    }
    sink.appendMany(events);
    return true;
  }

  /** The serialized per-conversation loop: drains follow-up jobs first,
   * then a nudged reply — one generation at a time, ever. */
  async function runLoop(
    ctx: GmTurnContext,
    conversationId: string,
  ): Promise<void> {
    for (;;) {
      const note = followupQueue.get(conversationId)?.shift();
      if (note !== undefined) {
        await generateOnce(ctx, conversationId, note);
        continue;
      }
      if (nudged.has(conversationId)) {
        nudged.delete(conversationId);
        await generateOnce(ctx, conversationId, undefined);
        continue;
      }
      return;
    }
  }

  /** Start the loop if idle; either way the returned promise resolves only
   * after every currently queued job has drained. */
  async function kick(
    ctx: GmTurnContext,
    conversationId: string,
  ): Promise<void> {
    const current = running.get(conversationId);
    if (current !== undefined) return current;
    const loop = (async (): Promise<void> => {
      // Yield once so the `running` registration below lands before the
      // loop can exit — a synchronously-empty run must still clean up the
      // registration it is about to get.
      await Promise.resolve();
      try {
        await runLoop(ctx, conversationId);
      } catch (thrown) {
        // CATCH-OK: a loop crash must not orphan the conversation — the
        // boot sweep re-derives any missing follow-up from the log.
        logger.error({ err: thrown }, 'GM loop crashed');
      } finally {
        running.delete(conversationId);
        nudged.delete(conversationId);
        followupQueue.delete(conversationId);
      }
    })();
    running.set(conversationId, loop);
    return loop;
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
      nudged.add(conversationId);
      const completion = kick(
        { world_id: command.world_id, actor_id: command.actor_id },
        conversationId,
      );
      return ok({
        conversationId,
        messageId: command.request_id,
        replying: true,
        presence: 'available',
        completion,
      });
    },

    discussProposal(
      command: DiscussProposalCommand,
    ): Result<{ proposalId: string; completion: Promise<void> }> {
      // The §16 pipeline stays untouched — this seam only reads its events:
      // the same fold shape as resolve's gates, plus the discussed latch.
      let approvers: readonly string[] | undefined;
      let resolved = false;
      let discussed = false;
      for (const event of storage.eventLog.readSince(0, 100000)) {
        if (event.world_id !== command.world_id) continue;
        if (
          event.type === 'proposal.submitted' &&
          event.payload.proposal_id === command.proposal_id
        ) {
          approvers = event.payload.approvers;
        } else if (
          event.type === 'proposal.resolved' &&
          event.payload.proposal_id === command.proposal_id
        ) {
          resolved = true;
        } else if (
          event.type === 'proposal.discussed' &&
          event.payload.proposal_id === command.proposal_id
        ) {
          discussed = true;
        }
      }
      if (approvers === undefined) {
        return err(
          new OperationalError('unknown_proposal', 'no such proposal'),
        );
      }
      if (resolved) {
        return err(
          new OperationalError(
            'already_resolved',
            'this proposal is already settled — nothing to discuss',
          ),
        );
      }
      if (!approvers.includes(command.actor_id)) {
        return err(
          new OperationalError(
            'not_an_approver',
            'only a listed approver may discuss this proposal',
          ),
        );
      }
      if (discussed) {
        return err(
          new OperationalError(
            'already_discussed',
            'the talk is already on — the GM knows',
          ),
        );
      }
      sink.append({
        world_id: command.world_id,
        actor_id: command.actor_id,
        type: 'proposal.discussed',
        payload: { proposal_id: command.proposal_id },
      });
      const { completion } = this.noteProposalOutcome({
        world_id: command.world_id,
        actor_id: command.actor_id,
        proposal_id: command.proposal_id,
        outcome: 'discuss',
      });
      return ok({ proposalId: command.proposal_id, completion });
    },

    noteProposalOutcome(note: ProposalOutcomeNote): {
      completion: Promise<void>;
    } {
      const conversationId = conversationIdFor(note.actor_id, GM_CHARACTER_ID);
      const queue = followupQueue.get(conversationId) ?? [];
      queue.push(note);
      followupQueue.set(conversationId, queue);
      return {
        completion: kick(
          { world_id: note.world_id, actor_id: note.actor_id },
          conversationId,
        ),
      };
    },

    async sweepFollowups(worldId: string): Promise<void> {
      // The invitation pattern: fold the log for every outcome signal that
      // still lacks its follow-up message (natural key = message id), in
      // log order, and enqueue each — the loop serializes the generations.
      const messageIds = new Set<string>();
      const missing: ProposalOutcomeNote[] = [];
      for (const event of storage.eventLog.readSince(0, 100000)) {
        if (event.world_id !== worldId) continue;
        if (event.type === 'chat.message_committed') {
          messageIds.add(event.payload.message_id);
        } else if (event.type === 'proposal.resolved') {
          missing.push({
            world_id: worldId,
            actor_id: event.actor_id,
            proposal_id: event.payload.proposal_id,
            outcome: event.payload.resolution,
          });
        } else if (event.type === 'proposal.discussed') {
          missing.push({
            world_id: worldId,
            actor_id: event.actor_id,
            proposal_id: event.payload.proposal_id,
            outcome: 'discuss',
          });
        }
      }
      const due = missing.filter(
        (note) =>
          !messageIds.has(followupMessageIdFor(note.proposal_id, note.outcome)),
      );
      if (due.length > 0) {
        logger.info(
          { world_id: worldId, due: due.length },
          'GM follow-up sweep found unanswered outcomes',
        );
      }
      await Promise.all(
        due.map(async (note) => this.noteProposalOutcome(note).completion),
      );
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
