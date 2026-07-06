// The reflection job handler — the first real cold-path work through the
// runner (Milestone 2 step 1). Idempotent projection of the event log: if the
// scene's reflection.committed for this character already exists, the handler
// is a no-op — that is what makes a kill -9 mid-job (and the lease retry that
// follows) safe. LLM text passes the B6 double gate: schema-shaped payload in,
// engine-side idempotency/state check, and only the committed event is durable.
import { z } from 'zod';
import { CorruptStateError, BugError } from '../../errors.js';
import type {
  CharacterProfile,
  TurnLine,
} from '../../engine/context-assembler.js';
import { assembleContext } from '../../engine/context-assembler.js';
import type { EventSink } from '../../engine/event-sink.js';
import type { FaultPointHook } from '../../engine/fault-points.js';
import type { Logger } from '../../observability/logger.js';
import type { LlmClient } from '../../llm/types.js';
import type { Storage } from '../../storage/db.js';
import type { JobHandler } from '../runner.js';

const payloadSchema = z.strictObject({
  scene_id: z.string().min(1),
  character_id: z.string().min(1),
});

export interface ReflectionHandlerOptions {
  storage: Storage;
  sink: EventSink;
  llm: LlmClient;
  profiles: readonly CharacterProfile[];
  logger: Logger;
  faultPoint?: FaultPointHook;
}

/** Transcript of the scene's committed turns — the reflection's raw material. */
export function sceneTranscript(storage: Storage, sceneId: string): TurnLine[] {
  const lines: TurnLine[] = [];
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.type === 'turn.committed' && event.payload.scene_id === sceneId) {
      for (const step of event.payload.steps) {
        lines.push({ speaker: step.speaker, text: step.text });
      }
    }
  }
  return lines;
}

export function createReflectionHandler(
  options: ReflectionHandlerOptions,
): JobHandler {
  const { storage, sink, llm, profiles, logger } = options;
  const faultPoint = options.faultPoint ?? ((): void => undefined);

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      // Our own stored data failed its schema — that is corruption, not input (C2).
      throw new CorruptStateError(
        'reflection_payload',
        `job ${String(job.id)} payload does not match {scene_id, character_id}`,
      );
    }
    const { scene_id, character_id } = payload.data;

    const profile = profiles.find((p) => p.character_id === character_id);
    if (profile === undefined) {
      throw new BugError(
        'unknown_character',
        `no profile for ${character_id} — enqueue and registry disagree`,
      );
    }

    // Idempotency gate: the retry after a kill -9 must not reflect twice.
    const already = storage.eventLog
      .readSince(0, 100000)
      .some(
        (e) =>
          e.type === 'reflection.committed' &&
          e.payload.scene_id === scene_id &&
          e.payload.character_id === character_id,
      );
    if (already) {
      logger.debug(
        { job_id: job.id, scene_id, character_id },
        'reflection already committed — idempotent no-op',
      );
      return;
    }

    const context = assembleContext(profile, {
      scene_id,
      world_clock_text: 'The scene has just ended.',
      latest_turns: sceneTranscript(storage, scene_id),
      wiki: [],
    });
    const result = await llm.streamCall({
      kind: 'reflection',
      characterId: character_id,
      system: context.stablePrefix,
      prompt: `${context.dynamicTail}\n\n## Instruction\nReflect on this scene in 2-4 sentences from your own point of view: what you learned, what you intend to do. First person, private thoughts.`,
      onTextDelta: (): void => undefined, // reflections do not stream to clients
    });
    if (!result.ok) throw result.error; // operational -> runner retries (C7)

    await faultPoint('mid_reflection');
    sink.append({
      world_id: job.world_id,
      actor_id: character_id,
      type: 'reflection.committed',
      payload: { scene_id, character_id, summary: result.value.text },
    });
  };
}
