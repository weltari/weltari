// The reflection job handler — the first real cold-path work through the
// runner (Milestone 2 step 1). Idempotent projection of the event log: if the
// scene's reflection.committed for this character already exists, the handler
// is a no-op — that is what makes a kill -9 mid-job (and the lease retry that
// follows) safe. LLM text passes the B6 double gate: schema-shaped payload in,
// engine-side idempotency/state check, and only the committed event is durable.
import { z } from 'zod';
import { CorruptStateError, BugError } from '../../errors.js';
import {
  CACHE_KEEP_DEFAULT,
  capCacheLine,
  enqueueCachePruneIfDue,
} from '../../engine/cache.js';
import type {
  CharacterProfile,
  TurnLine,
} from '../../engine/context-assembler.js';
import { assembleContext } from '../../engine/context-assembler.js';
import { characterProfilesOf, withLiveLock } from '../../engine/characters.js';
import type { EventSink } from '../../engine/event-sink.js';
import {
  enqueueCompactionIfDue,
  gateReflectionMemory,
  liveProfile,
  memoryEventsFrom,
  type ReflectionMemoryOutput,
} from '../../engine/memory.js';
import {
  parseReflectionToolCall,
  type ValidatedReflectionToolCall,
} from '../../llm/tools.js';
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
  /** CACHE retention limit (Rev 4 §11, env WELTARI_CACHE_KEEP; default 50). */
  cacheKeep?: number;
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

/**
 * Narration-only view of a scene (week 19, Rev 4 §10 source-typing):
 * `character` steps — spoken words and acted attempts — are excluded by the
 * committed step's own `call` label, so a consumer that writes world
 * knowledge can never source from speech. Code, not prompt wording: speech
 * is hearsay and stays wiki-ineligible by construction.
 */
export function sceneNarrationTranscript(
  storage: Storage,
  sceneId: string,
): TurnLine[] {
  const lines: TurnLine[] = [];
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.type === 'turn.committed' && event.payload.scene_id === sceneId) {
      for (const step of event.payload.steps) {
        if (step.call === 'character') continue;
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
  const cacheKeep = options.cacheKeep ?? CACHE_KEEP_DEFAULT;

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

    // The LIVE registry (0.21.0, Rev 4 §6): boot profiles ∪ every
    // character.created at RUN time — a character minted mid-session by
    // make_character (or approved via a GM card) reflects like any fixture
    // character; the boot-time list alone would park the job.
    const registry = characterProfilesOf(storage, job.world_id, profiles);
    const profile = registry.find((p) => p.character_id === character_id);
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
      prompt: `${context.dynamicTail}\n\n## Instruction\nReflect on this scene in 2-4 sentences from your own point of view: what you learned, what you intend to do. First person, private thoughts.\nThen curate your long-term memory (M7): call memory_delta 1-3 times — one lasting, self-contained note each. If this scene changed what you must always remember, also call update_core with your FULL new core list. If it genuinely changed who you are, you may call evolve — rare and earned.`,
      onTextDelta: (): void => undefined, // reflections do not stream to clients
      toolset: 'reflection',
    });
    if (!result.ok) throw result.error; // operational -> runner retries (C7)

    // B6 gate 1 (shape) then gate 2 (caps, locked flag) over the memory
    // outputs — rejected calls drop with a trail entry, zero rows (I8).
    const validated: ValidatedReflectionToolCall[] = [];
    for (const raw of result.value.toolCalls) {
      const parsed = parseReflectionToolCall(raw, logger);
      if (parsed.ok) validated.push(parsed.value);
    }
    // The LIVE lock (M7 part 2, Rev 4 §7): the user's character.lock_set
    // overlays the seed flag at RUN time — a toggle gates the very next
    // evolution, no restart needed.
    const memory: ReflectionMemoryOutput = gateReflectionMemory(
      validated,
      withLiveLock(storage, job.world_id, profile),
      logger,
    );

    await faultPoint('mid_reflection');
    // The new memory-commit window (M7 part 1, criterion d): a kill here —
    // after generation and gating, before the atomic append — must converge
    // to exactly one delta set per (character, scene) on retry.
    await faultPoint('mid_memory_commit');
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
    // The memory outputs ride the SAME transaction as reflection.committed
    // (M7 part 1, Rev 4 §11): replay rebuilds the identical memory state,
    // and the FTS index entry commits with each delta row (storage-side).
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
      ...memoryEventsFrom(memory, {
        world_id: job.world_id,
        character_id,
        origin: 'scene',
        context_id: scene_id,
      }),
    ]);
    // Memory maintenance (M7 part 1): both checks are world-inert — a kill
    // here only delays the pass until the next reflection or the boot sweep.
    enqueueCompactionIfDue(storage, job.world_id, character_id);
    enqueueCachePruneIfDue(storage, job.world_id, character_id, cacheKeep);
  };
}
