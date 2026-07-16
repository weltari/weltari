// The object_gc job handler (M7 part 3, Rev 4 §7): the GC sweep — payload-
// less, sublocation-held objects never touched outside their (ended) creating
// scene are tombstoned with object.swept; the row leaves the projection in
// the SAME transaction while the log stays append-only (I1: the tombstone IS
// the deletion — never an event-log DELETE). Payload carriers are exempt by
// the candidate rule; proposal-applied objects have no creating scene and are
// never candidates. No LLM call — a pure engine sweep. Candidates are
// recomputed INSIDE the transaction (SQLite access is synchronous), so a
// concurrent turn touching a stray can never lose the race, and a retried
// sweep converges: already-swept strays are simply no longer candidates.
import { z } from 'zod';
import type { WeltariEvent } from '@weltari/protocol';
import { CorruptStateError } from '../../errors.js';
import type { FaultPointHook } from '../../engine/fault-points.js';
import type { EventBus } from '../../http/bus.js';
import type { Logger } from '../../observability/logger.js';
import type { Storage } from '../../storage/db.js';
import type { JobHandler } from '../runner.js';

/** The sweep's actor — object.swept events name the engine, never an agent. */
export const OBJECT_GC_ACTOR_ID = 'system:object_gc';

const payloadSchema = z.strictObject({
  /** The scene end that fired this sweep (audit/log context only — the sweep
   * always covers the whole world's strays). */
  ended_scene_id: z.string().min(1),
});

export interface ObjectGcHandlerOptions {
  storage: Storage;
  eventBus: EventBus;
  logger: Logger;
  faultPoint?: FaultPointHook;
}

export function createObjectGcHandler(
  options: ObjectGcHandlerOptions,
): JobHandler {
  const { storage, eventBus, logger } = options;
  const faultPoint = options.faultPoint ?? ((): void => undefined);

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new CorruptStateError(
        'object_gc_payload',
        `job ${String(job.id)} payload does not match {ended_scene_id}`,
      );
    }

    await faultPoint('mid_object_gc');
    // The sweep transaction — candidates recomputed inside it, no await
    // from here on: a stray is swept only if its creating scene has ENDED
    // ("never touched again after their creating scene" needs the scene to
    // be over before the sweep may conclude anything).
    const swept: WeltariEvent[] = [];
    storage.transact(() => {
      const endedScenes = new Set<string>();
      for (const event of storage.eventLog.readSince(0, 100000)) {
        if (
          (event.type === 'scene.ended' || event.type === 'scene.expired') &&
          event.world_id === job.world_id
        ) {
          endedScenes.add(event.payload.scene_id);
        }
      }
      for (const stray of storage.objects.strayCandidates(job.world_id)) {
        if (
          stray.created_scene_id === undefined ||
          !endedScenes.has(stray.created_scene_id)
        ) {
          continue;
        }
        swept.push(
          storage.eventLog.append({
            world_id: job.world_id,
            actor_id: OBJECT_GC_ACTOR_ID,
            type: 'object.swept',
            payload: { object_id: stray.object_id },
          }),
        );
      }
    });
    for (const event of swept) eventBus.publish(event);
    logger.info(
      {
        job_id: job.id,
        ended_scene_id: payload.data.ended_scene_id,
        swept: swept.length,
      },
      'object GC sweep committed',
    );
  };
}
