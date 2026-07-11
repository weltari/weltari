// The memory_compaction job handler (M7 part 1, Rev 4 §11): summarize the
// character's deltas older than the window into ONE cumulative record —
// memory.compacted covering every delta with log id <= up_to_id. Deltas are
// NEVER removed (the log is append-only, and the Search Index keeps serving
// them to memoryquery); the record is a reading convenience the archive view
// prefers. Because the raw material is immutable, any bad pass is repaired
// for free: a re-run with `repair` appends a superseding record for the same
// range (latest wins in the fold) — no deletion exists or is needed.
// Idempotent per (character, up_to_id) with the fused lease-overlap re-check.
// World-inert: enqueued after reflection commits and by the boot sweep, on
// the character's memory mailbox (serial group — it can never race the
// reflections that feed it).
import { z } from 'zod';
import { CorruptStateError, BugError } from '../../errors.js';
import type { CharacterProfile } from '../../engine/context-assembler.js';
import { assembleContext } from '../../engine/context-assembler.js';
import type { EventSink } from '../../engine/event-sink.js';
import type { FaultPointHook } from '../../engine/fault-points.js';
import {
  liveProfile,
  memoryStateOf,
  sanitizeMemoryText,
} from '../../engine/memory.js';
import type { LlmClient } from '../../llm/types.js';
import type { Logger } from '../../observability/logger.js';
import type { Storage } from '../../storage/db.js';
import type { JobHandler } from '../runner.js';

const payloadSchema = z.strictObject({
  character_id: z.string().min(1),
  /** Newest delta log id the pass covers (the natural key's second half). */
  up_to_id: z.int().positive(),
  /** Repair mode (Rev 4 §11 "repair for free"): append a superseding record
   * even though one exists for this range — the fold takes the latest. */
  repair: z.literal(true).optional(),
});

export interface MemoryCompactionHandlerOptions {
  storage: Storage;
  sink: EventSink;
  llm: LlmClient;
  profiles: readonly CharacterProfile[];
  logger: Logger;
  faultPoint?: FaultPointHook;
}

export function createMemoryCompactionHandler(
  options: MemoryCompactionHandlerOptions,
): JobHandler {
  const { storage, sink, llm, profiles, logger } = options;
  const faultPoint = options.faultPoint ?? ((): void => undefined);

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new CorruptStateError(
        'memory_compaction_payload',
        `job ${String(job.id)} payload does not match {character_id, up_to_id}`,
      );
    }
    const { character_id, up_to_id, repair } = payload.data;

    const profile = profiles.find((p) => p.character_id === character_id);
    if (profile === undefined) {
      throw new BugError(
        'unknown_character',
        `no profile for ${character_id} — enqueue and registry disagree`,
      );
    }

    const alreadyCompacted = (): boolean =>
      storage.eventLog
        .readSince(0, 100000)
        .some(
          (e) =>
            e.type === 'memory.compacted' &&
            e.payload.character_id === character_id &&
            e.payload.up_to_id === up_to_id,
        );

    // Idempotency gate (skipped in repair mode — a repair MEANS re-running a
    // range that already has a record; the new one supersedes in the fold).
    if (repair !== true && alreadyCompacted()) {
      logger.debug(
        { job_id: job.id, character_id, up_to_id },
        'memory compaction range already recorded — idempotent no-op',
      );
      return;
    }

    // The pass's input: the PRIOR summary (if its range is inside this one)
    // + every delta the new record will cover beyond it. Deltas are read
    // from the immutable log — a re-run always sees identical material.
    const state = memoryStateOf(storage, character_id);
    const priorSummary =
      state.compaction !== undefined && state.compaction.up_to_id < up_to_id
        ? state.compaction.summary
        : undefined;
    const floor =
      priorSummary === undefined ? 0 : (state.compaction?.up_to_id ?? 0);
    const covered = state.deltas.filter(
      (d) => d.event_id > floor && d.event_id <= up_to_id,
    );
    const coveredTotal = state.deltas.filter(
      (d) => d.event_id <= up_to_id,
    ).length;
    if (coveredTotal === 0) {
      logger.warn(
        { job_id: job.id, character_id, up_to_id },
        'memory compaction found no deltas in range — nothing to summarize',
      );
      return;
    }

    const context = assembleContext(liveProfile(storage, profile), {
      scene_id: `compaction:${character_id}`,
      heading: 'Memory review',
      world_clock_text: 'A quiet moment of looking back.',
      latest_turns: [],
      wiki: [
        ...(priorSummary === undefined
          ? []
          : [`Your earlier summary of older times: ${priorSummary}`]),
        ...covered.map((d) => `You noted: ${d.content}`),
      ],
    });
    const result = await llm.streamCall({
      kind: 'compaction',
      characterId: character_id,
      system: context.stablePrefix,
      prompt: `${context.dynamicTail}\n\n## Instruction\nCondense the notes above (and the earlier summary, if one is shown) into ONE compact first-person summary of that span of your life — at most a short paragraph. Keep names, unresolved threads and anything you would still act on; drop repetition and mood. This summary will stand in for those notes.`,
      onTextDelta: (): void => undefined, // compaction does not stream
    });
    if (!result.ok) throw result.error; // operational -> runner retries (C7)
    const summary = sanitizeMemoryText(result.value.text, 4000);
    if (summary === undefined) {
      logger.warn(
        { job_id: job.id, character_id, up_to_id },
        'compaction summary came back empty — this pass stays quiet (retryable via a fresh enqueue)',
      );
      return;
    }

    await faultPoint('mid_compaction');
    // Fused lease-overlap re-check: NO await between this check and the
    // append — the loser of an overlap no-ops with zero duplicate events.
    // (In repair mode the check is per-execution overlap only: two racing
    // repairs would append two superseding records — harmless, latest wins —
    // but the fused check keeps the normal path exactly-once.)
    if (repair !== true && alreadyCompacted()) {
      logger.warn(
        { job_id: job.id, character_id, up_to_id },
        'memory compaction overlapped its own lease-expiry retry — one duplicate generation, zero duplicate events',
      );
      return;
    }
    sink.append({
      world_id: job.world_id,
      actor_id: character_id,
      type: 'memory.compacted',
      payload: {
        character_id,
        up_to_id,
        delta_count: coveredTotal,
        summary,
      },
    });
    logger.info(
      {
        character_id,
        up_to_id,
        delta_count: coveredTotal,
        repair: repair === true,
      },
      'memory compaction recorded (deltas stay in the log — repair for free)',
    );
  };
}
