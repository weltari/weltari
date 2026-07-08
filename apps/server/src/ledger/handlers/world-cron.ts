// World-cron occurrence handlers (Milestone 2 step 2). Two classes share one
// idempotent shape — the committed event is keyed by (cron_type,
// scheduled_for), so the post-kill lease retry can never replay an occurrence
// twice. code = pure projection, done in the same tick it is claimed;
// llm = background narration of the occurrence, budget-capped at enqueue time.
import { z } from 'zod';
import { CorruptStateError } from '../../errors.js';
import type { CharacterProfile } from '../../engine/context-assembler.js';
import { assembleContext } from '../../engine/context-assembler.js';
import type { EventSink } from '../../engine/event-sink.js';
import type { FaultPointHook } from '../../engine/fault-points.js';
import type { Logger } from '../../observability/logger.js';
import type { LlmClient } from '../../llm/types.js';
import type { Storage } from '../../storage/db.js';
import type { JobHandler } from '../runner.js';

const payloadSchema = z.strictObject({
  cron_type: z.string().min(1),
  scheduled_for: z.string().min(1),
});

function alreadyCompleted(
  storage: Storage,
  worldId: string,
  cronType: string,
  scheduledFor: string,
): boolean {
  return storage.eventLog
    .readSince(0, 100000)
    .some(
      (e) =>
        e.type === 'world_cron.completed' &&
        e.world_id === worldId &&
        e.payload.cron_type === cronType &&
        e.payload.scheduled_for === scheduledFor,
    );
}

export interface WorldCronCodeHandlerOptions {
  storage: Storage;
  sink: EventSink;
  logger: Logger;
  faultPoint?: FaultPointHook;
}

export function createWorldCronCodeHandler(
  options: WorldCronCodeHandlerOptions,
): JobHandler {
  const { storage, sink, logger } = options;
  const faultPoint = options.faultPoint ?? ((): void => undefined);

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new CorruptStateError(
        'world_cron_payload',
        `job ${String(job.id)} payload does not match {cron_type, scheduled_for}`,
      );
    }
    const { cron_type, scheduled_for } = payload.data;
    if (alreadyCompleted(storage, job.world_id, cron_type, scheduled_for)) {
      logger.debug(
        { job_id: job.id, cron_type, scheduled_for },
        'world cron occurrence already completed — idempotent no-op',
      );
      return;
    }
    await faultPoint('mid_cron');
    // Last-instant idempotency re-check, NO await between it and the append
    // (the week-7 painter lease-expiry overlap class, docs/painter.md) — the
    // faultPoint above is an await point, so an overlapped retry can slip in.
    if (alreadyCompleted(storage, job.world_id, cron_type, scheduled_for)) {
      logger.warn(
        { job_id: job.id, cron_type, scheduled_for },
        'world cron occurrence overlapped its own lease-expiry retry — zero duplicate events',
      );
      return;
    }
    sink.append({
      world_id: job.world_id,
      actor_id: 'system:world_cron',
      type: 'world_cron.completed',
      payload: { cron_type, scheduled_for, job_class: 'code' },
    });
  };
}

export interface WorldCronLlmHandlerOptions {
  storage: Storage;
  sink: EventSink;
  llm: LlmClient;
  /** The narrator-class profile world-cron narration speaks with. */
  narrator: CharacterProfile;
  logger: Logger;
  faultPoint?: FaultPointHook;
}

export function createWorldCronLlmHandler(
  options: WorldCronLlmHandlerOptions,
): JobHandler {
  const { storage, sink, llm, narrator, logger } = options;
  const faultPoint = options.faultPoint ?? ((): void => undefined);

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new CorruptStateError(
        'world_cron_payload',
        `job ${String(job.id)} payload does not match {cron_type, scheduled_for}`,
      );
    }
    const { cron_type, scheduled_for } = payload.data;
    if (alreadyCompleted(storage, job.world_id, cron_type, scheduled_for)) {
      logger.debug(
        { job_id: job.id, cron_type, scheduled_for },
        'world cron occurrence already completed — idempotent no-op',
      );
      return;
    }

    const context = assembleContext(narrator, {
      scene_id: `wcron:${cron_type}`,
      world_clock_text: `Fictional time ${scheduled_for}`,
      latest_turns: [],
      wiki: [],
    });
    const result = await llm.streamCall({
      kind: 'world_agent',
      characterId: narrator.character_id,
      system: context.stablePrefix,
      prompt: `${context.dynamicTail}\n\n## Instruction\nThe recurring world event "${cron_type}" just occurred off-screen. Note its outcome in 1-2 factual sentences.`,
      onTextDelta: (): void => undefined,
    });
    if (!result.ok) throw result.error; // operational -> runner retries (C7)

    await faultPoint('mid_cron');
    // Last-instant idempotency re-check, NO await between it and the append
    // (the week-7 painter lease-expiry overlap class, docs/painter.md): a slow
    // generation can outlive its lease and overlap its own reclaimed retry.
    if (alreadyCompleted(storage, job.world_id, cron_type, scheduled_for)) {
      logger.warn(
        { job_id: job.id, cron_type, scheduled_for },
        'world cron occurrence overlapped its own lease-expiry retry — one duplicate generation, zero duplicate events',
      );
      return;
    }
    sink.append({
      world_id: job.world_id,
      actor_id: 'system:world_cron',
      type: 'world_cron.completed',
      payload: {
        cron_type,
        scheduled_for,
        job_class: 'llm',
        note: result.value.text,
      },
    });
  };
}
