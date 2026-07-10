// The proactive_dm job handler (M6 part 3, Rev 4 §8): a scheduler fire picks
// one eligible character and EAGERLY generates its DM — the push IS the
// message; content is durable at fire time and arrives over the stream like
// any chat line. Owner rulings 2026-07-10: pure real-time trigger in V1 (the
// character LLM never plans future sends — no scheduling tool exists); every
// outreach stamped with BOTH clocks (occurrence_iso drives V1, game_time is
// the V2 future-event-list bridge); growing backoff (base ×2 ×4) then the
// 3-unanswered freeze as a durable event (the part-4 gateway push hook).
// Idempotent per (world, occurrence_iso) with the fused lease-overlap
// re-check — the standing pattern (mid_reflect_chat is the sibling).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CorruptStateError } from '../../errors.js';
import type { CharacterProfile } from '../../engine/context-assembler.js';
import { assembleContext } from '../../engine/context-assembler.js';
import type { TurnLine } from '../../engine/context-assembler.js';
import {
  cacheRecapText,
  capCacheLine,
  latestPerOrigin,
} from '../../engine/cache.js';
import {
  CHAT_CONDUCT_SKILL,
  conversationIdFor,
  presenceOf,
} from '../../engine/chat.js';
import type { EventSink } from '../../engine/event-sink.js';
import type { FaultPointHook } from '../../engine/fault-points.js';
import {
  OUTREACH_FREEZE_CAP,
  outreachEligible,
  outreachState,
  pickIndex,
} from '../../engine/outreach.js';
import { worldTimeOf } from '../../engine/world-clock.js';
import { parseChatToolCall } from '../../llm/tools.js';
import type { LlmClient } from '../../llm/types.js';
import type { Logger } from '../../observability/logger.js';
import type { Storage } from '../../storage/db.js';
import type { JobHandler } from '../runner.js';

const payloadSchema = z.strictObject({
  occurrence_iso: z.string().min(1),
  cadence_minutes: z.number().positive(),
});

export interface ProactiveDmHandlerOptions {
  storage: Storage;
  sink: EventSink;
  llm: LlmClient;
  profiles: readonly CharacterProfile[];
  /** The DM recipient (Rev 4 §8 privacy: keyed by actor_id — the V1
   * singleton; V2 fires per subscribed actor). */
  actorId: string;
  logger: Logger;
  faultPoint?: FaultPointHook;
}

/** The thread's recent lines, chat-shaped (same window as a reply). */
function recentTranscript(
  storage: Storage,
  conversationId: string,
  characterName: string,
): TurnLine[] {
  const lines: TurnLine[] = [];
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (
      event.type === 'chat.message_committed' &&
      event.payload.conversation_id === conversationId
    ) {
      lines.push({
        speaker: event.payload.sender === 'user' ? 'User' : characterName,
        text: event.payload.text,
      });
    }
  }
  return lines.slice(-24);
}

export function createProactiveDmHandler(
  options: ProactiveDmHandlerOptions,
): JobHandler {
  const { storage, sink, llm, profiles, actorId, logger } = options;
  const faultPoint = options.faultPoint ?? ((): void => undefined);

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new CorruptStateError(
        'proactive_dm_payload',
        `job ${String(job.id)} payload does not match {occurrence_iso, cadence_minutes}`,
      );
    }
    const { occurrence_iso, cadence_minutes } = payload.data;

    const alreadyRecorded = (): boolean =>
      storage.eventLog
        .readSince(0, 100000)
        .some(
          (e) =>
            e.type === 'chat.outreach_recorded' &&
            e.world_id === job.world_id &&
            e.payload.occurrence_iso === occurrence_iso,
        );

    // Idempotency gate: one fire = at most one outreach, ever.
    if (alreadyRecorded()) {
      logger.debug(
        { job_id: job.id, occurrence_iso },
        'proactive_dm occurrence already recorded — idempotent no-op',
      );
      return;
    }

    // Deterministic eligibility from the log alone: a kill-retry re-derives
    // the SAME candidate set and the SAME pick (the natural key holds).
    const candidates = profiles.filter((profile) => {
      if (
        presenceOf(storage, job.world_id, profile.character_id).state !==
        'available'
      ) {
        return false; // in a scene = busy (the presence rule, Rev 4 §8)
      }
      const conversationId = conversationIdFor(actorId, profile.character_id);
      return outreachEligible(
        outreachState(storage, conversationId),
        occurrence_iso,
        cadence_minutes,
      );
    });
    if (candidates.length === 0) {
      logger.debug(
        { job_id: job.id, occurrence_iso },
        'proactive_dm fire found no eligible character — quiet no-op',
      );
      return;
    }
    const profile = candidates[pickIndex(occurrence_iso, candidates.length)];
    if (profile === undefined) return; // unreachable: pickIndex < length
    const conversationId = conversationIdFor(actorId, profile.character_id);
    const state = outreachState(storage, conversationId);
    const unansweredCount = state.unanswered + 1;

    // Eager generation (Rev 4 §8): chat-shaped context — the same stable
    // prefix a reply uses (conduct skill included), the outreach framing in
    // the dynamic tail only.
    const recap = cacheRecapText(
      latestPerOrigin(storage, profile.character_id),
    );
    const context = assembleContext(
      { ...profile, skills: [...profile.skills, CHAT_CONDUCT_SKILL] },
      {
        scene_id: conversationId,
        heading: 'Conversation',
        world_clock_text: 'You are outside any scene, texting on your phone.',
        latest_turns: recentTranscript(storage, conversationId, profile.name),
        wiki: [],
        ...(recap === '' ? {} : { cache_recap: recap }),
      },
    );
    const reAsk =
      state.unanswered === 0
        ? 'You feel like reaching out to the User.'
        : `You wrote ${String(state.unanswered)} message(s) since their last reply and heard nothing back — follow up the way a real person would after being left on read (curious, wry, or worried — your call; never robotic).`;
    const result = await llm.streamCall({
      kind: 'chat',
      characterId: profile.character_id,
      system: context.stablePrefix,
      prompt: `${context.dynamicTail}\n\n## Instruction\n${reAsk} Write ${profile.name}'s short text message to the User (1-3 sentences, first person, no narration) — something grounded in your own recent experience or goals, not small talk for its own sake. Do NOT call startscene here: you are texting into silence, not arranging a meeting. After writing it, call the cache tool with a private 1-2 line recap.`,
      onTextDelta: (): void => undefined, // proactive DMs do not stream
      toolset: 'chat',
    });
    if (!result.ok) throw result.error; // operational -> runner retries (C7)
    const text = result.value.text.trim();
    if (text === '') {
      logger.warn(
        { job_id: job.id, occurrence_iso },
        'proactive DM came back empty — this fire stays quiet',
      );
      return;
    }
    let cacheLine: string | undefined;
    for (const raw of result.value.toolCalls) {
      const parsed = parseChatToolCall(raw, logger);
      if (!parsed.ok) continue;
      if (parsed.value.tool === 'cache') {
        cacheLine = capCacheLine(parsed.value.input.line);
      } else {
        // startscene from a CRON fire stays un-honored in V1 (a character
        // cannot open a scene into the user's absence; invitations with TTL
        // are the part-4/§7 surface). Nothing durable happens (B6).
        logger.warn(
          { job_id: job.id, conversation_id: conversationId },
          'proactive DM tried startscene — ignored (V1: CRON never opens scenes)',
        );
      }
    }

    const messageId = `outreach-${randomUUID().slice(0, 12)}`;
    const gameTime = worldTimeOf(storage, job.world_id);

    await faultPoint('mid_proactive_dm');
    // Fused lease-overlap re-check: NO await between this check and the
    // append — the loser of an overlap no-ops with zero duplicate events.
    if (alreadyRecorded()) {
      logger.warn(
        { job_id: job.id, occurrence_iso },
        'proactive_dm overlapped its own lease-expiry retry — one duplicate generation, zero duplicate events',
      );
      return;
    }
    sink.appendMany([
      {
        world_id: job.world_id,
        actor_id: profile.character_id,
        type: 'chat.message_committed',
        payload: {
          conversation_id: conversationId,
          character_id: profile.character_id,
          sender: 'character',
          text,
          message_id: messageId,
        },
      },
      ...(cacheLine === undefined
        ? []
        : [
            {
              world_id: job.world_id,
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
      {
        world_id: job.world_id,
        actor_id: profile.character_id,
        type: 'chat.outreach_recorded',
        payload: {
          conversation_id: conversationId,
          character_id: profile.character_id,
          occurrence_iso,
          game_time: gameTime,
          message_id: messageId,
          unanswered_count: unansweredCount,
        },
      },
      ...(unansweredCount >= OUTREACH_FREEZE_CAP
        ? [
            {
              world_id: job.world_id,
              actor_id: profile.character_id,
              type: 'chat.thread_frozen' as const,
              payload: {
                conversation_id: conversationId,
                character_id: profile.character_id,
                message_id: messageId,
                unanswered_count: unansweredCount,
              },
            },
          ]
        : []),
    ]);
    logger.info(
      {
        conversation_id: conversationId,
        occurrence_iso,
        unanswered_count: unansweredCount,
        frozen: unansweredCount >= OUTREACH_FREEZE_CAP,
      },
      'proactive DM committed at fire time (eager generation)',
    );
  };
}
