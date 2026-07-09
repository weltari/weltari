// The map_click job (M5 part 2, Rev 4 §14 Flow B steps 2–5): a click outside
// all radii. The VLM classifies a crop of the CURRENT composite around the
// click (with nearby DB labels as anchors); the story LLM invents INSIDE
// that classification (forest → forest encounter, never a throne room); the
// creation flag decides persist-or-discard. Two model outputs, each through
// the full B6 double gate; the ONLY durable write is one map_click.resolved
// event — for a `created` (persistent) outcome that event IS the sublocation
// row (the registry projects it); a `transient` outcome never becomes a
// sublocation at all.
import { join } from 'node:path';
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
import type { VlmClient } from '../../llm/vlm.js';
import type { Logger } from '../../observability/logger.js';
import { clickWindow } from '../../painter/commands.js';
import { cropRegionPng, ensureBaseImage } from '../../painter/painter.js';
import type { Storage } from '../../storage/db.js';
import { validateAt } from '../../boundary/validate.js';
import type { JobHandler } from '../runner.js';

const payloadSchema = z.strictObject({
  click_id: z.string().min(1).max(100),
  point: MapPositionSchema,
  requested_by: z.string().min(1),
});

/** Gate-1 subject #1: the VLM classification (Rev 4 §14 Flow B step 2) —
 * exactly one of terrain_type/building_type; reject, never repair (B4). */
export const classificationSchema = z
  .strictObject({
    terrain_type: z.string().min(1).max(60).optional(),
    building_type: z.string().min(1).max(60).optional(),
    is_enterable: z.boolean(),
    suggested_setting: z.string().min(1).max(500),
    style_tags: z.array(z.string().min(1).max(40)).max(10),
  })
  .refine(
    (c) => (c.terrain_type === undefined) !== (c.building_type === undefined),
    'exactly one of terrain_type / building_type',
  );

/** Gate-1 subject #2: the story LLM's invention + the creation flag. */
const inventionSchema = z.strictObject({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  persistence: z.enum(['persistent', 'transient']),
});

export interface MapClickHandlerOptions {
  storage: Storage;
  sink: EventSink;
  llm: LlmClient;
  vlm: VlmClient;
  /** The narrator-class profile the story invention speaks with. */
  narrator: CharacterProfile;
  imagesDir: string;
  logger: Logger;
  faultPoint?: FaultPointHook;
}

export function createMapClickHandler(
  options: MapClickHandlerOptions,
): JobHandler {
  const { storage, sink, llm, vlm, narrator, imagesDir, logger } = options;
  const faultPoint = options.faultPoint ?? ((): void => undefined);

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new CorruptStateError(
        'map_click_payload',
        `job ${String(job.id)} payload does not match {click_id, point, requested_by}`,
      );
    }
    const { click_id, point, requested_by } = payload.data;

    const resolved = (): boolean =>
      storage.eventLog
        .readSince(0, 100000)
        .some(
          (e) =>
            e.type === 'map_click.resolved' &&
            e.world_id === job.world_id &&
            e.payload.click_id === click_id,
        );
    if (resolved()) {
      logger.debug(
        { job_id: job.id, click_id },
        'click already resolved — idempotent no-op',
      );
      return;
    }

    // The VLM sees what the USER sees: a crop of the current composite
    // around the click (the event log names the current image, Brief §2.1).
    const imageId = `map:${job.world_id}`;
    let currentPath: string | null = null;
    for (const event of storage.eventLog.readSince(0, 100000)) {
      if (
        event.type === 'painter.completed' &&
        event.payload.image_id === imageId
      ) {
        currentPath = event.payload.path;
      }
    }
    const basePath =
      currentPath === null
        ? await ensureBaseImage(imagesDir, imageId)
        : join(imagesDir, currentPath);
    const crop = await cropRegionPng(basePath, clickWindow(point));

    // Nearby DB labels anchor the classification (Rev 4 §14 Flow B step 2).
    const at = squareOf(point);
    const anchors = knownSublocations(storage, job.world_id)
      .filter((s) => {
        // Interiors/unmaterialized stubs have no map presence — never anchors.
        if (s.map_position === undefined) return false;
        const sq = squareOf(s.map_position);
        return Math.abs(sq.col - at.col) <= 1 && Math.abs(sq.row - at.row) <= 1;
      })
      .map((s) => `${s.name}: ${s.description}`)
      .join('\n');
    const vlmResult = await vlm.describe({
      kind: 'classify_click',
      prompt:
        'The attached image is a crop of a hand-painted top-down fantasy ' +
        'world map; the user clicked its exact center. Known places nearby ' +
        `on this map:\n${anchors === '' ? '(none recorded)' : anchors}\n` +
        'Classify what is visibly AT the center. Respond with ONLY a JSON ' +
        'object: {"terrain_type" OR "building_type": "...", "is_enterable": ' +
        'true|false, "suggested_setting": "one sentence of what standing ' +
        'there is like", "style_tags": ["..."]} — exactly one of ' +
        'terrain_type/building_type, tags lowercase.',
      image: crop,
      mediaType: 'image/png',
    });
    if (!vlmResult.ok) throw vlmResult.error; // operational -> runner retries (C7)

    // B6 gate 1 on the classification: garbage → rejected, zero rows.
    const classification = validateAt(
      'llm',
      'map_click.classification',
      classificationSchema,
      parseLlmJson(vlmResult.value.text),
      logger,
    );
    if (!classification.ok) {
      throw new OperationalError(
        'map_click_bad_classification',
        'VLM classification failed the schema gate — retrying regenerates it',
      );
    }

    // The story LLM invents WITHIN the classification (step 3).
    const kind =
      classification.value.terrain_type ??
      classification.value.building_type ??
      'terrain';
    const context = assembleContext(narrator, {
      scene_id: `mapclick:${click_id}`,
      world_clock_text: 'A traveler steps off the known paths.',
      latest_turns: [],
      wiki: [],
    });
    const storyResult = await llm.streamCall({
      kind: 'jump_in',
      characterId: narrator.character_id,
      system: context.stablePrefix,
      prompt: `${context.dynamicTail}\n\n## Instruction\nA traveler jumps into an unmarked spot on the world map. A vision model classified the spot as: ${kind} — "${classification.value.suggested_setting}" (enterable: ${String(classification.value.is_enterable)}; style: ${classification.value.style_tags.join(', ')}). Known places nearby:\n${anchors === '' ? '(none recorded)' : anchors}\nInvent what the traveler finds STRICTLY within that classification — a ${kind} stays a ${kind}. Decide whether it becomes a lasting place ("persistent": somewhere worth returning to) or a passing moment ("transient": resolves and vanishes). Respond with ONLY a JSON object: {"name": "...", "description": "...", "persistence": "persistent"|"transient"} — name under 120 characters, description 1-2 sentences.`,
      onTextDelta: (): void => undefined,
    });
    if (!storyResult.ok) throw storyResult.error;

    // B6 gate 1 on the invention.
    const invention = validateAt(
      'llm',
      'map_click.invention',
      inventionSchema,
      parseLlmJson(storyResult.value.text),
      logger,
    );
    if (!invention.ok) {
      throw new OperationalError(
        'map_click_bad_invention',
        'story invention failed the schema gate — retrying regenerates it',
      );
    }

    // B6 gate 2 (engine state): the world must exist and the clicked square
    // must still be explored ground.
    if (!worldExists(storage, job.world_id)) {
      throw new OperationalError(
        'world_not_found',
        `no events exist for world ${job.world_id}`,
      );
    }
    if (sublocationAt(storage, job.world_id, squareOf(point)) === undefined) {
      throw new OperationalError(
        'unexplored_ground',
        'the clicked square is no longer explored ground',
      );
    }

    await faultPoint('mid_map_click');
    // Last-instant idempotency re-check, NO await between it and the append
    // (the week-7 painter lease-expiry overlap class, docs/painter.md).
    if (resolved()) {
      logger.warn(
        { job_id: job.id, click_id },
        'map click overlapped its own lease-expiry retry — one duplicate generation, zero duplicate rows',
      );
      return;
    }
    const persistent = invention.value.persistence === 'persistent';
    sink.append({
      world_id: job.world_id,
      actor_id: requested_by,
      type: 'map_click.resolved',
      payload: {
        click_id,
        point,
        outcome: persistent ? 'created' : 'transient',
        ...(persistent ? { sublocation_id: `subloc:click-${click_id}` } : {}),
        name: invention.value.name,
        description: invention.value.description,
      },
    });
  };
}
