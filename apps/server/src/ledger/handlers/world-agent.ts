// The World Agent job handler — one per world at a time (serial_group on the
// row; the claim query enforces it, Brief §2.2). Same idempotent-projection
// shape as reflection: retry after a kill -9 re-runs the LLM but can only
// commit the world_agent.committed event once.
import { z } from 'zod';
import { CorruptStateError } from '../../errors.js';
import type { CharacterProfile } from '../../engine/context-assembler.js';
import { assembleContext } from '../../engine/context-assembler.js';
import type { EventSink } from '../../engine/event-sink.js';
import type { Logger } from '../../observability/logger.js';
import type { LlmClient } from '../../llm/types.js';
import type { Storage } from '../../storage/db.js';
import type { JobHandler } from '../runner.js';
import { sceneTranscript } from './reflection.js';

const payloadSchema = z.strictObject({
  scene_id: z.string().min(1),
});

export interface WorldAgentHandlerOptions {
  storage: Storage;
  sink: EventSink;
  llm: LlmClient;
  /** The narrator-class profile the World Agent speaks with. */
  narrator: CharacterProfile;
  logger: Logger;
}

export function createWorldAgentHandler(
  options: WorldAgentHandlerOptions,
): JobHandler {
  const { storage, sink, llm, narrator, logger } = options;

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new CorruptStateError(
        'world_agent_payload',
        `job ${String(job.id)} payload does not match {scene_id}`,
      );
    }
    const { scene_id } = payload.data;

    const already = storage.eventLog
      .readSince(0, 100000)
      .some(
        (e) =>
          e.type === 'world_agent.committed' && e.payload.scene_id === scene_id,
      );
    if (already) {
      logger.debug(
        { job_id: job.id, scene_id },
        'world agent already committed — idempotent no-op',
      );
      return;
    }

    const context = assembleContext(narrator, {
      scene_id,
      world_clock_text: 'The scene has just ended.',
      latest_turns: sceneTranscript(storage, scene_id),
      wiki: [],
    });
    const result = await llm.streamCall({
      kind: 'world_agent',
      characterId: narrator.character_id,
      system: context.stablePrefix,
      prompt: `${context.dynamicTail}\n\n## Instruction\nAs the world agent, note in 1-3 sentences how the world moves on after this scene (weather, schedules, off-screen consequences). Third person, factual.`,
      onTextDelta: (): void => undefined,
    });
    if (!result.ok) throw result.error; // operational -> runner retries (C7)

    sink.append({
      world_id: job.world_id,
      actor_id: 'system:world_agent',
      type: 'world_agent.committed',
      payload: { scene_id, note: result.value.text },
    });
  };
}
