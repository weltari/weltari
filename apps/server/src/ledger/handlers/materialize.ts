// The materialize job (M4 part 2, Rev 4 §14): give one explored fog square a
// sublocation stub. LLM work is confined to inventing the name + description;
// placement is code-owned (the square came from the user's Explore click) and
// the output passes the full B6 double gate — schema gate (validateAt over
// the parsed stub), then engine-state gate (square still empty, world exists)
// — before the ONLY durable write, sublocation.materialized. Idempotent per
// square: the deterministic sublocation id + the already-materialized check
// make the post-kill lease retry converge instead of minting twins (I4,
// mid_materialize).
import { MapSquareSchema } from '@weltari/protocol';
import { z } from 'zod';
import { CorruptStateError, OperationalError } from '../../errors.js';
import type { CharacterProfile } from '../../engine/context-assembler.js';
import { assembleContext } from '../../engine/context-assembler.js';
import type { EventSink } from '../../engine/event-sink.js';
import type { FaultPointHook } from '../../engine/fault-points.js';
import {
  knownSublocations,
  squareCenter,
  sublocationAt,
  sublocationIdForSquare,
  worldExists,
} from '../../engine/sublocations.js';
import { parseLlmJson } from '../../llm/structured.js';
import type { LlmClient } from '../../llm/types.js';
import type { Logger } from '../../observability/logger.js';
import { enqueueSquarePaint } from '../../painter/commands.js';
import type { Storage } from '../../storage/db.js';
import { validateAt } from '../../boundary/validate.js';
import type { JobHandler } from '../runner.js';

const payloadSchema = z.strictObject({ square: MapSquareSchema });

/** Gate 1 subject: the stub the LLM must return, and nothing else. */
const stubSchema = z.strictObject({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
});

export interface MaterializeHandlerOptions {
  storage: Storage;
  sink: EventSink;
  llm: LlmClient;
  /** The narrator-class profile the stub generation speaks with. */
  narrator: CharacterProfile;
  logger: Logger;
  faultPoint?: FaultPointHook;
}

export function createMaterializeHandler(
  options: MaterializeHandlerOptions,
): JobHandler {
  const { storage, sink, llm, narrator, logger } = options;
  const faultPoint = options.faultPoint ?? ((): void => undefined);

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new CorruptStateError(
        'materialize_payload',
        `job ${String(job.id)} payload does not match {square}`,
      );
    }
    const { square } = payload.data;
    if (sublocationAt(storage, job.world_id, square) !== undefined) {
      // Re-enqueue the paint too (deduped by key): a kill between the event
      // append and the paint enqueue lands here on the lease retry — the
      // square must never stay materialized-but-unpainted (I4).
      enqueueSquarePaint(storage, job.world_id, square);
      logger.debug(
        { job_id: job.id, square },
        'square already occupied — idempotent no-op',
      );
      return;
    }

    // Nearby known sublocations anchor the invention (Rev 4 §14 flavor) —
    // dynamic scene state stays in the tail, never the stable prefix (I5).
    const anchors = knownSublocations(storage, job.world_id)
      .map((s) => `${s.name}: ${s.description}`)
      .join('\n');
    const context = assembleContext(narrator, {
      scene_id: `materialize:${sublocationIdForSquare(square)}`,
      world_clock_text: 'The map grows at its explored frontier.',
      latest_turns: [],
      wiki: [],
    });
    const result = await llm.streamCall({
      kind: 'materialize',
      characterId: narrator.character_id,
      system: context.stablePrefix,
      prompt: `${context.dynamicTail}\n\n## Instruction\nA traveler explores an uncharted map square near these known places:\n${anchors}\nInvent ONE new sublocation that fits this world. Respond with ONLY a JSON object: {"name": "...", "description": "..."} — name under 120 characters, description 1-2 sentences.`,
      onTextDelta: (): void => undefined,
    });
    if (!result.ok) throw result.error; // operational -> runner retries (C7)

    // B6 gate 1 (schema): the stub must parse — reject, never repair (B4).
    const stub = validateAt(
      'llm',
      'materialize.stub',
      stubSchema,
      parseLlmJson(result.value.text),
      logger,
    );
    if (!stub.ok) {
      throw new OperationalError(
        'materialize_bad_stub',
        'LLM stub failed the schema gate — retrying regenerates it',
      );
    }

    // B6 gate 2 (engine state): the world must exist and the square must
    // still be empty — a schema can't know either.
    if (!worldExists(storage, job.world_id)) {
      throw new OperationalError(
        'world_not_found',
        `no events exist for world ${job.world_id}`,
      );
    }
    if (sublocationAt(storage, job.world_id, square) !== undefined) {
      logger.debug(
        { job_id: job.id, square },
        'square materialized while generating — idempotent no-op',
      );
      return;
    }

    await faultPoint('mid_materialize');
    sink.append({
      world_id: job.world_id,
      actor_id: 'system:engine',
      type: 'sublocation.materialized',
      payload: {
        sublocation_id: sublocationIdForSquare(square),
        name: stub.value.name,
        description: stub.value.description,
        square,
        map_position: squareCenter(square),
      },
    });
    // Materialization = the map-presence job (Rev 4 §14): the square paints
    // eagerly. Not atomic with the event — a kill in between converges via
    // the occupied path above, which re-enqueues under the same key.
    enqueueSquarePaint(storage, job.world_id, square);
  };
}
