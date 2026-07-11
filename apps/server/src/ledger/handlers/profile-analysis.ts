// The profile_analysis job handler (M7 part 2, Rev 4 §9 Job 2): the GM's
// analysis skill over an ENDED scene or chat range — structured hypotheses
// about the user (story-quality signals, never raw time-spent) written to
// the DELETABLE side store; the event log carries only profile.updated with
// a count. Consent-first twice over: the enqueue sites fire only while
// profiling_enabled is on, and this handler re-checks the fold at run time —
// a toggle-off between enqueue and run means ZERO writes. Idempotent per
// (actor, context) with the fused lease-overlap re-check.
import { z } from 'zod';
import type { WeltariEvent } from '@weltari/protocol';
import { CorruptStateError } from '../../errors.js';
import { flagOf } from '../../engine/config-flags.js';
import {
  assembleContext,
  type TurnLine,
} from '../../engine/context-assembler.js';
import { buildGmProfile, GM_CHARACTER_ID } from '../../engine/gm.js';
import { sanitizeMemoryText } from '../../engine/memory.js';
import { validateAt } from '../../boundary/validate.js';
import type { FaultPointHook } from '../../engine/fault-points.js';
import type { EventBus } from '../../http/bus.js';
import { parseLlmJson } from '../../llm/structured.js';
import type { LlmClient } from '../../llm/types.js';
import type { Logger } from '../../observability/logger.js';
import type { Storage } from '../../storage/db.js';
import type { JobHandler } from '../runner.js';

const payloadSchema = z.strictObject({
  user_actor_id: z.string().min(1),
  origin: z.enum(['scene', 'chat']),
  /** Scene id, or `<conversation_id>:<range_end_id>` for a chat range. */
  context_id: z.string().min(1),
});

/** Gate 1 for the analysis output (B6): 1–5 short hypotheses. */
const hypothesesSchema = z.strictObject({
  hypotheses: z.array(z.string().min(1).max(300)).min(1).max(5),
});

export interface ProfileAnalysisHandlerOptions {
  storage: Storage;
  eventBus: EventBus;
  llm: LlmClient;
  logger: Logger;
  faultPoint?: FaultPointHook;
}

/** The analyzed material: scene turns, or the chat range's lines. Labeled
 * source data only — it rides the tail delimiter-wrapped (B14: profiling
 * input is external data). */
function transcriptOf(storage: Storage, contextId: string): TurnLine[] {
  const lines: TurnLine[] = [];
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (
      event.type === 'turn.committed' &&
      event.payload.scene_id === contextId
    ) {
      for (const step of event.payload.steps) {
        lines.push({ speaker: step.speaker, text: step.text });
      }
    } else if (
      event.type === 'chat.message_committed' &&
      contextId.startsWith(`${event.payload.conversation_id}:`)
    ) {
      const rangeEnd = Number(contextId.slice(contextId.lastIndexOf(':') + 1));
      if (event.id <= rangeEnd) {
        lines.push({
          speaker: event.payload.sender === 'user' ? 'User' : 'Character',
          text: event.payload.text,
        });
      }
    }
  }
  return lines.slice(-40);
}

export function createProfileAnalysisHandler(
  options: ProfileAnalysisHandlerOptions,
): JobHandler {
  const { storage, eventBus, llm, logger } = options;
  const faultPoint = options.faultPoint ?? ((): void => undefined);

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new CorruptStateError(
        'profile_analysis_payload',
        `job ${String(job.id)} payload does not match {user_actor_id, origin, context_id}`,
      );
    }
    const { user_actor_id, origin, context_id } = payload.data;

    // Consent re-check (Rev 4 §9 guardrails): the flag may have flipped off
    // while this job waited — off means ZERO profile writes, a silent no-op.
    if (!flagOf(storage, job.world_id, 'profiling_enabled')) {
      logger.info(
        { job_id: job.id, context_id },
        'profiling disabled — analysis skipped, zero writes',
      );
      return;
    }
    // Idempotency gate: one hypothesis set per (actor, context), ever.
    if (storage.userProfile.hasContext(user_actor_id, context_id)) {
      logger.debug(
        { job_id: job.id, context_id },
        'profile_analysis already committed — idempotent no-op',
      );
      return;
    }

    const lines = transcriptOf(storage, context_id);
    if (lines.length === 0) {
      logger.info(
        { job_id: job.id, context_id },
        'nothing to analyze — skipped',
      );
      return;
    }
    const context = assembleContext(buildGmProfile(), {
      scene_id: context_id,
      heading: origin === 'scene' ? 'Scene' : 'Conversation',
      world_clock_text: 'You are analyzing a session that just ended.',
      latest_turns: lines,
      wiki: [],
    });
    const result = await llm.streamCall({
      kind: 'profile_analysis',
      characterId: GM_CHARACTER_ID,
      system: context.stablePrefix,
      prompt: `${context.dynamicTail}\n\n## Instruction\nAnalyze the ended ${origin === 'scene' ? 'scene' : 'chat'} above for STORY-QUALITY signals about the user: what kinds of moments they lean into, what they avoid, how they like to be engaged. Never measure raw time or activity. Answer ONLY with JSON: {"hypotheses": ["...", ...]} — 1 to 5 short hypotheses, each one sentence, each useful to a Narrator shaping their next scene.`,
      onTextDelta: (): void => undefined, // analysis never streams to clients
    });
    if (!result.ok) throw result.error; // operational -> runner retries (C7)

    // B6 gate 1: the one audited JSON path + validateAt.
    const parsed = validateAt(
      'llm',
      'profile:hypotheses',
      hypothesesSchema,
      parseLlmJson(result.value.text),
      logger,
    );
    if (!parsed.ok) {
      // Malformed output is operational — the runner's retry regenerates.
      throw parsed.error;
    }
    // Gate 2 (hygiene): profiling text re-enters prompts later — neutralize
    // wrapper-closing brackets exactly like memory text (B14); a line that
    // sanitizes to nothing simply drops.
    const hypotheses = parsed.value.hypotheses.flatMap((h) => {
      const clean = sanitizeMemoryText(h, 300);
      return clean === undefined ? [] : [clean];
    });
    if (hypotheses.length === 0) {
      logger.warn(
        { job_id: job.id, context_id },
        'every hypothesis sanitized to nothing — zero writes',
      );
      return;
    }

    await faultPoint('mid_profile_analysis');
    // Fused lease-overlap re-check — NO await from here to the transaction.
    if (storage.userProfile.hasContext(user_actor_id, context_id)) {
      logger.warn(
        { job_id: job.id, context_id },
        'profile_analysis overlapped its own retry — zero duplicate rows',
      );
      return;
    }
    // Side-store rows + the count event in ONE transaction: the log never
    // says "updated" without the rows existing, and vice versa.
    let updated: WeltariEvent | undefined;
    storage.transact(() => {
      for (const body of hypotheses) {
        storage.userProfile.append({
          actor_id: user_actor_id,
          kind: 'hypothesis',
          body,
          context_id,
        });
      }
      updated = storage.eventLog.append({
        world_id: job.world_id,
        actor_id: GM_CHARACTER_ID,
        type: 'profile.updated',
        payload: {
          user_actor_id,
          hypothesis_count: storage.userProfile.count(user_actor_id),
          context_id,
        },
      });
    });
    if (updated !== undefined) eventBus.publish(updated);
  };
}
