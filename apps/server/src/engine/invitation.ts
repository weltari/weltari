// Invitation expiry (M6 part 4, Rev 4 §7, owner rulings 2026-07-10/11): a
// character-fired startscene the user never enters expires against the WORLD
// clock — never wall time. While the user is away the clock is paused, so the
// character has fictionally waited no time at all; only the user's own play
// (a skip, a scene-end acceleration) can move the clock past the deadline.
// The check is therefore LAZY and complete: it runs after every clock
// advance and at boot (recovery path = startup path) — no timer exists.
//
// On expiry ONE transaction appends scene.expired (closes the scene for every
// projection — presence releases exactly like scene.ended) + the HARDCODED
// cache.appended absence entry (never an extra LLM call), so the character
// complains in character on its next trigger. Natural key: scene_id — the
// fused re-check inside the transaction makes a kill-retry or a racing
// second sweep commit nothing (the standing triad pattern).
import type { WeltariEvent } from '@weltari/protocol';
import type { EventBus } from '../http/bus.js';
import type { Logger } from '../observability/logger.js';
import type { Storage } from '../storage/db.js';
import { capCacheLine } from './cache.js';
import type { FaultPointHook } from './fault-points.js';
import { worldTimeOf } from './world-clock.js';

export interface PendingInvitation {
  scene_id: string;
  character_id: string;
  place: string;
  wait_hours: number;
  expires_at_game: string;
}

/**
 * Open, never-entered invitation scenes of one world — a pure fold. "Never
 * entered" = no turn.committed (the first turn only fires when the user acts
 * in the scene, so visiting the meeting counts as showing up).
 */
export function pendingInvitations(
  storage: Storage,
  worldId: string,
): PendingInvitation[] {
  const started = new Map<string, PendingInvitation>();
  const entered = new Set<string>();
  const closed = new Set<string>();
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.world_id !== worldId) continue;
    if (
      event.type === 'scene.started' &&
      event.payload.invitation !== undefined
    ) {
      started.set(event.payload.scene_id, {
        scene_id: event.payload.scene_id,
        ...event.payload.invitation,
      });
    } else if (event.type === 'turn.committed') {
      entered.add(event.payload.scene_id);
    } else if (event.type === 'scene.ended' || event.type === 'scene.expired') {
      closed.add(event.payload.scene_id);
    }
  }
  return [...started.values()].filter(
    (p) => !entered.has(p.scene_id) && !closed.has(p.scene_id),
  );
}

/** Worlds holding at least one pending invitation — the boot sweep's list. */
export function pendingInvitationWorlds(storage: Storage): string[] {
  const worlds = new Set<string>();
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (
      event.type === 'scene.started' &&
      event.payload.invitation !== undefined
    ) {
      worlds.add(event.world_id);
    }
  }
  return [...worlds].filter(
    (worldId) => pendingInvitations(storage, worldId).length > 0,
  );
}

export interface InvitationExpiryOptions {
  storage: Storage;
  eventBus: EventBus;
  logger: Logger;
  faultPoint?: FaultPointHook;
}

export interface InvitationExpiry {
  /** Expire every due pending invitation of one world; returns the count. */
  expireDue(worldId: string): Promise<number>;
}

export function createInvitationExpiry(
  options: InvitationExpiryOptions,
): InvitationExpiry {
  const { storage, eventBus, logger } = options;

  return {
    async expireDue(worldId: string): Promise<number> {
      const now = worldTimeOf(storage, worldId);
      // Zulu ISO strings from the scheduler's calendar math — lexicographic
      // comparison is exact (same convention as the chat idle horizon).
      const due = pendingInvitations(storage, worldId).filter(
        (p) => p.expires_at_game <= now,
      );
      let expired = 0;
      for (const invitation of due) {
        // The harness SIGKILL window: BEFORE the commit write — a kill here
        // leaves the clock advanced and the invitation pending; the boot
        // sweep heals it (crash-only, nothing half-written).
        await options.faultPoint?.('mid_invitation_expiry');
        // The hardcoded absence entry (owner ruling 2026-07-10: never an
        // extra LLM call). capCacheLine only bounds length — the template is
        // never empty, so the fallback keeps the type narrow, not behavior.
        const line =
          capCacheLine(
            `I waited at ${invitation.place}, but the User never came. After ${String(invitation.wait_hours)} hours I gave up and left (day ${now.slice(0, 10)}).`,
          ) ?? 'The User never came to our meeting.';
        const persisted = storage.transact((): WeltariEvent[] => {
          // Fused re-check (the standing triad pattern): a racing sweep or a
          // retry that lost the race commits NOTHING — one expiry per scene.
          const already = storage.eventLog
            .readSince(0, 100000)
            .some(
              (e) =>
                e.type === 'scene.expired' &&
                e.payload.scene_id === invitation.scene_id,
            );
          if (already) return [];
          return [
            storage.eventLog.append({
              world_id: worldId,
              actor_id: invitation.character_id,
              type: 'scene.expired',
              payload: {
                scene_id: invitation.scene_id,
                character_id: invitation.character_id,
                place: invitation.place,
                expires_at_game: invitation.expires_at_game,
                game_time: now,
              },
            }),
            storage.eventLog.append({
              world_id: worldId,
              actor_id: invitation.character_id,
              type: 'cache.appended',
              payload: {
                character_id: invitation.character_id,
                origin: 'scene',
                context_id: invitation.scene_id,
                line,
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
              scene_id: invitation.scene_id,
              character_id: invitation.character_id,
              expires_at_game: invitation.expires_at_game,
              game_time: now,
            },
            'invitation expired — presence released, absence entry written',
          );
        }
      }
      return expired;
    },
  };
}
