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
import { knownSublocations, latestBackdropPath } from './sublocations.js';

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

/**
 * open-scene plus the chat→scene handoff surface (M6 part 2, Rev 4 §8):
 * `premise` and `place_request` ride scene.started — the Narrator's first
 * turn folds them in and resolves an unresolved place via the standard
 * create workflow. The HTTP open-scene command never sets them; the
 * startscene() bridge does.
 */
export interface OpenSceneRequest extends OpenSceneCommand {
  premise?: string;
  place_request?: string;
}

export interface SceneLifecycle {
  endScene(command: EndSceneCommand): Result<{ jobsEnqueued: number }>;
  openScene(command: OpenSceneRequest): Result<{ opened: true }>;
}

const reflectionPayloadSchema = z.strictObject({
  scene_id: z.string().min(1),
  character_id: z.string().min(1),
});

function sceneEvents(storage: Storage, sceneId: string): WeltariEvent[] {
  return storage.eventLog
    .readSince(0, 100000)
    .filter((e) => 'scene_id' in e.payload && e.payload.scene_id === sceneId);
}

/** Characters who actually spoke in the scene's committed turns. */
function participantsOf(
  events: readonly WeltariEvent[],
  idByName: ReadonlyMap<string, string>,
): string[] {
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

export interface SceneEndRequest {
  world_id: string;
  actor_id: string;
  scene_id: string;
  /** Present on Narrator end_scene tool closes; absent on the bare HTTP command. */
  end_type?: 'rest' | 'continuation' | 'travel';
  divider_text?: string;
  /** The continuation registration (M6 part 1): where "Jump to the next
   * scene" opens. Present exactly when end_type is `continuation` — the
   * tool stage gates that; the bare HTTP command never carries it. */
  next_scene?: { sublocation_id: string; premise_seed?: string };
}

/**
 * The atomicity core (Brief §2.4): scene.ended + one reflection job per
 * participant + one World Agent job. MUST run inside storage.transact —
 * callers are the HTTP end-scene command and the Narrator's end_scene tool
 * (which commits it in the same transaction as turn.committed). The caller
 * publishes the returned event AFTER its transaction commits.
 */
export function appendSceneEndWithFanOut(
  storage: Storage,
  knownCharacters: readonly KnownCharacter[],
  request: SceneEndRequest,
): { event: WeltariEvent; jobsEnqueued: number } {
  const idByName = new Map(
    knownCharacters.map((c) => [c.name, c.character_id]),
  );
  const participants = participantsOf(
    sceneEvents(storage, request.scene_id),
    idByName,
  );
  let jobsEnqueued = 0;
  const event = storage.eventLog.append({
    world_id: request.world_id,
    actor_id: request.actor_id,
    type: 'scene.ended',
    payload: {
      scene_id: request.scene_id,
      participants,
      ...(request.end_type === undefined ? {} : { end_type: request.end_type }),
      ...(request.divider_text === undefined
        ? {}
        : { divider_text: request.divider_text }),
      ...(request.next_scene === undefined
        ? {}
        : { next_scene: request.next_scene }),
    },
  });
  for (const characterId of participants) {
    const job = storage.ledger.enqueue({
      idempotency_key: `reflection:${characterId}:${request.scene_id}`,
      world_id: request.world_id,
      type: 'reflection',
      payload: { scene_id: request.scene_id, character_id: characterId },
    });
    if (job !== null) jobsEnqueued += 1;
  }
  const worldAgent = storage.ledger.enqueue({
    idempotency_key: `world_agent:${request.scene_id}`,
    world_id: request.world_id,
    type: 'world_agent',
    payload: { scene_id: request.scene_id },
    serial_group: `world_agent:${request.world_id}`,
  });
  if (worldAgent !== null) jobsEnqueued += 1;
  return { event, jobsEnqueued };
}

export function createSceneLifecycle(
  options: SceneLifecycleOptions,
): SceneLifecycle {
  const { storage, eventBus, logger, knownCharacters } = options;

  return {
    endScene(command: EndSceneCommand): Result<{ jobsEnqueued: number }> {
      const events = sceneEvents(storage, command.scene_id);
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

      const { event: persisted, jobsEnqueued } = storage.transact(() =>
        appendSceneEndWithFanOut(storage, knownCharacters, command),
      );
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

    openScene(command: OpenSceneRequest): Result<{ opened: true }> {
      const events = sceneEvents(storage, command.scene_id);
      if (events.some((e) => e.type === 'scene.started')) {
        return err(
          new OperationalError('scene_already_open', 'scene id already used'),
        );
      }

      // Engine-state gate for the 0.8.0 "open AT a sublocation" path: the id
      // must be known to this world (fixture trio or materialized) — the same
      // registry the change_sublocation tool gate reads.
      const openAt =
        command.sublocation_id === undefined
          ? undefined
          : knownSublocations(storage, command.world_id).find(
              (s) => s.sublocation_id === command.sublocation_id,
            );
      if (command.sublocation_id !== undefined && openAt === undefined) {
        return err(
          new OperationalError(
            'unknown_sublocation',
            `no sublocation ${command.sublocation_id} in this world`,
          ),
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

      // The roster projection (M4): one character.joined per KNOWN
      // participant, committed atomically with scene.started — clients
      // render the VN line-up from these, never from a fixture constant.
      // Unknown ids are skipped like any engine-state gate would (B6 ethos):
      // an event may only name a character the engine knows.
      const idByName = new Map(
        knownCharacters.map((c) => [c.character_id, c.name]),
      );
      const unknown = command.participants.filter((id) => !idByName.has(id));
      if (unknown.length > 0) {
        logger.warn(
          { world_id: command.world_id, unknown },
          'open-scene: unknown participant ids skipped from the roster',
        );
      }
      const persisted = storage.transact(() => {
        const events = [
          storage.eventLog.append({
            world_id: command.world_id,
            actor_id: command.actor_id,
            type: 'scene.started',
            payload: {
              scene_id: command.scene_id,
              title: command.title,
              ...(command.premise === undefined
                ? {}
                : { premise: command.premise }),
              ...(command.place_request === undefined
                ? {}
                : { place_request: command.place_request }),
            },
          }),
        ];
        for (const characterId of command.participants) {
          const name = idByName.get(characterId);
          if (name === undefined) continue;
          events.push(
            storage.eventLog.append({
              world_id: command.world_id,
              actor_id: command.actor_id,
              type: 'character.joined',
              payload: {
                scene_id: command.scene_id,
                character_id: characterId,
                name,
              },
            }),
          );
        }
        // The scene opens AT the named sublocation: the backdrop move is part
        // of the same transaction, so a kill leaves no scene stranded halfway.
        // Stubs open too (M6 part 1 — that is the "Jump to the next scene"
        // payoff): position-less until materialized, backdrop when painted.
        if (openAt !== undefined) {
          const backdropPath = latestBackdropPath(
            storage,
            openAt.sublocation_id,
          );
          events.push(
            storage.eventLog.append({
              world_id: command.world_id,
              actor_id: command.actor_id,
              type: 'sublocation.changed',
              payload: {
                scene_id: command.scene_id,
                sublocation_id: openAt.sublocation_id,
                name: openAt.name,
                ...(openAt.map_position === undefined
                  ? {}
                  : { map_position: openAt.map_position }),
                ...(backdropPath === undefined
                  ? {}
                  : { backdrop_path: backdropPath }),
              },
            }),
          );
        }
        return events;
      });
      // Publish AFTER the transaction committed, in append order.
      for (const event of persisted) eventBus.publish(event);
      return ok({ opened: true });
    },
  };
}
