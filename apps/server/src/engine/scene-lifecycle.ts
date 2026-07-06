// Scene open/close (Milestone 2 step 1). endScene is the atomicity showcase:
// scene.ended + one reflection job per participating character + one World
// Agent job commit in ONE WriteGate transaction (Brief §2.4) — a kill -9
// leaves either nothing or all of it, never a scene.ended without its jobs.
// openScene enforces the scoped blocking rule (Brief §4): a new scene waits
// only on THIS world's World-Agent work and THIS scene's participants.
import type {
  EndSceneCommand,
  OpenSceneCommand,
  WeltariEvent,
} from '@weltari/protocol';
import { z } from 'zod';
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { EventBus } from '../http/bus.js';
import type { Logger } from '../observability/logger.js';
import type { Storage } from '../storage/db.js';

export interface KnownCharacter {
  character_id: string;
  /** Display name as it appears in turn steps' `speaker`. */
  name: string;
}

export interface SceneLifecycleOptions {
  storage: Storage;
  eventBus: EventBus;
  logger: Logger;
  /** Resolves turn-step speaker names to character ids (fixture world for now). */
  knownCharacters: readonly KnownCharacter[];
}

export interface SceneLifecycle {
  endScene(command: EndSceneCommand): Result<{ jobsEnqueued: number }>;
  openScene(command: OpenSceneCommand): Result<{ opened: true }>;
}

const reflectionPayloadSchema = z.strictObject({
  scene_id: z.string().min(1),
  character_id: z.string().min(1),
});

export function createSceneLifecycle(
  options: SceneLifecycleOptions,
): SceneLifecycle {
  const { storage, eventBus, logger, knownCharacters } = options;
  const idByName = new Map(
    knownCharacters.map((c) => [c.name, c.character_id]),
  );

  function sceneEvents(sceneId: string): WeltariEvent[] {
    return storage.eventLog
      .readSince(0, 100000)
      .filter((e) => 'scene_id' in e.payload && e.payload.scene_id === sceneId);
  }

  /** Characters who actually spoke in the scene's committed turns. */
  function participantsOf(events: readonly WeltariEvent[]): string[] {
    const ids = new Set<string>();
    for (const event of events) {
      if (event.type !== 'turn.committed') continue;
      for (const step of event.payload.steps) {
        if (step.call !== 'character') continue;
        const id = idByName.get(step.speaker);
        if (id !== undefined) ids.add(id);
      }
    }
    return [...ids];
  }

  return {
    endScene(command: EndSceneCommand): Result<{ jobsEnqueued: number }> {
      const events = sceneEvents(command.scene_id);
      if (!events.some((e) => e.type === 'scene.started')) {
        return err(
          new OperationalError('scene_not_found', 'no scene.started for id'),
        );
      }
      if (events.some((e) => e.type === 'scene.ended')) {
        return err(
          new OperationalError('scene_already_ended', 'scene.ended exists'),
        );
      }

      const participants = participantsOf(events);
      let jobsEnqueued = 0;
      const persisted = storage.transact(() => {
        const event = storage.eventLog.append({
          world_id: command.world_id,
          actor_id: command.actor_id,
          type: 'scene.ended',
          payload: { scene_id: command.scene_id, participants },
        });
        for (const characterId of participants) {
          const job = storage.ledger.enqueue({
            idempotency_key: `reflection:${characterId}:${command.scene_id}`,
            world_id: command.world_id,
            type: 'reflection',
            payload: { scene_id: command.scene_id, character_id: characterId },
          });
          if (job !== null) jobsEnqueued += 1;
        }
        const worldAgent = storage.ledger.enqueue({
          idempotency_key: `world_agent:${command.scene_id}`,
          world_id: command.world_id,
          type: 'world_agent',
          payload: { scene_id: command.scene_id },
          serial_group: `world_agent:${command.world_id}`,
        });
        if (worldAgent !== null) jobsEnqueued += 1;
        return event;
      });
      // Publish AFTER the transaction committed — the bus mirrors durable truth.
      eventBus.publish(persisted);
      logger.info(
        {
          world_id: command.world_id,
          scene_id: command.scene_id,
          jobs: jobsEnqueued,
        },
        'scene ended, reflection fan-out enqueued',
      );
      return ok({ jobsEnqueued });
    },

    openScene(command: OpenSceneCommand): Result<{ opened: true }> {
      const events = sceneEvents(command.scene_id);
      if (events.some((e) => e.type === 'scene.started')) {
        return err(
          new OperationalError('scene_already_open', 'scene id already used'),
        );
      }

      const involved = new Set(command.participants);
      const blocking = storage.ledger
        .listActive(command.world_id)
        .filter((job) => {
          if (job.type === 'world_agent') return true; // world-scoped
          if (job.type === 'reflection') {
            const payload = reflectionPayloadSchema.safeParse(job.payload);
            return payload.success && involved.has(payload.data.character_id);
          }
          return false; // painter/cron never block scene opens (Brief §4)
        });
      if (blocking.length > 0) {
        return err(
          new OperationalError(
            'blocked_on_pending_jobs',
            `waiting on ${String(blocking.length)} job(s) for this world/participants`,
          ),
        );
      }

      const persisted = storage.transact(() =>
        storage.eventLog.append({
          world_id: command.world_id,
          actor_id: command.actor_id,
          type: 'scene.started',
          payload: { scene_id: command.scene_id, title: command.title },
        }),
      );
      eventBus.publish(persisted);
      return ok({ opened: true });
    },
  };
}
