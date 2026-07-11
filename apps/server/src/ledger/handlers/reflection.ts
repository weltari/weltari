// The reflection job handler — the first real cold-path work through the
// runner (Milestone 2 step 1). Idempotent projection of the event log: if the
// scene's reflection.committed for this character already exists, the handler
// is a no-op — that is what makes a kill -9 mid-job (and the lease retry that
// follows) safe. LLM text passes the B6 double gate: schema-shaped payload in,
// engine-side idempotency/state check, and only the committed event is durable.
import { z } from 'zod';
import { CorruptStateError, BugError } from '../../errors.js';
import { capCacheLine } from '../../engine/cache.js';
import type {
  CharacterProfile,
  TurnLine,
} from '../../engine/context-assembler.js';
import { assembleContext } from '../../engine/context-assembler.js';
import type { EventSink } from '../../engine/event-sink.js';
import { liveProfile } from '../../engine/memory.js';
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

    const context = assembleContext(liveProfile(storage, profile), {
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
    // Last-instant idempotency re-check, with NO await between it and the
    // append: a slow generation can outlive its lease, the sweep reclaims the
    // "dead" job, and a second execution overlaps this one (the week-7
    // painter bug class, docs/painter.md). Executions interleave only at
    // await points in this single-process runtime, so check+append
    // back-to-back is race-free — the loser no-ops here.
    const committedMeanwhile = storage.eventLog
      .readSince(0, 100000)
      .some(
        (e) =>
          e.type === 'reflection.committed' &&
          e.payload.scene_id === scene_id &&
          e.payload.character_id === character_id,
      );
    if (committedMeanwhile) {
      logger.warn(
        { job_id: job.id, scene_id, character_id },
        'reflection overlapped its own lease-expiry retry — one duplicate generation, zero duplicate events',
      );
      return;
    }
    // The scene-origin CACHE line rides the SAME transaction (M6 part 2,
    // Rev 4 §11 first slice): until the C-Module writes CACHE in-scene, the
    // character's own reflection summary is its "just happened to me" pointer
    // — character-authored, engine-wrapped, and chat catch-up reads it as the
    // latest scene experience.
    const cacheLine = capCacheLine(result.value.text);
    sink.appendMany([
      {
        world_id: job.world_id,
        actor_id: character_id,
        type: 'reflection.committed',
        payload: { scene_id, character_id, summary: result.value.text },
      },
      ...(cacheLine === undefined
        ? []
        : [
            {
              world_id: job.world_id,
              actor_id: character_id,
              type: 'cache.appended' as const,
              payload: {
                character_id,
                origin: 'scene' as const,
                context_id: scene_id,
                line: cacheLine,
              },
            },
          ]),
    ]);
  };
}
