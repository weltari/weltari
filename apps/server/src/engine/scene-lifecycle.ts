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
import { flagOf } from './config-flags.js';
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { EventBus } from '../http/bus.js';
import { addMinutesIso } from '../ledger/scheduler.js';
import type { Logger } from '../observability/logger.js';
import type { Storage } from '../storage/db.js';
import { knownCharactersOf } from './characters.js';
import { knownSublocations, latestBackdropPath } from './sublocations.js';
import { worldTimeOf } from './world-clock.js';

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
  /** M7 part 4: the marker engine's scene-end fan-out (follow-up / top-up). */
  markerFanOut?: SceneEndMarkerFanOut;
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
  /**
   * The character-fired invitation (0.13.0, Rev 4 §7): only the chat
   * bridge's CHARACTER path sets it — the dev-mode button and every
   * user-fired open never do (the user firing a scene IS showing up).
   * The engine stamps `expires_at_game` against the world clock at open;
   * the character supplied only its own game-time `wait_hours`.
   */
  invitation?: {
    character_id: string;
    place: string;
    wait_hours: number;
  };
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

/**
 * The scene's live cast (0.21.0, Rev 4 §6): character.joined minus
 * character.left, in event order — the turn engine's roster source (the
 * agentic loop validates charactercalls against it) and the presence
 * projection's per-scene mirror. `tracked` distinguishes a scene whose cast
 * EMPTIED (every joiner left — stays empty) from one with no roster events
 * at all (bare test worlds / pre-0.21 logs — the engine's fixture default
 * applies there instead).
 */
export function sceneRosterOf(
  storage: Storage,
  sceneId: string,
): { cast: KnownCharacter[]; tracked: boolean } {
  const roster = new Map<string, KnownCharacter>();
  let tracked = false;
  for (const event of sceneEvents(storage, sceneId)) {
    if (event.type === 'character.joined') {
      tracked = true;
      roster.set(event.payload.character_id, {
        character_id: event.payload.character_id,
        name: event.payload.name,
      });
    } else if (event.type === 'character.left') {
      tracked = true;
      roster.delete(event.payload.character_id);
    }
  }
  return { cast: [...roster.values()], tracked };
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
  /** Present on Narrator end_scene tool closes; absent on the bare HTTP
   * command. 0.21.0: context_limit_reached — the engine's context-budget
   * warning ended the scene (Rev 4 §6). */
  end_type?: 'rest' | 'continuation' | 'travel' | 'context_limit_reached';
  divider_text?: string;
  /** The continuation registration (M6 part 1; the FULL Rev 4 §6 payload
   * since 0.21.0): where and how "Jump to the next scene" opens. Present
   * exactly when end_type is `continuation` — the tool stage gates that;
   * the bare HTTP command never carries it. */
  next_scene?: {
    sublocation_id: string;
    premise_seed?: string;
    time_offset_hours?: number;
    expected_participants?: string[];
    brief_history?: string;
    carried_goals?: string[];
  };
  /** The ending scene's follow-up chance-encounter marker (M7 part 4, Rev 4
   * §14): present when the Narrator's end_scene tool proposed one. The
   * marker fan-out drops it in the SAME transaction as scene.ended; absent =
   * the engine top-up keeps the world above the marker minimum instead. */
  follow_up_marker?: {
    sublocation_id: string;
    premise_seed: string;
    involved_characters?: string[];
    ttl_game_minutes?: number;
  };
}

/**
 * The scene-end marker fan-out seam (M7 part 4, Rev 4 §14): implemented by
 * the marker engine, declared here so scene-lifecycle never imports it (no
 * cycle). Runs INSIDE the end transaction, after scene.ended is appended —
 * so presence reads the scene as closed and the 1–5 fold sees final truth.
 */
export interface SceneEndMarkerFanOut {
  appendSceneEndMarkers(request: SceneEndRequest): WeltariEvent[];
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
  /** M7 part 4: the marker engine's fan-out — follow-up drop or top-up in
   * the SAME transaction. Optional so storage-only tests stay lean. */
  markerFanOut?: SceneEndMarkerFanOut,
): { event: WeltariEvent; jobsEnqueued: number; markerEvents: WeltariEvent[] } {
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
      // The character's memory mailbox (M7 part 1, Rev 4 §11): every job
      // that writes this character's memory serializes here.
      serial_group: `memory:${request.world_id}:${characterId}`,
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
  // GM Job 2 (M7 part 2, Rev 4 §9): the profile-analysis pass over this
  // ended scene — consent-gated at the enqueue (the flag fold) AND re-checked
  // in the handler; only user-ended scenes profile the user (a system actor
  // closing an expired invitation says nothing about them).
  if (
    request.actor_id.startsWith('user:') &&
    flagOf(storage, request.world_id, 'profiling_enabled')
  ) {
    const analysis = storage.ledger.enqueue({
      idempotency_key: `profile_analysis:${request.actor_id}:${request.scene_id}`,
      world_id: request.world_id,
      type: 'profile_analysis',
      payload: {
        user_actor_id: request.actor_id,
        origin: 'scene',
        context_id: request.scene_id,
      },
      // The GM's ledger lane (Rev 4 §4.3: the store's sole writer).
      serial_group: `profile:${request.world_id}`,
    });
    if (analysis !== null) jobsEnqueued += 1;
  }
  // The object GC sweep (M7 part 3, Rev 4 §7): payload-less strays vanish
  // once their creating scene is over — one world-serial sweep per scene end
  // (dropped sticks vanish; payload carriers are exempt in the handler).
  const objectGc = storage.ledger.enqueue({
    idempotency_key: `object_gc:${request.world_id}:${request.scene_id}`,
    world_id: request.world_id,
    type: 'object_gc',
    payload: { ended_scene_id: request.scene_id },
    // One sweep at a time per world — two sweeps racing the same strays
    // would tombstone twice.
    serial_group: `object_gc:${request.world_id}`,
  });
  if (objectGc !== null) jobsEnqueued += 1;
  // The marker loop rides the same transaction (M7 part 4, Rev 4 §6/§14):
  // the ending scene's follow-up becomes a live marker atomically with
  // scene.ended, and a scene that left nothing still leaves the world above
  // the marker minimum via the top-up path.
  const markerEvents = markerFanOut?.appendSceneEndMarkers(request) ?? [];
  return { event, jobsEnqueued, markerEvents };
}

/**
 * The scoped blocking rule (Brief §4), shared by the HTTP open and the
 * marker click: a new scene waits only on THIS world's World-Agent work and
 * THIS scene's participants; painter/cron never block.
 */
export function sceneOpenBlockers(
  storage: Storage,
  worldId: string,
  participants: readonly string[],
): number {
  const involved = new Set(participants);
  return storage.ledger.listActive(worldId).filter((job) => {
    if (job.type === 'world_agent') return true; // world-scoped
    if (job.type === 'reflection') {
      const payload = reflectionPayloadSchema.safeParse(job.payload);
      return payload.success && involved.has(payload.data.character_id);
    }
    return false;
  }).length;
}

/**
 * The pending continuation registration at a sublocation (0.21.0, Rev 4 §6):
 * the world's LATEST scene.ended carrying a full next_scene registration,
 * still unconsumed (no scene has started in the world since that close).
 * Opening at its sublocation makes the open a real continuation — the fold
 * below carries premise/brief_history/carried_goals/expected_participants
 * into the new scene; any LATER open at the same place is a fresh visit.
 */
function pendingRegistrationAt(
  storage: Storage,
  worldId: string,
  sublocationId: string,
):
  | {
      premise_seed?: string | undefined;
      expected_participants?: string[] | undefined;
      brief_history?: string | undefined;
      carried_goals?: string[] | undefined;
    }
  | undefined {
  let pending:
    | {
        sublocation_id: string;
        premise_seed?: string | undefined;
        time_offset_hours?: number | undefined;
        expected_participants?: string[] | undefined;
        brief_history?: string | undefined;
        carried_goals?: string[] | undefined;
      }
    | undefined;
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.world_id !== worldId) continue;
    if (
      event.type === 'scene.ended' &&
      event.payload.next_scene !== undefined
    ) {
      pending = event.payload.next_scene;
    } else if (event.type === 'scene.started') {
      pending = undefined;
    }
  }
  return pending?.sublocation_id === sublocationId ? pending : undefined;
}

/**
 * The scene-open append core (M7 part 4 refactor): scene.started + one
 * character.joined per known participant + the sublocation.changed backdrop
 * move, in append order. MUST run inside storage.transact — callers are
 * openScene and the marker click's instantiate window (which commits it in
 * the same transaction as marker.instantiated). Gates stay with the caller;
 * the caller publishes the returned events AFTER its transaction commits.
 * 0.21.0: opening AT a registered continuation sublocation consumes the
 * registration — brief_history + carried_goals ride scene.started, the
 * premise_seed fills an unset premise, and the expected participants join
 * the cast ("Jump to the next scene" is a continuation, never a cold open).
 */
export function appendSceneOpen(
  storage: Storage,
  knownCharacters: readonly KnownCharacter[],
  command: OpenSceneRequest,
  /** The resolved open-at sublocation (gate result), when one was named. */
  openAt?: {
    sublocation_id: string;
    name: string;
    map_position?: { x: number; y: number };
  },
  /** The engine-stamped invitation (openScene's chat-bridge path only). */
  invitation?: {
    character_id: string;
    place: string;
    wait_hours: number;
    expires_at_game: string;
  },
): WeltariEvent[] {
  const idByName = new Map(
    knownCharacters.map((c) => [c.character_id, c.name]),
  );
  const registration =
    openAt === undefined
      ? undefined
      : pendingRegistrationAt(storage, command.world_id, openAt.sublocation_id);
  const premise = command.premise ?? registration?.premise_seed;
  const participants = [
    ...new Set([
      ...command.participants,
      ...(registration?.expected_participants ?? []),
    ]),
  ];
  const events = [
    storage.eventLog.append({
      world_id: command.world_id,
      actor_id: command.actor_id,
      type: 'scene.started',
      payload: {
        scene_id: command.scene_id,
        title: command.title,
        ...(premise === undefined ? {} : { premise }),
        ...(command.place_request === undefined
          ? {}
          : { place_request: command.place_request }),
        ...(invitation === undefined ? {} : { invitation }),
        ...(registration?.brief_history === undefined
          ? {}
          : { brief_history: registration.brief_history }),
        ...(registration?.carried_goals === undefined ||
        registration.carried_goals.length === 0
          ? {}
          : { carried_goals: registration.carried_goals }),
      },
    }),
  ];
  for (const characterId of participants) {
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
  // The scene opens AT the named sublocation: the backdrop move is part of
  // the same transaction, so a kill leaves no scene stranded halfway.
  if (openAt !== undefined) {
    const backdropPath = latestBackdropPath(storage, openAt.sublocation_id);
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
}

export function createSceneLifecycle(
  options: SceneLifecycleOptions,
): SceneLifecycle {
  const { storage, eventBus, logger, knownCharacters } = options;

  /** Week 19 (audit item 2, the 6a657d9 pattern): the id↔name roster folds
   * LIVE per call — seeds ∪ character.created — so scene opens and ends
   * name minted characters without a restart. */
  function liveKnown(worldId: string): KnownCharacter[] {
    return knownCharactersOf(storage, worldId, knownCharacters);
  }

  return {
    endScene(command: EndSceneCommand): Result<{ jobsEnqueued: number }> {
      const events = sceneEvents(storage, command.scene_id);
      if (!events.some((e) => e.type === 'scene.started')) {
        return err(
          new OperationalError('scene_not_found', 'no scene.started for id'),
        );
      }
      if (
        events.some(
          (e) => e.type === 'scene.ended' || e.type === 'scene.expired',
        )
      ) {
        return err(
          new OperationalError(
            'scene_already_ended',
            'scene.ended or scene.expired exists',
          ),
        );
      }

      const {
        event: persisted,
        jobsEnqueued,
        markerEvents,
      } = storage.transact(() =>
        appendSceneEndWithFanOut(
          storage,
          liveKnown(command.world_id),
          command,
          options.markerFanOut,
        ),
      );
      // Publish AFTER the transaction committed — the bus mirrors durable truth.
      eventBus.publish(persisted);
      for (const markerEvent of markerEvents) eventBus.publish(markerEvent);
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

      const blocking = sceneOpenBlockers(
        storage,
        command.world_id,
        command.participants,
      );
      if (blocking > 0) {
        return err(
          new OperationalError(
            'blocked_on_pending_jobs',
            `waiting on ${String(blocking)} job(s) for this world/participants`,
          ),
        );
      }

      // The roster projection (M4): one character.joined per KNOWN
      // participant, committed atomically with scene.started — clients
      // render the VN line-up from these, never from a fixture constant.
      // Unknown ids are skipped like any engine-state gate would (B6 ethos):
      // an event may only name a character the engine knows.
      const idByName = new Map(
        liveKnown(command.world_id).map((c) => [c.character_id, c.name]),
      );
      const unknown = command.participants.filter((id) => !idByName.has(id));
      if (unknown.length > 0) {
        logger.warn(
          { world_id: command.world_id, unknown },
          'open-scene: unknown participant ids skipped from the roster',
        );
      }
      // The invitation's game-clock deadline is stamped HERE (0.13.0, Rev 4
      // §7): the character chose wait_hours; the engine owns the clock math
      // (A16 — calendar math delegated to the scheduler's pure functions).
      const invitation =
        command.invitation === undefined
          ? undefined
          : {
              character_id: command.invitation.character_id,
              place: command.invitation.place,
              wait_hours: command.invitation.wait_hours,
              expires_at_game: addMinutesIso(
                worldTimeOf(storage, command.world_id),
                Math.round(command.invitation.wait_hours * 60),
              ),
            };
      // Stubs open too (M6 part 1 — that is the "Jump to the next scene"
      // payoff): position-less until materialized, backdrop when painted.
      const persisted = storage.transact(() =>
        appendSceneOpen(
          storage,
          liveKnown(command.world_id),
          command,
          openAt,
          invitation,
        ),
      );
      // Publish AFTER the transaction committed, in append order.
      for (const event of persisted) eventBus.publish(event);
      return ok({ opened: true });
    },
  };
}
