// The map_edit job (M5 part 2, Rev 4 §14 Flow A): the GM/interview LLM fills
// the structured generation form from the user's drawn region + intent; the
// form passes the full B6 double gate — schema gate (validateAt over the
// parsed form), then engine-state gate (world exists, centroid square still
// explored) — before the ONLY durable write, sublocation.created (pin at the
// mask centroid, footprint = the drawn polygon). The painter edit job is
// enqueued right after (deterministic key per edit — a kill in between heals
// via the created-exists re-enqueue path). Geometry is code-owned throughout:
// the LLM invents only the name + description.
import { MapPositionSchema } from '@weltari/protocol';
import { z } from 'zod';
import { CorruptStateError, OperationalError } from '../../errors.js';
import type { CharacterProfile } from '../../engine/context-assembler.js';
import { assembleContext } from '../../engine/context-assembler.js';
import type { EventSink } from '../../engine/event-sink.js';
import type { FaultPointHook } from '../../engine/fault-points.js';
import {
  knownSublocations,
  squareOf,
  sublocationAt,
  worldExists,
} from '../../engine/sublocations.js';
import { parseLlmJson } from '../../llm/structured.js';
import type { LlmClient } from '../../llm/types.js';
import type { Logger } from '../../observability/logger.js';
import { editGeometry, enqueueEditPaint } from '../../painter/commands.js';
import type { Storage } from '../../storage/db.js';
import { validateAt } from '../../boundary/validate.js';
import type { JobHandler } from '../runner.js';

const payloadSchema = z.strictObject({
  edit_id: z.string().min(1).max(100),
  points: z.array(MapPositionSchema).min(3).max(128),
  intent: z.string().min(1).max(500),
  requested_by: z.string().min(1),
});

/** Gate 1 subject: the GM form the LLM must return, and nothing else. */
const formSchema = z.strictObject({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
});

export interface MapEditHandlerOptions {
  storage: Storage;
  sink: EventSink;
  llm: LlmClient;
  /** The narrator-class profile the GM form speaks with. */
  narrator: CharacterProfile;
  logger: Logger;
  faultPoint?: FaultPointHook;
}

export function createMapEditHandler(
  options: MapEditHandlerOptions,
): JobHandler {
  const { storage, sink, llm, narrator, logger } = options;
  const faultPoint = options.faultPoint ?? ((): void => undefined);

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new CorruptStateError(
        'map_edit_payload',
        `job ${String(job.id)} payload does not match {edit_id, points, intent, requested_by}`,
      );
    }
    const { edit_id, points, intent, requested_by } = payload.data;
    const geometry = editGeometry(points);

    const created = (): boolean =>
      storage.eventLog
        .readSince(0, 100000)
        .some(
          (e) =>
            e.type === 'sublocation.created' &&
            e.world_id === job.world_id &&
            e.payload.edit_id === edit_id,
        );
    if (created()) {
      // Re-enqueue the paint too (deduped by key): a kill between the event
      // append and the paint enqueue lands here on the lease retry — an edit
      // must never stay created-but-unpainted (I4).
      enqueueEditPaint(storage, job.world_id, edit_id, geometry);
      logger.debug(
        { job_id: job.id, edit_id },
        'edit already created — idempotent no-op',
      );
      return;
    }

    // Nearby known sublocations anchor the GM's invention (Rev 4 §14 Flow A
    // step 2); the user's intent is external text — delimiter-wrapped via
    // the assembler's user_input channel (B14), never trusted as structure.
    const anchors = knownSublocations(storage, job.world_id)
      .map((s) => `${s.name}: ${s.description}`)
      .join('\n');
    const context = assembleContext(narrator, {
      scene_id: `mapedit:${edit_id}`,
      world_clock_text: 'The user reshapes the world map.',
      latest_turns: [],
      user_input: intent,
      wiki: [],
    });
    const result = await llm.streamCall({
      kind: 'map_edit',
      characterId: narrator.character_id,
      system: context.stablePrefix,
      prompt: `${context.dynamicTail}\n\n## Instruction\nThe user drew a region on the world map and asked for what the player input above describes, near these known places:\n${anchors}\nAs the game master, fill the generation form for ONE new sublocation that realizes the request and fits this world. Respond with ONLY a JSON object: {"name": "...", "description": "..."} — name under 120 characters, description 1-2 sentences of what is visibly there.`,
      onTextDelta: (): void => undefined,
    });
    if (!result.ok) throw result.error; // operational -> runner retries (C7)

    // B6 gate 1 (schema): the form must parse — reject, never repair (B4).
    const form = validateAt(
      'llm',
      'map_edit.form',
      formSchema,
      parseLlmJson(result.value.text),
      logger,
    );
    if (!form.ok) {
      throw new OperationalError(
        'map_edit_bad_form',
        'GM form failed the schema gate — retrying regenerates it',
      );
    }

    // B6 gate 2 (engine state): the world must exist and the drawn centroid
    // must still sit on explored ground — a schema can't know either.
    if (!worldExists(storage, job.world_id)) {
      throw new OperationalError(
        'world_not_found',
        `no events exist for world ${job.world_id}`,
      );
    }
    if (
      sublocationAt(storage, job.world_id, squareOf(geometry.centroid)) ===
      undefined
    ) {
      throw new OperationalError(
        'unexplored_ground',
        'the drawn region centers on unexplored fog',
      );
    }

    await faultPoint('mid_map_edit');
    // Last-instant idempotency re-check, NO await between it and the append
    // (the week-7 painter lease-expiry overlap class, docs/painter.md).
    if (created()) {
      enqueueEditPaint(storage, job.world_id, edit_id, geometry);
      logger.warn(
        { job_id: job.id, edit_id },
        'map edit overlapped its own lease-expiry retry — one duplicate generation, zero duplicate rows',
      );
      return;
    }
    sink.append({
      world_id: job.world_id,
      actor_id: requested_by,
      type: 'sublocation.created',
      payload: {
        sublocation_id: `subloc:edit-${edit_id}`,
        name: form.value.name,
        description: form.value.description,
        map_position: geometry.centroid,
        footprint: [...points],
        edit_id,
      },
    });
    // The edit's map presence: the painter repaints ONLY the masked interior
    // (composite-back is the preservation guarantee). Not atomic with the
    // event — a kill in between converges via the created path above.
    enqueueEditPaint(storage, job.world_id, edit_id, geometry);
  };
}
