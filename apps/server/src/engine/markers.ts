// Chance-encounter markers (M7 part 4, Rev 4 §14/§17): the living-world
// loop's engine. A marker is a LAZY intent — nothing generates, nothing
// enters any log or memory, until clicked. The lifecycle rules are engine
// INVARIANTS, not scheduler behavior:
//
//   - the map holds at least `min` (1) and at most `max` (5) live markers:
//     drops above the maximum are refused with ZERO rows (I8); below the
//     minimum the engine tops up with generated intents (nothing is
//     calculated until the user arrives — the Narrator grounds the encounter
//     in CURRENT state on click);
//   - TTLs are GAME time, stamped against the world clock at drop; expiry is
//     lazy — the sweep runs at every clock advance and at boot (recovery
//     path = startup path), and a click on an expired-but-unswept marker is
//     refused and settles it. A marker already past its TTL at drop time is
//     never dropped at all (born-expired suppression);
//   - first click wins: marker.instantiated + the full scene open commit in
//     ONE transaction; a racing second click loses the fused re-check and is
//     answered "join scene in progress" — never a duplicate parallel scene.
//
// Anchoring is materialized-only (Rev 4 §14): stubs are invisible to the
// map's mechanical loops until the painter lands.
import { randomUUID } from 'node:crypto';
import type { MarkerClickCommand, WeltariEvent } from '@weltari/protocol';
import {
  CorruptStateError,
  err,
  ok,
  OperationalError,
  type Result,
} from '../errors.js';
import type { EventBus } from '../http/bus.js';
import { addMinutesIso } from '../ledger/scheduler.js';
import type { Logger } from '../observability/logger.js';
import type { Storage } from '../storage/db.js';
import type { NewEvent } from '../storage/repositories/event-log.js';
import { presenceOf } from './chat.js';
import type { FaultPointHook } from './fault-points.js';
import { pickIndex } from './outreach.js';
import {
  appendSceneOpen,
  sceneOpenBlockers,
  type KnownCharacter,
  type SceneEndMarkerFanOut,
  type SceneEndRequest,
} from './scene-lifecycle.js';
import { materializedSublocations } from './sublocations.js';
import { worldTimeOf } from './world-clock.js';

/** Rev 4 §15 CRON config: marker min/max (default 1–5) + the default TTL. */
export interface MarkerConfig {
  min: number;
  max: number;
  ttlGameMinutes: number;
}

export const DEFAULT_MARKER_CONFIG: MarkerConfig = {
  min: 1,
  max: 5,
  ttlGameMinutes: 180,
};

/** Engine-generated drops and the sweep write with system provenance. */
export const MARKER_ACTOR_ID = 'system:markers';

export interface MarkerDropRequest {
  world_id: string;
  actor_id: string;
  sublocation_id: string;
  involved_characters: readonly string[];
  premise_seed: string;
  /** The fictional drop stamp — an occurrence's SCHEDULED time on CRON
   * drops, the current world time otherwise. */
  dropped_at_game_time: string;
  ttl_game_minutes: number;
  source: 'scene_end' | 'cron' | 'engine_topup';
  /** scene_end only: the ending scene proposing the follow-up. */
  scene_id?: string;
}

export type MarkerDropOutcome =
  | { outcome: 'dropped'; event: WeltariEvent }
  | { outcome: 'refused_at_max' | 'born_expired' | 'unknown_sublocation' };

/**
 * The one drop gate (MUST run inside storage.transact): every marker.dropped
 * in the system funnels through here, so the 1–5 ceiling, materialized-only
 * anchoring and born-expired suppression hold structurally. A refusal
 * appends NOTHING (I8) — the caller decides whether it is worth a log line.
 * The live recount reads the markers table, which the append feeds in the
 * SAME transaction — sequential drops inside one transaction see each other.
 */
export function appendMarkerDrop(
  storage: Storage,
  config: MarkerConfig,
  request: MarkerDropRequest,
): MarkerDropOutcome {
  const anchored = materializedSublocations(storage, request.world_id).some(
    (s) => s.sublocation_id === request.sublocation_id,
  );
  if (!anchored) return { outcome: 'unknown_sublocation' };
  if (storage.markers.live(request.world_id).length >= config.max) {
    return { outcome: 'refused_at_max' };
  }
  const expiresAt = addMinutesIso(
    request.dropped_at_game_time,
    request.ttl_game_minutes,
  );
  // Born-expired suppression (Rev 4 §14): during time-skip replay a marker
  // whose scheduled_time + ttl already lies behind the clock never surfaces.
  if (expiresAt <= worldTimeOf(storage, request.world_id)) {
    return { outcome: 'born_expired' };
  }
  const event = storage.eventLog.append({
    world_id: request.world_id,
    actor_id: request.actor_id,
    type: 'marker.dropped',
    payload: {
      marker_id: `marker:${randomUUID().slice(0, 8)}`,
      kind: 'map_event',
      sublocation_id: request.sublocation_id,
      involved_characters: [...request.involved_characters],
      premise_seed: request.premise_seed,
      dropped_at_game_time: request.dropped_at_game_time,
      ttl_game_minutes: request.ttl_game_minutes,
      expires_at_game_time: expiresAt,
      source: request.source,
      ...(request.scene_id === undefined ? {} : { scene_id: request.scene_id }),
    },
  });
  return { outcome: 'dropped', event };
}

/**
 * The engine top-up (Rev 4 §14, MUST run inside storage.transact): while the
 * live count sits below the minimum, drop generated intents — a deterministic
 * pick of a materialized sublocation and (when one is free) an available
 * character; the premise stays a seed, because nothing is calculated until
 * the user arrives at it (the click-time Narrator grounds it in current
 * state — no pre-baked encounter pool sits in the DB).
 */
export function appendTopUpDrops(
  storage: Storage,
  config: MarkerConfig,
  knownCharacters: readonly KnownCharacter[],
  worldId: string,
): WeltariEvent[] {
  const now = worldTimeOf(storage, worldId);
  const events: WeltariEvent[] = [];
  for (let attempt = 0; attempt < config.min * 2; attempt++) {
    const live = storage.markers.live(worldId).length;
    if (live >= config.min) break;
    const anchors = materializedSublocations(storage, worldId);
    if (anchors.length === 0) break; // nowhere to anchor — nothing to force
    const seed = `${worldId}:${now}:${String(live)}:${String(attempt)}`;
    const anchor = anchors[pickIndex(seed, anchors.length)];
    if (anchor === undefined) break;
    const free = knownCharacters.filter(
      (c) => presenceOf(storage, worldId, c.character_id).state === 'available',
    );
    const picked =
      free.length === 0
        ? undefined
        : free[pickIndex(`${seed}:cast`, free.length)];
    const dropped = appendMarkerDrop(storage, config, {
      world_id: worldId,
      actor_id: MARKER_ACTOR_ID,
      sublocation_id: anchor.sublocation_id,
      involved_characters: picked === undefined ? [] : [picked.character_id],
      premise_seed:
        picked === undefined
          ? `Something small but odd is happening at ${anchor.name}.`
          : `${picked.name} is at ${anchor.name}, in the middle of something small but odd.`,
      dropped_at_game_time: now,
      ttl_game_minutes: config.ttlGameMinutes,
      source: 'engine_topup',
    });
    if (dropped.outcome !== 'dropped') break; // structurally can't progress
    events.push(dropped.event);
  }
  return events;
}

/**
 * Plan one CRON marker occurrence (Rev 4 §14 "CRON drops"): PURE planning —
 * the world-cron code handler appends the result atomically with its
 * world_cron.completed, whose (cron_type, scheduled_for) natural key is the
 * occurrence's idempotency. Deterministic per (world, occurrence), stamped
 * with the SCHEDULED fictional time; the ceiling and born-expired
 * suppression apply exactly as at the drop gate (a suppressed or refused
 * occurrence still completes — it simply carries no marker, and the
 * encounter "never happened" by construction). Never plans more than one
 * drop; the advance-time sweep's top-up owns the floor.
 */
export function planCronMarkerDrop(
  storage: Storage,
  config: MarkerConfig,
  knownCharacters: readonly KnownCharacter[],
  worldId: string,
  scheduledFor: string,
): NewEvent[] {
  if (storage.markers.live(worldId).length >= config.max) return [];
  const expiresAt = addMinutesIso(scheduledFor, config.ttlGameMinutes);
  if (expiresAt <= worldTimeOf(storage, worldId)) return []; // born-expired
  const anchors = materializedSublocations(storage, worldId);
  if (anchors.length === 0) return [];
  const seed = `${worldId}:${scheduledFor}`;
  const anchor = anchors[pickIndex(seed, anchors.length)];
  if (anchor === undefined) return [];
  const free = knownCharacters.filter(
    (c) => presenceOf(storage, worldId, c.character_id).state === 'available',
  );
  const picked =
    free.length === 0
      ? undefined
      : free[pickIndex(`${seed}:cast`, free.length)];
  return [
    {
      world_id: worldId,
      actor_id: MARKER_ACTOR_ID,
      type: 'marker.dropped',
      payload: {
        // Deterministic per occurrence — a retry can never mint a twin even
        // before the completed-event gate settles.
        marker_id: `marker:cron:${worldId}:${scheduledFor}`,
        kind: 'map_event',
        sublocation_id: anchor.sublocation_id,
        involved_characters: picked === undefined ? [] : [picked.character_id],
        premise_seed:
          picked === undefined
            ? `Something is stirring at ${anchor.name}.`
            : `${picked.name} is at ${anchor.name}, doing something that might be worth a look.`,
        dropped_at_game_time: scheduledFor,
        ttl_game_minutes: config.ttlGameMinutes,
        expires_at_game_time: expiresAt,
        source: 'cron',
      },
    },
  ];
}

/** Worlds holding any marker history — the boot sweep's list. */
export function markerWorlds(storage: Storage): string[] {
  const worlds = new Set<string>();
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.type === 'marker.dropped') worlds.add(event.world_id);
  }
  return [...worlds];
}

export interface MarkerClickResult {
  outcome: 'instantiated' | 'join';
  marker_id: string;
  scene_id: string;
  sublocation_id: string;
}

export interface MarkerEngine extends SceneEndMarkerFanOut {
  /** Top up to the minimum if below; returns the number of drops. */
  ensureMinimum(worldId: string): Promise<number>;
  /** Expire every due live marker of one world (the lazy sweep — every
   * clock advance + boot), then top up; returns the expiry count. */
  sweepExpired(worldId: string): Promise<number>;
  /** The §1.8 click flow: first click wins, second joins, expired settles. */
  click(command: MarkerClickCommand): Promise<Result<MarkerClickResult>>;
}

export interface MarkerEngineOptions {
  storage: Storage;
  eventBus: EventBus;
  logger: Logger;
  knownCharacters: readonly KnownCharacter[];
  config?: MarkerConfig;
  faultPoint?: FaultPointHook;
}

export function createMarkerEngine(options: MarkerEngineOptions): MarkerEngine {
  const { storage, eventBus, logger, knownCharacters } = options;
  const config = options.config ?? DEFAULT_MARKER_CONFIG;

  async function ensureMinimum(worldId: string): Promise<number> {
    if (storage.markers.live(worldId).length >= config.min) return 0;
    // The harness SIGKILL window: decided, nothing durable — a kill here
    // heals at the next top-up site (boot runs one unconditionally).
    await options.faultPoint?.('mid_marker_topup');
    const persisted = storage.transact(() =>
      appendTopUpDrops(storage, config, knownCharacters, worldId),
    );
    for (const event of persisted) eventBus.publish(event);
    if (persisted.length > 0) {
      logger.info(
        { world_id: worldId, dropped: persisted.length },
        'marker top-up — live count restored to the minimum',
      );
    }
    return persisted.length;
  }

  async function sweepExpired(worldId: string): Promise<number> {
    const now = worldTimeOf(storage, worldId);
    // Zulu ISO strings — lexicographic comparison is exact (the
    // invitation-expiry convention).
    const due = storage.markers
      .live(worldId)
      .filter((m) => m.expires_at_game_time <= now);
    let expired = 0;
    for (const marker of due) {
      // The harness SIGKILL window: BEFORE the commit write — a kill leaves
      // the marker live and due; the boot sweep heals it.
      await options.faultPoint?.('mid_marker_sweep');
      const persisted = storage.transact((): WeltariEvent[] => {
        // Fused re-check (the standing triad): a racing sweep, a click that
        // settled it, or a retry that lost the race commits NOTHING.
        const fresh = storage.markers.byId(marker.marker_id);
        if (fresh?.state !== 'dropped') return [];
        return [
          storage.eventLog.append({
            world_id: worldId,
            actor_id: MARKER_ACTOR_ID,
            type: 'marker.expired',
            payload: {
              marker_id: marker.marker_id,
              game_time: now,
              expired_via: 'sweep',
            },
          }),
        ];
      });
      for (const event of persisted) eventBus.publish(event);
      if (persisted.length > 0) {
        expired += 1;
        logger.info(
          {
            world_id: worldId,
            marker_id: marker.marker_id,
            expires_at_game_time: marker.expires_at_game_time,
            game_time: now,
          },
          'marker expired — the encounter never happened (lazy sweep)',
        );
      }
    }
    // Expiry may have dropped the live set below the minimum.
    if (expired > 0) await ensureMinimum(worldId);
    return expired;
  }

  return {
    ensureMinimum,
    sweepExpired,

    appendSceneEndMarkers(request: SceneEndRequest): WeltariEvent[] {
      const events: WeltariEvent[] = [];
      const followUp = request.follow_up_marker;
      if (followUp !== undefined) {
        const dropped = appendMarkerDrop(storage, config, {
          world_id: request.world_id,
          actor_id: request.actor_id,
          sublocation_id: followUp.sublocation_id,
          involved_characters: followUp.involved_characters ?? [],
          premise_seed: followUp.premise_seed,
          dropped_at_game_time: worldTimeOf(storage, request.world_id),
          ttl_game_minutes: followUp.ttl_game_minutes ?? config.ttlGameMinutes,
          source: 'scene_end',
          scene_id: request.scene_id,
        });
        if (dropped.outcome === 'dropped') {
          events.push(dropped.event);
        } else {
          // I8: a refused drop appends nothing; the trail is this log line.
          logger.info(
            {
              world_id: request.world_id,
              scene_id: request.scene_id,
              refused: dropped.outcome,
            },
            'scene-end follow-up marker refused',
          );
        }
      }
      // A scene that left nothing (or whose follow-up was refused) still
      // leaves the world above the marker minimum (Rev 4 §14).
      events.push(
        ...appendTopUpDrops(storage, config, knownCharacters, request.world_id),
      );
      return events;
    },

    async click(
      command: MarkerClickCommand,
    ): Promise<Result<MarkerClickResult>> {
      const row = storage.markers.byId(command.marker_id);
      if (row?.world_id !== command.world_id) {
        return err(
          new OperationalError(
            'unknown_marker',
            `no marker ${command.marker_id} in this world`,
          ),
        );
      }
      if (row.state === 'instantiated') {
        // The join answer (Rev 4 §14/§17): the scene already runs — route
        // the click INTO it, never into a twin or an error.
        if (row.instantiated_scene_id === undefined) {
          throw new CorruptStateError(
            'marker_scene_missing',
            `instantiated marker ${row.marker_id} has no scene`,
          );
        }
        return ok({
          outcome: 'join',
          marker_id: row.marker_id,
          scene_id: row.instantiated_scene_id,
          sublocation_id: row.sublocation_id,
        });
      }
      if (row.state === 'expired') {
        return err(
          new OperationalError('marker_expired', 'this marker has expired'),
        );
      }
      const now = worldTimeOf(storage, command.world_id);
      if (row.expires_at_game_time <= now) {
        // Click-time re-validation (Rev 4 §14): an expired-but-unswept
        // marker's click is refused AND settles it — no eternal stale pins.
        const persisted = storage.transact((): WeltariEvent[] => {
          const fresh = storage.markers.byId(command.marker_id);
          if (fresh?.state !== 'dropped') return [];
          return [
            storage.eventLog.append({
              world_id: command.world_id,
              actor_id: command.actor_id,
              type: 'marker.expired',
              payload: {
                marker_id: command.marker_id,
                game_time: now,
                expired_via: 'click',
              },
            }),
          ];
        });
        for (const event of persisted) eventBus.publish(event);
        await ensureMinimum(command.world_id);
        return err(
          new OperationalError('marker_expired', 'this marker has expired'),
        );
      }
      // Click-time cast re-validation: characters who wandered into other
      // scenes since the drop are dropped from the roster — the Narrator
      // works with who's here (Rev 4 §14 "adapt").
      const cast = row.involved_characters.filter(
        (id) => presenceOf(storage, command.world_id, id).state === 'available',
      );
      const blocking = sceneOpenBlockers(storage, command.world_id, cast);
      if (blocking > 0) {
        return err(
          new OperationalError(
            'blocked_on_pending_jobs',
            `waiting on ${String(blocking)} job(s) for this world/participants`,
          ),
        );
      }
      // Deterministic per marker: even a fully racing duplicate would
      // collide on scene_already_open by construction.
      const sceneId = `s-marker-${
        row.marker_id.startsWith('marker:')
          ? row.marker_id.slice('marker:'.length)
          : row.marker_id
      }`;
      const openAt = materializedSublocations(storage, command.world_id).find(
        (s) => s.sublocation_id === row.sublocation_id,
      );
      if (openAt === undefined) {
        // The drop gate anchored it to a materialized sublocation and the
        // registry is a fold of an append-only log — it cannot vanish.
        throw new CorruptStateError(
          'marker_sublocation_missing',
          `marker ${row.marker_id} anchors to unknown ${row.sublocation_id}`,
        );
      }
      // The harness SIGKILL window: everything decided, nothing durable.
      await options.faultPoint?.('mid_marker_click');
      const settled = storage.transact(
        ():
          | { kind: 'instantiated'; events: WeltariEvent[] }
          | { kind: 'join'; scene_id: string }
          | { kind: 'expired' } => {
          // Fused re-check, NO awaits before the append (the version race):
          // the first click to reach here wins; the loser sees the flip.
          const fresh = storage.markers.byId(command.marker_id);
          if (fresh === undefined) {
            throw new CorruptStateError(
              'marker_row_vanished',
              `marker ${command.marker_id} disappeared mid-click`,
            );
          }
          if (fresh.state === 'instantiated') {
            if (fresh.instantiated_scene_id === undefined) {
              throw new CorruptStateError(
                'marker_scene_missing',
                `instantiated marker ${fresh.marker_id} has no scene`,
              );
            }
            return { kind: 'join', scene_id: fresh.instantiated_scene_id };
          }
          if (fresh.state === 'expired') return { kind: 'expired' };
          const events: WeltariEvent[] = [
            storage.eventLog.append({
              world_id: command.world_id,
              actor_id: command.actor_id,
              type: 'marker.instantiated',
              payload: {
                marker_id: command.marker_id,
                scene_id: sceneId,
                game_time: now,
              },
            }),
          ];
          events.push(
            ...appendSceneOpen(
              storage,
              knownCharacters,
              {
                world_id: command.world_id,
                actor_id: command.actor_id,
                scene_id: sceneId,
                title: `Encounter: ${openAt.name}`,
                participants: cast,
                sublocation_id: row.sublocation_id,
                premise: row.premise_seed,
              },
              openAt,
            ),
          );
          return { kind: 'instantiated', events };
        },
      );
      if (settled.kind === 'expired') {
        return err(
          new OperationalError('marker_expired', 'this marker has expired'),
        );
      }
      if (settled.kind === 'join') {
        return ok({
          outcome: 'join',
          marker_id: command.marker_id,
          scene_id: settled.scene_id,
          sublocation_id: row.sublocation_id,
        });
      }
      for (const event of settled.events) eventBus.publish(event);
      logger.info(
        {
          world_id: command.world_id,
          marker_id: command.marker_id,
          scene_id: sceneId,
          participants: cast,
        },
        'marker instantiated — first click won, scene open',
      );
      // Instantiation consumed a live marker; keep the map above the minimum.
      await ensureMinimum(command.world_id);
      return ok({
        outcome: 'instantiated',
        marker_id: command.marker_id,
        scene_id: sceneId,
        sublocation_id: row.sublocation_id,
      });
    },
  };
}
